/**
 * dsh-notify — read-only helpers over a live DSH Session value.
 *
 * Everything here tolerates a partially shaped object so the plugin cannot
 * break a Host event dispatch when a session implementation evolves. The plugin
 * deliberately never rescans a session log: the durable event feed already
 * carries turn starts, assistant messages and turn ends.
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
 * Best available title: the Host's log-backed title service, then the
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

/**
 * Effective working directory for a live session: the `workingDirectory`
 * service tracks in-session directory changes, while the header holds the
 * original directory recorded at creation.
 * @param {{ get?: (name: string) => unknown } | undefined} ctx plugin context
 * @param {{ header?: { cwd?: unknown } } | undefined} session live session
 */
export function resolveWorkingDirectory(ctx, session) {
  try {
    const service = /** @type {{ get?: (session: unknown) => unknown } | undefined} */ (
      ctx?.get?.('workingDirectory')
    );
    const current = service?.get?.(session);
    if (typeof current === 'string' && current.trim() !== '') return current.trim();
  } catch {
    // Optional service missing: fall back to the header.
  }
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' ? cwd : '';
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
 * Extract the text of one live `assistant/message` event. Only text blocks are
 * used; reasoning, tool calls and images are ignored.
 * @param {{ type?: string, data?: { message?: { content?: unknown } } }} event session event
 * @param {number} maximum maximum preview length
 * @returns {string} single-line preview, or an empty string
 */
export function assistantTextFromEvent(event, maximum = 160) {
  if (event?.type !== 'assistant/message') return '';
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text ? truncateInline(text, maximum) : '';
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
