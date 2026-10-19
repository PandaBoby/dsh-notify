/**
 * dsh-notify — pure decision layer: which turn-end events deserve a notification
 * and what text should that notification carry.
 *
 * `decideNotification` performs no I/O and never rescans a session log; the
 * runtime feeds it bounded state collected from the live event feed. This keeps
 * the behavior testable and makes the runtime wiring in `runtime.js` a thin
 * adapter.
 */

import {
  DEFAULT_CONFIG,
  formatDuration,
  renderTemplate,
  sanitizeText,
  statusEmoji,
  statusLabel,
} from './config.js';
import { assistantTextFromEvent, fallbackSessionTitle, isUserSession, workspaceName } from './session.js';

const MAX_TRACKED_SESSIONS = 512;

/** Mutable per-plugin-instance state. */
export function createState() {
  return {
    /** @type {Map<string, { turn: number, time: number }>} */
    turnStarts: new Map(),
    /** @type {Map<string, { turn: number | undefined, text: string }>} */
    lastReplies: new Map(),
    /** @type {number[]} delivery timestamps for the sliding-window rate limit */
    recentDeliveries: [],
  };
}

function trimToLimit(map) {
  while (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Remember when the current turn started so the completion notification can
 * report a duration.
 * @param {ReturnType<typeof createState>} state runtime state
 * @param {{ id?: unknown } | undefined} session live session
 * @param {{ data?: { turn?: unknown }, time?: unknown }} event `turn/start` event
 * @param {number} now fallback clock
 */
export function rememberTurnStart(state, session, event, now = Date.now()) {
  const sessionId = session?.id;
  const turn = event?.data?.turn;
  if (typeof sessionId !== 'string' || typeof turn !== 'number') return;
  state.turnStarts.delete(sessionId);
  state.turnStarts.set(sessionId, {
    turn,
    time: Number.isFinite(event?.time) ? Number(event.time) : now,
  });
  trimToLimit(state.turnStarts);
}

/**
 * Remember the latest assistant text observed in the live feed, for `{reply}`.
 * @param {ReturnType<typeof createState>} state runtime state
 * @param {{ id?: unknown } | undefined} session live session
 * @param {{ type?: string, data?: { turn?: unknown } }} event session event
 */
export function rememberAssistantText(state, session, event) {
  const sessionId = session?.id;
  const text = assistantTextFromEvent(event);
  if (typeof sessionId !== 'string' || !text) return;
  const turn = typeof event?.data?.turn === 'number' ? event.data.turn : undefined;
  state.lastReplies.delete(sessionId);
  state.lastReplies.set(sessionId, { turn, text });
  trimToLimit(state.lastReplies);
}

/**
 * Consume the stored reply preview for a finished turn.
 * @param {ReturnType<typeof createState>} state runtime state
 * @param {{ id?: unknown } | undefined} session live session
 * @param {number | undefined} turn turn that just ended
 */
export function takeReply(state, session, turn) {
  const sessionId = session?.id;
  if (typeof sessionId !== 'string') return '';
  const entry = state.lastReplies.get(sessionId);
  if (!entry) return '';
  // A preview from another turn stays queued for that turn's own end.
  if (typeof turn === 'number' && typeof entry.turn === 'number' && entry.turn !== turn) return '';
  state.lastReplies.delete(sessionId);
  return entry.text;
}

/** Drop per-session bookkeeping when a session is disposed. */
export function forgetSession(state, session) {
  if (typeof session?.id !== 'string') return;
  state.turnStarts.delete(session.id);
  state.lastReplies.delete(session.id);
}

/**
 * Normalize a durable `TurnEndReason` (object or string) to a reason kind.
 * A missing or malformed reason yields an empty kind, which suppresses the
 * notification instead of fabricating a successful outcome.
 * @param {{ data?: { reason?: unknown } }} event `turn/end` event
 */
export function normalizeReason(event) {
  const reason = event?.data?.reason;
  const kind = typeof reason === 'string' ? reason : reason?.kind;
  if (typeof kind !== 'string' || kind === '') return { kind: '', reason: undefined };
  return { kind, reason };
}

function defaultResolveTitle(session) {
  return fallbackSessionTitle(session);
}

/**
 * Decide whether one `turn/end` event should notify, and render its messages.
 *
 * @param {object} input decision input
 * @param {unknown} input.session live DSH session
 * @param {{ type?: string, time?: number, data?: { turn?: number, reason?: unknown } }} input.event
 * @param {typeof DEFAULT_CONFIG} input.config normalized plugin config
 * @param {ReturnType<typeof createState>} input.state runtime state
 * @param {'en' | 'zh'} [input.locale] message locale
 * @param {(session: unknown) => string} [input.resolveTitle] session title resolver
 * @param {string} [input.cwd] effective working directory
 * @param {string} [input.reply] assistant preview observed for this turn
 * @returns {null | {
 *   notify: true, reason: string, title: string, body: string,
 *   meta: { sessionId: string, sessionTitle: string, cwd: string, turn?: number, durationMs?: number }
 * }}
 */
export function decideNotification({
  session,
  event,
  config,
  state,
  locale = 'en',
  resolveTitle = defaultResolveTitle,
  cwd,
  reply = '',
}) {
  if (!event || event.type !== 'turn/end') return null;
  if (!session || typeof session.id !== 'string') return null;
  if (!config.includeSubagents && !isUserSession(session)) return null;

  const { kind } = normalizeReason(event);
  if (!kind) return null;
  if (!config.notifyOn.includes(kind)) return null;

  const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined;
  const tracked = state.turnStarts.get(session.id);
  const startTime = tracked && (turn === undefined || tracked.turn === turn) ? tracked.time : undefined;
  const durationMs =
    Number.isFinite(startTime) && Number.isFinite(event.time) ? Math.max(0, event.time - startTime) : undefined;
  state.turnStarts.delete(session.id);

  if (config.minDurationMs > 0 && (durationMs === undefined || durationMs < config.minDurationMs)) return null;

  let sessionTitle;
  try {
    sessionTitle = sanitizeText(resolveTitle(session), 120);
  } catch {
    sessionTitle = '';
  }
  if (!sessionTitle) sessionTitle = sanitizeText(fallbackSessionTitle(session), 120);

  const effectiveCwd = typeof cwd === 'string' ? cwd : typeof session.header?.cwd === 'string' ? session.header.cwd : '';
  const errorMessage =
    kind === 'error' && typeof event.data?.reason?.error?.message === 'string'
      ? sanitizeText(event.data.reason.error.message, 160)
      : '';

  const variables = {
    session: sessionTitle,
    title: sessionTitle,
    workspace: workspaceName(effectiveCwd),
    cwd: effectiveCwd,
    status: statusLabel(kind, locale),
    emoji: statusEmoji(kind),
    duration: durationMs === undefined ? '' : formatDuration(durationMs, locale),
    turn: turn === undefined ? '' : String(turn),
    sessionId: session.id,
    reply: sanitizeText(reply, 160),
    error: errorMessage,
  };

  const title = sanitizeText(renderTemplate(config.titleTemplate, variables), 120) || 'DeepSeek Harness';
  let body = sanitizeText(renderTemplate(config.bodyTemplate, variables), 400);
  if (!body) body = `${variables.emoji} ${sessionTitle} · ${variables.status}`.trim();

  return {
    notify: true,
    reason: kind,
    title,
    body,
    meta: {
      sessionId: session.id,
      sessionTitle,
      cwd: effectiveCwd,
      turn,
      durationMs,
    },
  };
}
