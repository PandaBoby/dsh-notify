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
 * Windows: opening the protocol is not enough — the calling process is a
 * background child of the Host, so Windows foreground-lock rules can leave the
 * restored window behind the current app. The PowerShell helper restores the
 * window, raises it once with `SetWindowPos(HWND_TOPMOST)` (so it becomes
 * visible even when focus is denied), uses `SwitchToThisWindow` and
 * `SetForegroundWindow`, and reports a non-zero exit with diagnostics when the
 * window cannot be found or raised.
 *
 * Commands are fixed argv entries — no user input reaches a shell. The Windows
 * script is passed as a Base64 `-EncodedCommand`.
 */

import { spawn } from 'node:child_process';

const FOCUS_URL = 'dsh://open';

/** PowerShell program that opens the deep link, restores and raises the DSH window. */
const WINDOWS_FOCUS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Start-Process 'dsh://open'
Start-Sleep -Milliseconds 400
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DshNotifyFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$process = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like '*DeepSeek*' -or $_.ProcessName -like '*dsh*') } | Select-Object -First 1
if ($null -eq $process) {
  Write-Error 'dsh-notify: DeepSeek Harness main window not found'
  exit 3
}
$handle = $process.MainWindowHandle
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_SHOWWINDOW = 0x0040
[void][DshNotifyFocus]::ShowWindow($handle, 9)
# Raise once as topmost so the window is visible even if focus is denied, then
# drop the topmost flag so it behaves like a normal window again.
[void][DshNotifyFocus]::SetWindowPos($handle, [IntPtr]::new(-1), 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW))
[void][DshNotifyFocus]::SetWindowPos($handle, [IntPtr]::new(-2), 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW))
# A short synthetic Alt press makes Windows accept the foreground request even
# when the caller did not receive the last input event.
[void][DshNotifyFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void][DshNotifyFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][DshNotifyFocus]::SwitchToThisWindow($handle, $true)
[void][DshNotifyFocus]::SetForegroundWindow($handle)
exit 0
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

function collect(child, key, value, limit = 2_000) {
  child[key] = `${child[key] ?? ''}${String(value)}`.slice(-limit);
}

/**
 * Run the focus command and wait briefly for its outcome, so the click audit
 * records whether the activation helper actually succeeded.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] injectable platform for tests
 * @param {typeof spawn} [options.spawnFn] injectable spawn for tests
 * @param {number} [options.timeoutMs] hard deadline
 * @returns {Promise<{ ok: boolean, command: string, code?: number | null, error?: string }>}
 */
export function runFocusCommand({ platform = process.platform, spawnFn = spawn, timeoutMs = 4_000 } = {}) {
  const spec = buildFocusCommand(platform);
  if (!spec) return Promise.resolve({ ok: false, command: 'none', error: 'unsupported platform' });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(spec.command, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, command: spec.command, error: String(error?.message ?? error) });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill?.('SIGKILL');
      } catch {
        // Already gone.
      }
      finish({ ok: false, command: spec.command, error: 'focus command timed out' });
    }, Math.max(500, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();

    collect(child.stdout, 'text', ''); // initialize
    child.stdout?.on?.('data', (chunk) => collect(child.stdout, 'text', chunk));
    child.stderr?.on?.('data', (chunk) => collect(child.stderr, 'text', chunk));
    child.once?.('error', (error) =>
      finish({ ok: false, command: spec.command, error: String(error?.message ?? error) }),
    );
    child.once?.('close', (code) => {
      const stderr = String(child.stderr?.text ?? '').trim();
      const stdout = String(child.stdout?.text ?? '').trim();
      finish({
        ok: code === 0,
        command: spec.command,
        code,
        error: code === 0 ? undefined : stderr || stdout || `focus command exited with ${String(code)}`,
      });
    });
  });
}
