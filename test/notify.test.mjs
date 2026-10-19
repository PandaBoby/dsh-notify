import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appendAudit, resolveAuditPath, resolveDshHome } from '../lib/audit.js';
import {
  DEFAULT_CONFIG,
  formatDuration,
  normalizeConfig,
  renderTemplate,
  resolveLocale,
  sanitizeText,
  statusEmoji,
  statusLabel,
} from '../lib/config.js';
import {
  createState,
  decideNotification,
  forgetSession,
  normalizeReason,
  rememberAssistantText,
  rememberTurnStart,
  takeReply,
} from '../lib/decide.js';
import { buildNotificationCommand, resolveChannel, resolveSound } from '../lib/notify.js';
import { createRuntime } from '../lib/runtime.js';
import { assistantTextFromEvent, isUserSession, resolveWorkingDirectory, workspaceName } from '../lib/session.js';
import { apply } from '../index.js';

const SESSION_ID = 'sess_0123456789abcdef';

function makeSession({ id = SESSION_ID, header = {} } = {}) {
  return {
    id,
    header: { cwd: '/Users/example/projects/demo-app', ...header },
  };
}

function turnStart({ turn = 1, time = 995_000 } = {}) {
  return { type: 'turn/start', time, data: { turn } };
}

function turnEnd({ turn = 1, time = 1_000_000, kind = 'completed', extra = {} } = {}) {
  return { type: 'turn/end', time, data: { turn, reason: { kind, ...extra } } };
}

