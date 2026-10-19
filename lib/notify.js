/**
 * dsh-notify — native notification delivery.
 *
 * Delivery never goes through a shell: values are passed as argv entries, so a
 * session title containing quotes, backticks or `$(...)` stays literal text.
 * Supported channels:
 *  - `osascript`  macOS Notification Center (Standard Additions `display notification`)
 *  - `notify-send` freedesktop notification daemons on Linux
 * Windows has no built-in dependency-free toast channel, so it resolves to `none`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const MACOS_SOUNDS_DIRECTORY = '/System/Library/Sounds';

/** AppleScript program receiving title, body and sound as `argv` entries. */
const APPLESCRIPT = [
  'on run argv',
  'set theTitle to item 1 of argv',
  'set theBody to item 2 of argv',
  'set theSound to item 3 of argv',
  'if theSound is "" then',
  'display notification theBody with title theTitle',
  'else',
  'display notification theBody with title theTitle sound name theSound',
  'end if',
  'end run',
].join('\n');

/**
 * Resolve the effective delivery channel for the current platform.
 * @param {import('./config.js').DEFAULT_CONFIG} config normalized config
 * @param {{ platform?: NodeJS.Platform }} [options] injectable platform for tests
 * @returns {'osascript' | 'notify-send' | 'none'} channel id
 */
export function resolveChannel(config, { platform = process.platform } = {}) {
  if (!config || config.channel === 'none') return 'none';
  if (config.channel === 'osascript') return platform === 'darwin' ? 'osascript' : 'none';
  if (config.channel === 'notify-send') return platform === 'linux' ? 'notify-send' : 'none';
  if (platform === 'darwin') return 'osascript';
  if (platform === 'linux') return 'notify-send';
  return 'none';
}

/**
 * Validate a macOS sound name against the installed system sounds directory.
 * @param {import('./config.js').DEFAULT_CONFIG} config normalized config
 * @param {{ exists?: (path: string) => boolean }} [options] injectable filesystem probe
 * @returns {string} usable sound name, or an empty string
 */
export function resolveSound(config, { exists = existsSync } = {}) {
  const sound = typeof config?.sound === 'string' ? config.sound.trim() : '';
  if (!sound) return '';
  try {
    if (!exists(`${MACOS_SOUNDS_DIRECTORY}/${sound}.aiff`)) return '';
  } catch {
    return '';
  }
  return sound;
}

/**
 * Build the argv-based notification command for one channel.
 * @param {'osascript' | 'notify-send' | 'none'} channel channel id
 * @param {{ title: string, body: string, sound?: string }} message notification content
 * @returns {{ command: string, args: string[] } | null}
 */
export function buildNotificationCommand(channel, { title, body, sound = '' }) {
  if (channel === 'osascript') {
    return {
      command: '/usr/bin/osascript',
      args: ['-e', APPLESCRIPT, '--', String(title), String(body), String(sound)],
    };
  }
  if (channel === 'notify-send') {
    return {
      command: 'notify-send',
      args: [
        '--app-name=DeepSeek Harness',
        '--urgency=normal',
        '--expire-time=8000',
        '--icon=dialog-information',
        '--',
        String(title),
        String(body),
      ],
    };
  }
  return null;
}

/**
 * Run one notification command and settle with its outcome. Never rejects.
 * @param {{ command: string, args: string[] } | null} spec command spec
 * @param {{ timeoutMs?: number }} [options] execution options
 * @returns {Promise<{ ok: boolean, code?: number | null, signal?: string | null, error?: string }>}
 */
export function runNotification(spec, { timeoutMs = 5_000 } = {}) {
  if (!spec) return Promise.resolve({ ok: false, error: 'no notification command available' });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }

    let settled = false;
    const timer = setTimeout(
      () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already gone.
        }
        finish({ ok: false, error: 'notification command timed out' });
      },
      Math.max(500, timeoutMs),
    );
    if (typeof timer.unref === 'function') timer.unref();

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    child.once('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }));
    child.once('close', (code, signal) =>
      finish(
        code === 0
          ? { ok: true, code, signal: signal ?? null }
          : { ok: false, code, signal: signal ?? null, error: `exited with ${code === null ? signal : code}` },
      ),
    );
  });
}
