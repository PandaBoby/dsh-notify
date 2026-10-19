/**
 * dsh-notify — bring the DSH desktop window to the front.
 *
 * A Web renderer cannot activate its own OS window: `window.focus()` only
 * affects web contents. The desktop shell already registers the `dsh` URL
 * scheme and its `open-url` / single-instance handlers call
 * `focusPrimaryWindow()` (restore + show + focus). Opening `dsh://open` from
 * the Host process therefore raises the real application window from any
 * background state.
 *
 * Commands are fixed argv entries — no user input reaches a shell.
 */

import { spawn } from 'node:child_process';

const FOCUS_URL = 'dsh://open';

/**
 * Build the platform command that opens the focus deep link.
 * @param {NodeJS.Platform} platform current platform
 * @returns {{ command: string, args: string[] } | null}
 */
export function buildFocusCommand(platform = process.platform) {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [FOCUS_URL] };
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/c', 'start', '', FOCUS_URL] };
  // Linux desktop builds may not register the scheme; keep it best-effort.
  if (platform === 'linux') return { command: 'xdg-open', args: [FOCUS_URL] };
  return null;
}

/**
 * Ask the OS to open the DSH focus deep link. Fire-and-forget: the window
 * activation happens in the desktop shell's main process, not here.
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