function assistantMessage({ turn = 1, time = 999_000, text = 'Fixed the login bug.' } = {}) {
  return {
    type: 'assistant/message',
    time,
    data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

function baseConfig(overrides = {}) {
  return normalizeConfig({ locale: 'en', ...overrides });
}

test('normalizeConfig applies documented defaults', () => {
  const config = normalizeConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.channel, 'auto');
  assert.equal(config.sound, 'Glass');
  assert.deepEqual(config.notifyOn, ['completed', 'error']);
  assert.equal(config.includeSubagents, false);
  assert.equal(config.minDurationMs, 0);
  assert.equal(config.maxPerMinute, 12);
  assert.equal(config.locale, 'auto');
  assert.equal(config.titleTemplate, 'DeepSeek Harness');
  assert.equal(config.bodyTemplate, '{emoji} {session} · {status}');
  assert.equal(config.clientNotifications, true);
  assert.equal(config.clientFallbackMs, 2_500);
  assert.equal(config.timeoutMs, 5_000);
  assert.equal(config.audit, true);
  assert.equal(config.debug, false);
});

test('normalizeConfig validates and clamps hostile values', () => {
  const config = normalizeConfig({
    enabled: 'no',
    channel: 'telegram',
    sound: 'Glass"; rm -rf /',
    notifyOn: ['Completed', 'error', 'max_tokens', 'bogus'],
    includeSubagents: 'yes',
    minDurationMs: -5,
    maxPerMinute: '4',
    locale: 'fr',
    timeoutMs: 1,
    audit: 0,
    debug: 'true',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.channel, 'auto');
  assert.equal(config.sound, '');
  assert.deepEqual(config.notifyOn, ['completed', 'error', 'max-tokens']);
  assert.equal(config.includeSubagents, false);
  assert.equal(config.minDurationMs, 0);
  assert.equal(config.maxPerMinute, 4);
  assert.equal(config.locale, 'auto');
  assert.equal(config.timeoutMs, 500);
  assert.equal(config.audit, true);
  assert.equal(config.debug, false);
});

test('normalizeConfig supports empty notifyOn, all, and explicit empty sound', () => {
  assert.deepEqual(normalizeConfig({ notifyOn: [] }).notifyOn, []);
  const all = normalizeConfig({ notifyOn: 'all' }).notifyOn;
  assert.equal(all.length, 7);
  assert.ok(all.includes('forked'));
  assert.equal(normalizeConfig({ sound: '' }).sound, '');
  assert.equal(normalizeConfig({ sound: false }).sound, '');
});

test('resolveLocale follows config, then system/env, then Intl', () => {
  assert.equal(resolveLocale(normalizeConfig({ locale: 'zh' })), 'zh');
  assert.equal(resolveLocale(normalizeConfig({}), {}, () => 'zh_CN'), 'zh');
  assert.equal(resolveLocale(normalizeConfig({}), { LANG: 'zh_CN.UTF-8' }, () => 'en_US'), 'en');
  assert.equal(resolveLocale(normalizeConfig({}), { DSH_NOTIFY_LOCALE: 'zh-CN' }, () => 'en_US'), 'zh');
});

test('status labels and emoji cover every reason', () => {
  for (const reason of ['completed', 'error', 'aborted', 'interrupted', 'max-tokens', 'blocked', 'forked']) {
    assert.equal(typeof statusLabel(reason, 'en'), 'string');
    assert.equal(typeof statusLabel(reason, 'zh'), 'string');
    assert.equal(typeof statusEmoji(reason), 'string');
  }
  assert.equal(statusLabel('completed', 'zh'), '任务完成');
  assert.equal(statusLabel('error', 'en'), 'failed');
  assert.equal(statusEmoji('completed'), '✅');
});

test('formatDuration renders minute/second/hour forms', () => {
  assert.equal(formatDuration(0, 'en'), '0s');
  assert.equal(formatDuration(12_400, 'en'), '12s');
  assert.equal(formatDuration(65_000, 'en'), '1m 5s');
  assert.equal(formatDuration(3_725_000, 'en'), '1h 2m 5s');
  assert.equal(formatDuration(65_000, 'zh'), '1分5秒');
  assert.equal(formatDuration(3_725_000, 'zh'), '1小时2分5秒');
  assert.equal(formatDuration(undefined, 'en'), '');
});

test('renderTemplate substitutes known tokens, keeps unknown ones, ignores inherited props', () => {
  const rendered = renderTemplate('{emoji} {session} · {status} {unknown} {constructor}', {
    emoji: '✅',
    session: 'demo',
    status: 'completed',
  });
  assert.equal(rendered, '✅ demo · completed {unknown} {constructor}');
});

test('sanitizeText strips control characters and clamps length', () => {
  const cleaned = sanitizeText('a\u0000b\r\nc\n\n\n\nd\t\t e', 100);
  assert.equal(cleaned, 'a b\nc\n\nd e');
  const bidi = sanitizeText('safe\u202eevil\u200btext', 100);
  assert.equal(bidi, 'safe evil text');
  const clipped = sanitizeText('x'.repeat(50), 10);
  assert.equal(clipped.length, 10);
  assert.ok(clipped.endsWith('…'));
});

test('isUserSession distinguishes root and delegated sessions', () => {
  assert.equal(isUserSession(makeSession()), true);
  assert.equal(isUserSession(makeSession({ header: { origin: 'subagent' } })), false);
  assert.equal(isUserSession(makeSession({ header: { parentSession: 'parent' } })), false);
  assert.equal(isUserSession(makeSession({ header: { delegationDepth: 1 } })), false);
  assert.equal(workspaceName('/Users/example/projects/demo-app'), 'demo-app');
  assert.equal(workspaceName('/'), '');
});

test('assistantTextFromEvent extracts text blocks only', () => {
  assert.equal(assistantTextFromEvent(assistantMessage({ text: 'hello world' })), 'hello world');
  assert.equal(
    assistantTextFromEvent({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'visible' },
            { type: 'tool-call', name: 'x' },
          ],
        },
      },
    }),
    'visible',
  );
  assert.equal(assistantTextFromEvent(turnEnd()), '');
  assert.equal(assistantTextFromEvent(assistantMessage({ text: 'abcdefgh' }), 5), 'abcd…');
});

test('rememberAssistantText and takeReply scope previews to their turn', () => {
  const state = createState();
  const session = makeSession();
  rememberAssistantText(state, session, assistantMessage({ turn: 3, text: 'turn three answer' }));
  assert.equal(takeReply(state, session, 3), 'turn three answer');
  assert.equal(takeReply(state, session, 3), '');

  rememberAssistantText(state, session, assistantMessage({ turn: 4, text: 'turn four answer' }));
  assert.equal(takeReply(state, session, 3), '');
  assert.equal(takeReply(state, session, 4), 'turn four answer');
});

