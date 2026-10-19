/**
 * dsh-notify — bring the DSH desktop window to the front.
 *
 * A Web renderer cannot activate its own OS window: `window.focus()` only
 * affects web contents. The desktop shell registers the `dsh` URL scheme and
 * its `open-url` / single-instance handlers call `focusPrimaryWindow()`
 * (restore + show + focus).
 *
 * macOS: LaunchServices activates the app for `dsh://open`.
 *
 * Windows: starting the protocol asks the shell to route the URL, but Windows
 * foreground-lock rules can still leave the restored window behind. The focus
 * command therefore also restores the main window and calls
 * `SetForegroundWindow`, with a harmless Alt nudge because Windows only honours
 * a foreground change from a process that is allowed to take it.
 *
 * Commands are fixed argv entries — no user input reaches a shell. The Windows
 * script is passed as a Base64-encoded `-EncodedCommand`.
 */

import { spawn } from 'node:child_process';

const FOCUS_URL = 'dsh://open';

/** PowerShell program that opens the deep link, then raises the DSH window. */
const WINDOWS_FOCUS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Start-Process 'dsh://open'
Start-Sleep -Milliseconds 350
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DshNotifyFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$process = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like '*DeepSeek*' -or $_.ProcessName -like '*dsh*') } | Select-Object -First 1
if ($null -eq $process) { exit 0 }
$handle = $process.MainWindowHandle
[void][DshNotifyFocus]::ShowWindow($handle, 9)
[void][DshNotifyFocus]::SetForegroundWindow($handle)
# A short synthetic Alt press makes Windows accept the foreground request even
# when the caller is not the process that received the last input event.
[void][DshNotifyFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void][DshNotifyFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][DshNotifyFocus]::SetForegroundWindow($handle)
`;

function windowsFocusCommand() {
  const encoded = Buffer.from(WINDOWS_FOCUS_SCRIPT, 'utf16le').toString('base64');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
  };
}

/**
 * Build the platform command that raises the DSH window.
 * @param {NodeJS.Platform} platform current platform
 * @returns {{ command: string, args: string[] } | null}
 */
export function buildFocusCommand(platform = process.platform) {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [FOCUS_URL] };
  if (platform === 'win32') return windowsFocusCommand();
  // Linux desktop builds may not register the scheme; keep it best-effort.
  if (platform === 'linux') return { command: 'xdg-open', args: [FOCUS_URL] };
  return null;
}

/**
 * Ask the OS to open the DSH focus deep link and, on Windows, raise the window.
 * Fire-and-forget: the window activation happens in the desktop shell's main
 * process, not here.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] injectable platform for tests
 * @param {typeof spawn} [options.spawnFn] injectable spawn for tests
 * @returns {boolean} whether a focus command was started
 */
export function focusDshWindow({ platform = process.platform, spawnFn = spawn } = {}) {
  const spec = buildFocusCommand(platform);
  if (!spec) return false;
  try {
    const child = spawnFn(spec.command, spec.args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child?.on?.('error', () => {});
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}
