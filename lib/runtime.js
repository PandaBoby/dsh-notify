/**
 * dsh-notify — runtime adapter between DSH Host events and notification delivery.
 *
 * `createRuntime` is separated from `apply()` so tests can inject a fake sender,
 * fake audit sink and fake clock while exercising the exact wiring used in the
 * Host process.
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
 */
export function createRuntime({
  ctx,
  config,
  env = process.env,
  now = () => Date.now(),
  send = runNotification,
  audit = appendAudit,
}) {
  const state = createState();
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

  const baseRecord = (decision, result) => ({
    time: new Date(now()).toISOString(),
    pluginVersion: PLUGIN_VERSION,
    status: result?.ok ? 'sent' : 'failed',
    channel,
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

  const handleDecision = (decision) => {
    if (!decision) return;

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

    if (!admitDelivery()) {
      audit(config, suppressedRecord(decision), env);
      debug('dsh-notify: suppressed by rate limit');
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
    } catch {
      // Bookkeeping only.
    }
  };

  return { state, locale, channel, sound, onSessionEvent, onSessionDisposed };
}