test('resolveWorkingDirectory prefers the service over the header', () => {
  const session = makeSession();
  const ctx = { get: (name) => (name === 'workingDirectory' ? { get: () => '/tmp/effective' } : undefined) };
  assert.equal(resolveWorkingDirectory(ctx, session), '/tmp/effective');
  assert.equal(resolveWorkingDirectory({ get: () => undefined }, session), '/Users/example/projects/demo-app');
});

test('decideNotification notifies for a completed root turn with duration', () => {
  const state = createState();
  const session = makeSession();
  rememberTurnStart(state, session, turnStart({ time: 995_000 }));
  const decision = decideNotification({
    session,
    event: turnEnd({ time: 1_000_000 }),
    config: baseConfig(),
    state,
    locale: 'en',
  });
  assert.ok(decision && decision.notify);
  assert.equal(decision.title, 'DeepSeek Harness');
  assert.equal(decision.body, '✅ demo-app · completed');
  assert.equal(decision.meta.durationMs, 5_000);
  assert.equal(decision.reason, 'completed');
});

test('decideNotification omits duration when the turn start was never observed', () => {
  const decision = decideNotification({
    session: makeSession(),
    event: turnEnd({ time: 1_000_000 }),
    config: baseConfig({ bodyTemplate: '{emoji} {session} {duration}' }),
    state: createState(),
    locale: 'en',
  });
  assert.ok(decision && decision.notify);
  assert.equal(decision.meta.durationMs, undefined);
  assert.equal(decision.body.trim(), '✅ demo-app');
});

test('decideNotification filters delegated sessions by default', () => {
  const state = createState();
  const child = makeSession({ header: { origin: 'subagent', cwd: '/tmp/child' } });
  const event = turnEnd();
  assert.equal(decideNotification({ session: child, event, config: baseConfig(), state, locale: 'en' }), null);

  const included = decideNotification({
    session: child,
    event,
    config: baseConfig({ includeSubagents: true }),
    state: createState(),
    locale: 'en',
  });
  assert.ok(included && included.notify);
});

test('decideNotification applies the notifyOn filter', () => {
  const state = createState();
  const session = makeSession();
  assert.ok(
    decideNotification({
      session,
      event: turnEnd({ kind: 'error', extra: { error: { message: 'provider overloaded' } } }),
      config: baseConfig(),
      state,
      locale: 'en',
    }),
  );
  assert.equal(
    decideNotification({ session, event: turnEnd({ kind: 'aborted' }), config: baseConfig(), state, locale: 'en' }),
    null,
  );
  assert.ok(
    decideNotification({
      session,
      event: turnEnd({ kind: 'aborted' }),
      config: baseConfig({ notifyOn: ['aborted'] }),
      state,
      locale: 'en',
    }),
  );
});

test('decideNotification renders templates with reply, error detail and cwd override', () => {
  const decision = decideNotification({
    session: makeSession(),
    event: turnEnd({
      kind: 'error',
      time: 1_000_000,
      extra: { error: { message: 'rate limited' } },
    }),
    config: baseConfig({
      titleTemplate: '{emoji} {session}',
      bodyTemplate: '{status}: {error} — {reply} ({duration}) @{workspace}',
    }),
    state: (() => {
      const state = createState();
      rememberTurnStart(state, makeSession(), turnStart({ time: 995_000 }));
      return state;
    })(),
    locale: 'en',
    cwd: '/tmp/elsewhere',
    reply: 'All checks pass.',
  });
  assert.ok(decision && decision.notify);
  assert.equal(decision.title, '❌ demo-app');
  assert.equal(decision.body, 'failed: rate limited — All checks pass. (5s) @elsewhere');
  assert.equal(decision.meta.cwd, '/tmp/elsewhere');
});

test('decideNotification renders {reply} in the title too', () => {
  const decision = decideNotification({
    session: makeSession(),
    event: turnEnd(),
    config: baseConfig({ titleTemplate: '{session} — {reply}' }),
    state: createState(),
    locale: 'en',
    reply: 'done',
  });
  assert.ok(decision && decision.notify);
  assert.equal(decision.title, 'demo-app — done');
});

