/**
 * dsh-notify — runtime adapter between DSH Host events and notification delivery.
 *
 * Delivery has two lanes:
 *  - **Client lane**: when a Web client is connected, the Host stores the
 *    rendered decision and lets the client show a clickable Notification (the
 *    client can focus the app and open the finished session). If the client
 *    does not acknowledge within `clientFallbackMs`, the Host falls back to the
 *    OS notification channel so completion is never silent.
 *  - **Host lane**: no connected client (or the client reported it cannot show
 *    a notification) uses macOS `osascript` / Linux `notify-send`.
 *
 * `createRuntime` is separated from `apply()` so tests can inject a fake
 * sender, fake audit sink, fake clock and fake timers.
 */

import { createRequire } from 'node:module';

import { appendAudit } from './audit.js';
import { resolveLocale } from './config.js';
import {
  createState,
  decideNotification,
  forgetSession,
  rememberAssistantText,
  rememberTurnStart,
  takeReply,
} from './decide.js';
import { buildNotificationCommand, resolveChannel, resolveSound, runNotification } from './notify.js';
import { resolveSessionTitle, resolveWorkingDirectory } from './session.js';

const RATE_WINDOW_MS = 60_000;
const CLIENT_DECISION_TTL_MS = 120_000;
const PLUGIN_VERSION = (() => {
  try {
    return String(createRequire(import.meta.url)('../package.json').version ?? '');
  } catch {
    return '';
  }
})();

/**
 * @param {object} options runtime options
 * @param {{ logger?: Record<string, (...args: unknown[]) => void>, get?: (name: string) => unknown }} options.ctx plugin context
 * @param {import('./config.js').DEFAULT_CONFIG} options.config normalized config
 * @param {Record<string, string | undefined>} [options.env] process environment
 * @param {() => number} [options.now] clock
 * @param {typeof runNotification} [options.send] notification sender
 * @param {typeof appendAudit} [options.audit] audit sink
 * @param {(callback: () => void, delay: number) => unknown} [options.setTimer] timer
 * @param {(timer: unknown) => void} [options.clearTimer] timer cancel
 */
