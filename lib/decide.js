/**
 * dsh-notify — pure decision layer: which turn-end events deserve a notification
 * and what text should that notification carry.
 *
 * `decideNotification` performs no I/O, which keeps the behavior testable and
 * makes the runtime wiring in `runtime.js` a thin adapter.
 */

import {
  DEFAULT_CONFIG,
  formatDuration,
  renderTemplate,
  sanitizeText,
  statusEmoji,
  statusLabel,
} from './config.js';
import {
  extractReplyPreview,
  fallbackSessionTitle,
  findTurnStartTime,
  isUserSession,
  workspaceName,
} from './session.js';

const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_SESSIONS = 512;

/** Mutable per-plugin-instance state. */
export function createState() {
  return {
    /** @type {Map<string, { turn: number, time: number }>} */
    turnStarts: new Map(),
    /** @type {number[]} */
    recentDeliveries: [],
  };
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
  while (state.turnStarts.size > MAX_TRACKED_SESSIONS) {
    const oldest = state.turnStarts.keys().next().value;
    if (oldest === undefined) break;
    state.turnStarts.delete(oldest);
  }
}

/** Drop per-session bookkeeping when a session is disposed. */
export function forgetSession(state, session) {
  if (typeof session?.id === 'string') state.turnStarts.delete(session.id);
}

/**
 * Normalize a durable `TurnEndReason` (object or string) to a reason kind.
 * @param {{ data?: { reason?: unknown } }} event `turn/end` event
 */
export function normalizeReason(event) {
  const reason = event?.data?.reason;
  const kind = typeof reason === 'string' ? reason : reason?.kind;
  if (typeof kind !== 'string' || kind === '') return { kind: 'completed', reason: undefined };
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
 * @param {number} [input.now] current epoch milliseconds
 * @param {(session: unknown) => string} [input.resolveTitle] session title resolver
 * @returns {null | { suppressed: 'rate-limit' } | {
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
  now = Date.now(),
  resolveTitle = defaultResolveTitle,
}) {
  if (!event || event.type !== 'turn/end') return null;
  if (!session || typeof session.id !== 'string') return null;
  if (!config.includeSubagents && !isUserSession(session)) return null;

  const { kind, reason } = normalizeReason(event);
  if (!config.notifyOn.includes(kind)) return null;

  const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined;
  const tracked = state.turnStarts.get(session.id);
  let startTime = tracked && (turn === undefined || tracked.turn === turn) ? tracked.time : undefined;
  if (startTime === undefined && turn !== undefined) startTime = findTurnStartTime(session, turn);
  const durationMs =
    Number.isFinite(startTime) && Number.isFinite(event.time) ? Math.max(0, event.time - startTime) : undefined;
  state.turnStarts.delete(session.id);

  if (config.minDurationMs > 0 && (durationMs === undefined || durationMs < config.minDurationMs)) return null;

  if (config.maxPerMinute > 0) {
    const windowStart = now - RATE_WINDOW_MS;
    state.recentDeliveries = state.recentDeliveries.filter((deliveredAt) => deliveredAt > windowStart);
    if (state.recentDeliveries.length >= config.maxPerMinute) {
      return { suppressed: 'rate-limit' };
    }
    state.recentDeliveries.push(now);
  }

  let sessionTitle;
  try {
    sessionTitle = sanitizeText(resolveTitle(session), 120);
  } catch {
    sessionTitle = '';
  }
  if (!sessionTitle) sessionTitle = sanitizeText(fallbackSessionTitle(session), 120);

  const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : '';
  const reply = config.bodyTemplate.includes('{reply}') ? extractReplyPreview(session, turn) : '';
  const errorMessage =
    kind === 'error' && typeof reason?.error?.message === 'string'
      ? sanitizeText(reason.error.message, 160)
      : '';

  const variables = {
    session: sessionTitle,
    title: sessionTitle,
    workspace: workspaceName(cwd),
    cwd,
    status: statusLabel(kind, locale),
    emoji: statusEmoji(kind),
    duration: durationMs === undefined ? '' : formatDuration(durationMs, locale),
    turn: turn === undefined ? '' : String(turn),
    sessionId: session.id,
    reply,
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
      cwd,
      turn,
      durationMs,
    },
  };
}