test('decideNotification honors minDurationMs', () => {
  const state = createState();
  const session = makeSession();
  rememberTurnStart(state, session, turnStart({ time: 999_000 }));
  const decision = decideNotification({
    session,
    event: turnEnd({ time: 1_000_000 }),
    config: baseConfig({ minDurationMs: 5_000 }),
    state,
    locale: 'en',
  });
  assert.equal(decision, null);
});

test('decideNotification ignores malformed or unknown reasons', () => {
  const malformed = { type: 'turn/end', time: 1_000_000, data: { turn: 1 } };
  assert.deepEqual(normalizeReason(malformed), { kind: '', reason: undefined });
  assert.equal(
    decideNotification({
      session: makeSession(),
      event: malformed,
      config: baseConfig(),
      state: createState(),
      locale: 'en',
    }),
    null,
  );
  assert.equal(
    decideNotification({
      session: makeSession(),
      event: turnEnd({ kind: 'some-future-reason' }),
      config: baseConfig({ notifyOn: 'all' }),
      state: createState(),
      locale: 'en',
    }),
    null,
  );
});

test('forgetSession releases turn and reply bookkeeping', () => {
  const state = createState();
  const session = makeSession();
  rememberTurnStart(state, session, turnStart());
  rememberAssistantText(state, session, assistantMessage());
  assert.equal(state.turnStarts.size, 1);
  assert.equal(state.lastReplies.size, 1);
  forgetSession(state, session);
  assert.equal(state.turnStarts.size, 0);
  assert.equal(state.lastReplies.size, 0);
});

test('resolveChannel respects platform and explicit channel', () => {
  assert.equal(resolveChannel(baseConfig(), { platform: 'darwin' }), 'osascript');
  assert.equal(resolveChannel(baseConfig(), { platform: 'linux' }), 'notify-send');
  assert.equal(resolveChannel(baseConfig(), { platform: 'win32' }), 'none');
  assert.equal(resolveChannel(baseConfig({ channel: 'none' }), { platform: 'darwin' }), 'none');
  assert.equal(resolveChannel(baseConfig({ channel: 'notify-send' }), { platform: 'darwin' }), 'none');
  assert.equal(resolveChannel(baseConfig({ channel: 'osascript' }), { platform: 'linux' }), 'none');
});

test('resolveSound validates against system sounds', () => {
  const exists = (path) => path === '/System/Library/Sounds/Glass.aiff';
  assert.equal(resolveSound(baseConfig(), { exists }), 'Glass');
  assert.equal(resolveSound(baseConfig({ sound: 'NoSuchSound' }), { exists }), '');
  assert.equal(resolveSound(baseConfig({ sound: '' }), { exists }), '');
});

test('buildNotificationCommand passes content as argv, never through a shell', () => {
  const title = 'A "quoted" title & $(whoami)';
  const body = '-notify-option line1 `id` \\ backslash';
  const command = buildNotificationCommand('osascript', { title, body, sound: 'Glass' });
  assert.equal(command.command, '/usr/bin/osascript');
  assert.equal(command.args[0], '-e');
  assert.ok(command.args[1].includes('display notification'));
  assert.equal(command.args[2], '--');
  assert.equal(command.args[3], title);
  assert.equal(command.args[4], body);
  assert.equal(command.args[5], 'Glass');

  const linux = buildNotificationCommand('notify-send', { title, body });
  assert.equal(linux.command, 'notify-send');
  assert.equal(linux.args.at(-3), '--');
  assert.equal(linux.args.at(-2), title);
  assert.equal(linux.args.at(-1), body);
  assert.equal(buildNotificationCommand('none', { title, body }), null);
});

