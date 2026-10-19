import assert from 'node:assert/strict';
import test from 'node:test';

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
import { createState, decideNotification, forgetSession, rememberTurnStart } from '../lib/decide.js';
import { buildNotificationCommand, resolveChannel, resolveSound } from '../lib/notify.js';
import { createRuntime } from '../lib/runtime.js';
import { extractReplyPreview, isUserSession, workspaceName } from '../lib/session.js';
import { apply } from '../index.js';

const SESSION_ID = 'sess_0123456789abcdef';

function makeSession({ id = SESSION_ID, header = {}, events = [] } = {}) {
  return {
    id,
    header: { cwd: '/Users/example/projects/demo-app', ...header },
    snapshotEvents: () => events,
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
  assert.equal(config.sound, 'Glass');
  assert.deepEqual(config.notifyOn, ['completed', 'error', 'max-tokens']);
  assert.equal(config.includeSubagents, false);
  assert.equal(config.minDurationMs, 0);
  assert.equal(config.maxPerMinute, 4);
  assert.equal(config.locale, 'auto');
  assert.equal(config.timeoutMs, 500);
  assert.equal(config.audit, true);
  assert.equal(config.debug, false);
});

test('normalizeConfig supports empty notifyOn and all', () => {
  assert.deepEqual(normalizeConfig({ notifyOn: [] }).notifyOn, []);
  const all = normalizeConfig({ notifyOn: 'all' }).notifyOn;
  assert.equal(all.length, 7);
  assert.ok(all.includes('forked'));
});