export function createRuntime({
  ctx,
  config,
  env = process.env,
  now = () => Date.now(),
  send = runNotification,
  audit = appendAudit,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  const state = createState();
  /** @type {Map<string, { decision: object, createdAt: number, claimed: boolean }>} */
  state.clientDecisions = new Map();
  /** @type {Map<string, unknown>} */
  state.fallbackTimers = new Map();

  const locale = resolveLocale(config, env);
  const channel = resolveChannel(config);
  const sound = channel === 'osascript' ? resolveSound(config) : '';
  let warnedNoChannel = false;

  const debug = (message) => {
    if (config.debug) ctx?.logger?.debug?.(message);
  };

  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(message);
    } catch {
      // Logger is best-effort.
    }
  };

  const baseRecord = (decision, result, channelName = channel) => ({
    time: new Date(now()).toISOString(),
    pluginVersion: PLUGIN_VERSION,
    status: result?.ok ? 'sent' : 'failed',
    channel: channelName,
    locale,
    title: decision.title,
    body: decision.body,
    reason: decision.reason,
    sessionId: decision.meta.sessionId,
    sessionTitle: decision.meta.sessionTitle,
    cwd: decision.meta.cwd || undefined,
    turn: decision.meta.turn,
    durationMs: decision.meta.durationMs,
    ok: result?.ok === true,
    error: result?.ok ? undefined : result?.error,
  });

  const suppressedRecord = (decision) => ({
    time: new Date(now()).toISOString(),
    pluginVersion: PLUGIN_VERSION,
    status: 'suppressed',
    suppressed: 'rate-limit',
    channel,
    locale,
    reason: decision.reason,
    sessionId: decision.meta.sessionId,
    sessionTitle: decision.meta.sessionTitle,
    cwd: decision.meta.cwd || undefined,
    turn: decision.meta.turn,
    durationMs: decision.meta.durationMs,
  });

  /** True when the sliding-window quota is still available; consumes one slot. */
  const admitDelivery = () => {
    if (config.maxPerMinute <= 0) return true;
    const current = now();
    const windowStart = current - RATE_WINDOW_MS;
    state.recentDeliveries = state.recentDeliveries.filter((deliveredAt) => deliveredAt > windowStart);
    if (state.recentDeliveries.length >= config.maxPerMinute) return false;
    state.recentDeliveries.push(current);
    return true;
  };

  const clearFallbackTimer = (sessionId) => {
    const timer = state.fallbackTimers.get(sessionId);
    if (timer === undefined) return;
    state.fallbackTimers.delete(sessionId);
    try {
      clearTimer(timer);
    } catch {
      // Timer already gone.
    }
  };

  const pruneClientDecisions = () => {
    const cutoff = now() - CLIENT_DECISION_TTL_MS;
    for (const [sessionId, entry] of state.clientDecisions) {
      if (entry.createdAt < cutoff) {
        clearFallbackTimer(sessionId);
        state.clientDecisions.delete(sessionId);
      }
    }
  };

  /** Send through the host OS channel; never called for a client-handled decision. */
  const deliverHost = (decision) => {
    if (channel === 'none') {
      audit(config, baseRecord(decision, { ok: false, error: 'no supported notification channel' }), env);
      if (!warnedNoChannel) {
        warnedNoChannel = true;
        warn('dsh-notify: no supported notification channel on this platform (supported: macOS, Linux)');
      }
      return;
    }

    const spec = buildNotificationCommand(channel, {
      title: decision.title,
      body: decision.body,
      sound,
    });
    if (!spec) {
      audit(config, baseRecord(decision, { ok: false, error: 'notification command unavailable' }), env);
      return;
    }

    void send(spec, { timeoutMs: config.timeoutMs })
      .then((result) => {
        audit(config, baseRecord(decision, result), env);
        if (result?.ok) debug(`dsh-notify: delivered "${decision.title}" / "${decision.body}"`);
        else warn(`dsh-notify: notification failed: ${result?.error ?? 'unknown error'}`);
      })
      .catch((error) => {
        audit(config, baseRecord(decision, { ok: false, error: String(error?.message ?? error) }), env);
        warn(`dsh-notify: notification failed: ${String(error?.message ?? error)}`);
      });
  };

  /**
   * Queue a decision for the connected client and arm the host fallback.
   * The client claims the decision through the Host route, shows a clickable
   * notification, then acknowledges so the fallback is cancelled.
   */
  const queueClientDecision = (decision) => {
    pruneClientDecisions();
    const sessionId = decision.meta.sessionId;
    clearFallbackTimer(sessionId);
    state.clientDecisions.set(sessionId, { decision, createdAt: now(), claimed: false });

    const timer = setTimer(() => {
      state.fallbackTimers.delete(sessionId);
      const entry = state.clientDecisions.get(sessionId);
      if (!entry) return;
      state.clientDecisions.delete(sessionId);
      debug('dsh-notify: client did not acknowledge; falling back to the host channel');
      deliverHost(entry.decision);
    }, config.clientFallbackMs);
    state.fallbackTimers.set(sessionId, timer);
  };

  /** Claim one queued decision for a client; a decision is delivered at most once. */
  const takeClientDecision = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    pruneClientDecisions();
    const entry = state.clientDecisions.get(sessionId);
    if (!entry || entry.claimed) return null;
    entry.claimed = true;
    return {
      sessionId: entry.decision.meta.sessionId,
      sessionTitle: entry.decision.meta.sessionTitle,
      title: entry.decision.title,
      body: entry.decision.body,
      reason: entry.decision.reason,
      cwd: entry.decision.meta.cwd,
      turn: entry.decision.meta.turn,
      durationMs: entry.decision.meta.durationMs,
    };
  };

  /**
   * A client reports whether it displayed the claimed notification.
   * `shown: false` immediately triggers the host fallback.
   */
  const ackClientDecision = (sessionId, shown) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    const entry = state.clientDecisions.get(sessionId);
    if (!entry) return false;
    clearFallbackTimer(sessionId);
    state.clientDecisions.delete(sessionId);
    if (shown) {
      audit(config, baseRecord(entry.decision, { ok: true, via: 'client' }, 'client'), env);
      debug(`dsh-notify: client displayed "${entry.decision.title}"`);
    } else {
      audit(
        config,
        baseRecord(entry.decision, { ok: false, error: 'client could not display notification' }, 'client'),
        env,
      );
      debug('dsh-notify: client could not display the notification; falling back to the host channel');
      deliverHost(entry.decision);
    }
    return true;
  };

  /** Record one client-half activation for troubleshooting. */
  const markClientReady = (info) => {
    try {
      audit(
        config,
        {
          time: new Date(now()).toISOString(),
          pluginVersion: PLUGIN_VERSION,
          status: 'client-ready',
          channel: 'client',
          locale,
          href: typeof info?.href === 'string' ? info.href : undefined,
          permission: typeof info?.permission === 'string' ? info.permission : undefined,
        },
        env,
      );
    } catch {
      // Diagnostics only.
    }
  };

  /** Record one notification click and its focus attempt for troubleshooting. */
  const markClientClick = (info) => {
    try {
      audit(
        config,
        {
          time: new Date(now()).toISOString(),
          pluginVersion: PLUGIN_VERSION,
          status: 'client-click',
          channel: 'client',
          locale,
          sessionId: typeof info?.sessionId === 'string' ? info.sessionId : undefined,
          href: typeof info?.href === 'string' ? info.href : undefined,
          focused: info?.focused === true,
          detail: typeof info?.detail === 'string' ? info.detail.slice(0, 200) : undefined,
        },
        env,
      );
    } catch {
      // Diagnostics only.
    }
  };

  const CLIENT_EVENT_STATUSES = new Set(['notification-shown', 'notification-error', 'notification-timeout']);

  /** Record one client notification lifecycle event for troubleshooting. */
  const markClientEvent = (info) => {
    const event = typeof info?.event === 'string' ? info.event : '';
    if (!CLIENT_EVENT_STATUSES.has(event)) return false;
    try {
      audit(
        config,
        {
          time: new Date(now()).toISOString(),
          pluginVersion: PLUGIN_VERSION,
          status: `client-${event}`,
          channel: 'client',
          locale,
          sessionId: typeof info?.sessionId === 'string' ? info.sessionId : undefined,
          detail: typeof info?.detail === 'string' ? info.detail.slice(0, 200) : undefined,
        },
        env,
      );
    } catch {
      // Diagnostics only.
    }
    return true;
  };

  /** Cancel pending client work on unload. */
  const dispose = () => {
    for (const sessionId of [...state.fallbackTimers.keys()]) clearFallbackTimer(sessionId);
    state.clientDecisions.clear();
  };

  const handleDecision = (decision) => {
    if (!decision) return;

    if (!admitDelivery()) {
      audit(config, suppressedRecord(decision), env);
      debug('dsh-notify: suppressed by rate limit');
      return;
    }

    if (config.clientNotifications) {
      queueClientDecision(decision);
      return;
    }

    deliverHost(decision);
  };

  const onSessionEvent = (session, event) => {
    try {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'turn/start') {
        rememberTurnStart(state, session, event, now());
        return;
      }
      if (event.type === 'assistant/message') {
        rememberAssistantText(state, session, event);
        return;
      }
      if (event.type !== 'turn/end') return;
      handleDecision(
        decideNotification({
          session,
          event,
          config,
          state,
          locale,
          resolveTitle: (target) => resolveSessionTitle(ctx, target),
          cwd: resolveWorkingDirectory(ctx, session),
          reply: takeReply(state, session, event.data?.turn),
        }),
      );
    } catch (error) {
      warn(`dsh-notify: failed to handle session event: ${String(error?.message ?? error)}`);
    }
  };

  const onSessionDisposed = (session) => {
    try {
      forgetSession(state, session);
      if (typeof session?.id === 'string') {
        clearFallbackTimer(session.id);
        state.clientDecisions.delete(session.id);
      }
    } catch {
      // Bookkeeping only.
    }
  };

  return {
    state,
    locale,
    channel,
    sound,
    onSessionEvent,
    onSessionDisposed,
    takeClientDecision,
    ackClientDecision,
    markClientReady,
    markClientClick,
    markClientEvent,
    dispose,
  };
}