test('runtime wires turn/end to a sent notification and audit record', async () => {
  const sent = [];
  const audits = [];
  const logs = [];
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      debug: (message) => logs.push(['debug', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    get: (name) => {
      if (name === 'sessionTitle') return { get: () => ({ title: 'Notification work' }) };
      if (name === 'workingDirectory') return { get: () => '/tmp/effective-cwd' };
      return undefined;
    },
  };
  const runtime = createRuntime({
    ctx,
    config: baseConfig({ sound: '', clientNotifications: false, bodyTemplate: '{emoji} {session} · {status}\n{reply}' }),
    env: {},
    now: () => 1_000_000,
    send: async (spec) => {
      sent.push(spec);
      return { ok: true, code: 0, signal: null };
    },
    audit: (config, record) => audits.push(record),
  });

  const session = makeSession();
  runtime.onSessionEvent(session, turnStart({ time: 992_000 }));
  runtime.onSessionEvent(session, assistantMessage({ text: 'All tests pass.' }));
  runtime.onSessionEvent(session, turnEnd({ time: 1_000_000 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].args.at(-3), 'DeepSeek Harness');
  assert.equal(sent[0].args.at(-2), '✅ Notification work · completed\nAll tests pass.');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, 'sent');
  assert.equal(audits[0].pluginVersion, '0.1.0');
  assert.equal(audits[0].durationMs, 8_000);
  assert.equal(audits[0].sessionTitle, 'Notification work');
  assert.equal(audits[0].cwd, '/tmp/effective-cwd');
});

test('runtime audits suppressed rate limits without consuming a notification', async () => {
  const sent = [];
  const audits = [];
  const runtime = createRuntime({
    ctx: { logger: {} },
    config: baseConfig({ maxPerMinute: 1, sound: '', clientNotifications: false }),
    env: {},
    now: () => 1_000_000,
    send: async (spec) => {
      sent.push(spec);
      return { ok: true };
    },
    audit: (config, record) => audits.push(record),
  });
  runtime.onSessionEvent(makeSession(), turnEnd());
  runtime.onSessionEvent(makeSession({ id: 'sess_second' }), turnEnd());
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1);
  assert.equal(audits.length, 2);
  const suppressed = audits.filter((record) => record.status === 'suppressed');
  const delivered = audits.filter((record) => record.status === 'sent');
  assert.equal(suppressed.length, 1);
  assert.equal(delivered.length, 1);
  assert.equal(suppressed[0].suppressed, 'rate-limit');
  assert.equal(suppressed[0].sessionId, 'sess_second');
  assert.equal(suppressed[0].sessionTitle, 'demo-app');
  assert.equal(suppressed[0].turn, 1);
});

test('runtime reports channel none without sending or consuming quota', async () => {
  const sent = [];
  const audits = [];
  const runtime = createRuntime({
    ctx: { logger: {} },
    config: baseConfig({ channel: 'none', maxPerMinute: 1, clientNotifications: false }),
    env: {},
    now: () => 1_000_000,
    send: async (spec) => {
      sent.push(spec);
      return { ok: true };
    },
    audit: (config, record) => audits.push(record),
  });
  runtime.onSessionEvent(makeSession(), turnEnd());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, 'failed');
  assert.match(audits[0].error, /no supported notification channel/);
  assert.equal(audits[0].sessionId, SESSION_ID);
});

function clientRuntime({ config = {}, now = () => 1_000_000, send, audit } = {}) {
  const timers = new Map();
  const sent = [];
  const audits = [];
  const runtime = createRuntime({
    ctx: { logger: {} },
    config: baseConfig({ sound: '', clientNotifications: true, clientFallbackMs: 2_500, ...config }),
    env: {},
    now,
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.set(timer, true);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    send: send ?? (async (spec) => {
      sent.push(spec);
      return { ok: true };
    }),
    audit: audit ?? ((config, record) => audits.push(record)),
  });
  return { runtime, timers, sent, audits };
}

test('runtime queues decisions for a connected client and lets it claim once', () => {
  const { runtime, sent, audits } = clientRuntime();
  runtime.onSessionEvent(makeSession(), turnEnd());

  assert.equal(sent.length, 0);
  assert.equal(audits.length, 0);
  const decision = runtime.takeClientDecision(SESSION_ID);
  assert.ok(decision);
  assert.equal(decision.sessionId, SESSION_ID);
  assert.equal(decision.reason, 'completed');
  assert.match(decision.body, /demo-app/);
  assert.equal(runtime.takeClientDecision(SESSION_ID), null);

  assert.equal(runtime.ackClientDecision(SESSION_ID, true), true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, 'sent');
  assert.equal(audits[0].channel, 'client');
  assert.equal(audits[0].ok, true);
  assert.equal(runtime.ackClientDecision(SESSION_ID, true), false);
});

