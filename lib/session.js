/**
 * dsh-notify — read-only helpers over a live DSH Session value.
 *
 * Everything here tolerates a partially shaped object so the plugin cannot
 * break a Host event dispatch when a session implementation evolves.
 */

import { basename } from 'node:path';

/**
 * Whether a Session belongs to the human (a root conversation) rather than to a
 * delegated child (subagent, teammate, workflow member).
 * @param {{ header?: Record<string, unknown>, id?: unknown } | undefined} session live session
 */
export function isUserSession(session) {
  const header = session?.header;
  if (!header || typeof header !== 'object') return true;
  if (header.origin === 'subagent') return false;
  if (header.parentSession !== undefined && header.parentSession !== null) return false;
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false;
  return true;
}

/**
 * Best available title: the Host's log-backed title service, then the session
 * working-directory folder, then a short session id.
 * @param {{ get?: (name: string) => unknown } | undefined} ctx plugin context
 * @param {{ header?: { cwd?: unknown }, id?: unknown } | undefined} session live session
 */
export function resolveSessionTitle(ctx, session) {
  try {
    const titleService = /** @type {{ get?: (session: unknown) => { title?: unknown } | undefined } | undefined} */ (
      ctx?.get?.('sessionTitle')
    );
    const snapshot = titleService?.get?.(session);
    const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : '';
    if (title) return title;
  } catch {
    // Optional service missing or not ready: fall back to the working directory.
  }
  return fallbackSessionTitle(session);
}

/** Folder-based fallback title for a session. */
export function fallbackSessionTitle(session) {
  const cwd = session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const folder = basename(cwd.trim());
    if (folder && folder !== '/' && folder !== '.') return folder;
  }
  const id = typeof session?.id === 'string' ? session.id : String(session?.id ?? '');
  return id ? `Session ${id.slice(0, 8)}` : 'Session';
}

/**
 * Find the wall-clock start time of one turn from the session log. Used as a
 * fallback when the plugin was installed or reloaded in the middle of a turn.
 * @param {unknown} session live session
 * @param {number | undefined} turn turn number
 * @returns {number | undefined} epoch milliseconds
 */
export function findTurnStartTime(session, turn) {
  if (typeof turn !== 'number') return undefined;
  let events;
  try {
    events = /** @type {{ snapshotEvents?: () => readonly unknown[] } | undefined} */ (session)?.snapshotEvents?.();
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn/start' && event?.data?.turn === turn && Number.isFinite(event?.time)) {
      return event.time;
    }
  }
  return undefined;
}

/**
 * Extract a short preview of the last assistant text produced in one turn.
 * @param {unknown} session live session
 * @param {number | undefined} turn turn number
 * @param {number} maximum maximum preview length
 * @returns {string} single-line preview, or an empty string
 */
export function extractReplyPreview(session, turn, maximum = 160) {
  if (typeof turn !== 'number') return '';
  let events;
  try {
    events = /** @type {{ snapshotEvents?: () => readonly unknown[] } | undefined} */ (session)?.snapshotEvents?.();
  } catch {
    return '';
  }
  if (!Array.isArray(events)) return '';
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'turn/start' && event.data?.turn === turn) break;
    if (event.type !== 'assistant/message' || event.data?.turn !== turn) continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) return truncateInline(text, maximum);
  }
  return '';
}

/** Collapse whitespace and truncate one inline preview line. */
export function truncateInline(text, maximum) {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!single) return '';
  return single.length > maximum ? `${single.slice(0, Math.max(0, maximum - 1)).trimEnd()}\u2026` : single;
}

/** Last path segment of a working directory, or an empty string. */
export function workspaceName(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return '';
  const folder = basename(cwd.trim());
  return folder === '/' || folder === '.' ? '' : folder;
}