test('resolveLocale follows config, then system/env, then Intl', () => {
  assert.equal(resolveLocale(normalizeConfig({ locale: 'zh' })), 'zh');
  assert.equal(
    resolveLocale(normalizeConfig({}), {}, () => 'zh_CN'),
    'zh',
  );
  assert.equal(
    resolveLocale(normalizeConfig({}), { LANG: 'zh_CN.UTF-8' }, () => 'en_US'),
    'en',
  );
  assert.equal(
    resolveLocale(normalizeConfig({}), { DSH_NOTIFY_LOCALE: 'zh-CN' }, () => 'en_US'),
    'zh',
  );
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

test('renderTemplate substitutes known tokens and keeps unknown ones visible', () => {
  const rendered = renderTemplate('{emoji} {session} · {status} {unknown}', {
    emoji: '✅',
    session: 'demo',
    status: 'completed',
  });
  assert.equal(rendered, '✅ demo · completed {unknown}');
});

test('sanitizeText strips control characters and clamps length', () => {
  const cleaned = sanitizeText('a\u0000b\r\nc\n\n\n\nd\t\t e', 100);
  assert.equal(cleaned, 'a b\nc\n\nd e');
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

test('extractReplyPreview returns the last assistant text of the turn', () => {
  const events = [
    turnStart({ time: 1_000 }),
    assistantMessage({ text: 'first answer' }),
    assistantMessage({ text: 'second answer' }),
  ];
  assert.equal(extractReplyPreview(makeSession({ events }), 1), 'second answer');
  const preview = extractReplyPreview(makeSession({ events }), 1, 5);
  assert.equal(preview, 'seco…');
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
    now: 1_000_000,
  });
  assert.ok(decision && decision.notify);
  assert.equal(decision.title, 'DeepSeek Harness');
  assert.equal(decision.body, '✅ demo-app · completed');
  assert.equal(decision.meta.durationMs, 5_000);
  assert.equal(decision.reason, 'completed');
});

test('decideNotification filters delegated sessions by default', () => {
  const state = createState();
  const child = makeSession({ header: { origin: 'subagent', cwd: '/tmp/child' } });
  const event = turnEnd();
  assert.equal(
    decideNotification({ session: child, event, config: baseConfig(), state, locale: 'en' }),
    null,
  );

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
  const error = { message: 'provider overloaded' };
  assert.ok(
    decideNotification({
      session,
      event: turnEnd({ kind: 'error', extra: { error } }),
      config: baseConfig(),
      state,
      locale: 'en',
    }),
  );
  assert.equal(
    decideNotification({
      session,
      event: turnEnd({ kind: 'aborted' }),
      config: baseConfig(),
      state,
      locale: 'en',
    }),
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

test('decideNotification renders templates, reply preview and error detail', () => {
  const state = createState();
  const session = makeSession({
    events: [turnStart({ time: 995_000 }), assistantMessage({ text: 'All checks pass.' })],
  });
  const decision = decideNotification({
    session,
    event: turnEnd({ kind: 'error', time: 1_000_000, extra: { error: { message: 'rate limited' } } }),
    config: baseConfig({
      titleTemplate: '{emoji} {session}',
      bodyTemplate: '{status}: {error} — {reply} ({duration})',
    }),
    state,
    locale: 'en',
    now: 1_000_000,
  });
  assert.ok(decision && decision.notify);
  assert.equal(decision.title, '❌ demo-app');
  assert.equal(decision.body, 'failed: rate limited — All checks pass. (5s)');
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

test('decideNotification applies a sliding-window rate limit', () => {
  const state = createState();
  const config = baseConfig({ maxPerMinute: 1 });
  const first = decideNotification({
    session: makeSession(),
    event: turnEnd(),
    config,
    state,
    locale: 'en',
    now: 1_000_000,
  });
  const second = decideNotification({
    session: makeSession({ id: 'sess_other' }),
    event: turnEnd(),
    config,
    state,
    locale: 'en',
    now: 1_000_001,
  });
  assert.ok(first && first.notify);
  assert.deepEqual(second, { suppressed: 'rate-limit' });
});

test('forgetSession releases turn bookkeeping', () => {
  const state = createState();
  const session = makeSession();
  rememberTurnStart(state, session, turnStart());
  assert.equal(state.turnStarts.size, 1);
  forgetSession(state, session);
  assert.equal(state.turnStarts.size, 0);
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
  const body = 'line1 `id` \\ backslash';
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
    get: () => ({ get: () => ({ title: 'Notification work' }) }),
  };
  const runtime = createRuntime({
    ctx,
    config: baseConfig({ sound: '' }),
    env: {},
    now: () => 1_000_000,
    send: async (spec) => {
      sent.push(spec);
      return { ok: true, code: 0, signal: null };
    },
    audit: (config, record) => audits.push(record),
  });

  assert.equal(runtime.channel, process.platform === 'darwin' ? 'osascript' : resolveChannel(baseConfig()));
  const session = makeSession();
  runtime.onSessionEvent(session, turnStart({ time: 992_000 }));
  runtime.onSessionEvent(session, turnEnd({ time: 1_000_000 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].args.at(-3), 'DeepSeek Harness');
  assert.equal(sent[0].args.at(-2), '✅ Notification work · completed');
  assert.equal(sent[0].args.at(-1), '');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].status, 'sent');
  assert.equal(audits[0].durationMs, 8_000);
  assert.equal(audits[0].sessionTitle, 'Notification work');
});

test('runtime audits suppressed rate limits without sending', async () => {
  const sent = [];
  const audits = [];
  const runtime = createRuntime({
    ctx: { logger: {} },
    config: baseConfig({ maxPerMinute: 1, sound: '' }),
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
  assert.equal(suppressed[0].suppressed, 'rate-limit');
  assert.equal(delivered.length, 1);
});

test('apply registers Host listeners and honors enabled: false', () => {
  const listeners = new Map();
  const ctx = {
    logger: { info() {}, debug() {}, warn() {} },
    on(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  };
  apply(ctx, {});
  assert.equal(typeof listeners.get('session/event'), 'function');
  assert.equal(typeof listeners.get('session/disposed'), 'function');

  const quiet = new Map();
  apply({ ...ctx, on: (name, handler) => (quiet.set(name, handler), () => {}) }, { enabled: false });
  assert.equal(quiet.size, 0);
});

test('DEFAULT_CONFIG is frozen', () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.notifyOn));
});