test('runtime falls back to the host channel when the client cannot show a notification', async () => {
  const { runtime, sent, audits } = clientRuntime();
  runtime.onSessionEvent(makeSession(), turnEnd());
  runtime.takeClientDecision(SESSION_ID);
  runtime.ackClientDecision(SESSION_ID, false);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1);
  assert.equal(audits.length, 2);
  assert.equal(audits[0].channel, 'client');
  assert.equal(audits[0].status, 'failed');
  assert.equal(audits[1].channel, process.platform === 'darwin' ? 'osascript' : resolveChannel(baseConfig()));
  assert.equal(audits[1].status, 'sent');
});

test('runtime falls back to the host channel when the client never acknowledges', () => {
  const { runtime, timers, sent } = clientRuntime();
  runtime.onSessionEvent(makeSession(), turnEnd());
  assert.equal(timers.size, 1);
  const [timer] = [...timers.keys()];
  assert.equal(timer.delay, 2_500);
  timer.callback();
  assert.equal(sent.length, 1);
  assert.equal(runtime.takeClientDecision(SESSION_ID), null);
});

test('runtime queues for the client even when the host notification channel is none', () => {
  const { runtime, audits } = clientRuntime({ config: { channel: 'none' } });
  runtime.onSessionEvent(makeSession(), turnEnd());
  assert.equal(audits.length, 0);
  assert.ok(runtime.takeClientDecision(SESSION_ID));
});

test('runtime records client notification lifecycle events', () => {
  const { runtime, audits } = clientRuntime();
  assert.equal(runtime.markClientEvent({ event: 'notification-shown', sessionId: SESSION_ID }), true);
  assert.equal(runtime.markClientEvent({ event: 'notification-error', sessionId: SESSION_ID, detail: 'boom' }), true);
  assert.equal(runtime.markClientEvent({ event: 'arbitrary-event', sessionId: SESSION_ID }), false);
  assert.equal(audits.length, 2);
  assert.equal(audits[0].status, 'client-notification-shown');
  assert.equal(audits[1].status, 'client-notification-error');
  assert.equal(audits[1].detail, 'boom');
});

test('runtime dispose cancels pending client timers', () => {
  const { runtime, timers, sent } = clientRuntime();
  runtime.onSessionEvent(makeSession(), turnEnd());
  assert.equal(timers.size, 1);
  runtime.dispose();
  assert.equal(timers.size, 0);
  assert.equal(sent.length, 0);
});

test('apply registers Host listeners, cleanup and routes', () => {
  const listeners = new Map();
  const effects = [];
  const injections = [];
  const runEffect = (callback) => {
    const cleanup = callback();
    if (typeof cleanup === 'function') effects.push(cleanup);
    return () => {};
  };
  const ctx = {
    logger: { info() {}, debug() {}, warn() {} },
    on(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
    effect: runEffect,
    inject(names, callback) {
      injections.push(names.join(','));
      callback({
        get: (name) => (name === 'connection' ? { fetch: { register: () => () => {} } } : undefined),
        effect: runEffect,
      });
      return () => {};
    },
  };
  apply(ctx, {});
  assert.equal(typeof listeners.get('session/event'), 'function');
  assert.equal(typeof listeners.get('session/disposed'), 'function');
  assert.ok(injections.includes('connection'));
  assert.ok(effects.length >= 2);

  const quiet = new Map();
  apply({ ...ctx, on: (name, handler) => (quiet.set(name, handler), () => {}) }, { enabled: false });
  assert.equal(quiet.size, 0);
});

test('appendAudit writes a private, parseable JSONL record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-notify-test-'));
  try {
    const path = join(directory, 'audit.jsonl');
    const config = normalizeConfig({ auditPath: path });
    assert.equal(resolveAuditPath(config), path);
    await appendAudit(config, { status: 'sent', title: 'hello', body: 'world' }, {});
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { status: 'sent', title: 'hello', body: 'world' });
    assert.equal(statSync(path).mode & 0o777, 0o600);

    await appendAudit(config, { status: 'failed' }, {});
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resolveDshHome honors DSH_HOME from the environment', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/custom-dsh' }), '/tmp/custom-dsh');
  assert.equal(resolveDshHome({}), join(process.env.HOME ?? '', '.dsh'));
});

test('DEFAULT_CONFIG is frozen', () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.notifyOn));
});

