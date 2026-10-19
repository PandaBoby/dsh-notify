/**
 * dsh-notify — configuration normalization, locale handling and message rendering.
 *
 * This module is intentionally dependency-free: the Host plugin must load in any
 * DSH profile without resolving a schema library. Unknown config keys are
 * ignored, and every known value is validated and clamped to a safe range.
 */

import { execFileSync } from 'node:child_process';

/** Turn-end reasons the plugin understands (`TurnEndReason.kind` in dsh-session). */
export const NOTIFY_REASONS = [
  'completed',
  'error',
  'aborted',
  'interrupted',
  'max-tokens',
  'blocked',
  'forked',
];

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  channel: 'auto',
  sound: 'Glass',
  notifyOn: Object.freeze(['completed', 'error']),
  includeSubagents: false,
  minDurationMs: 0,
  maxPerMinute: 12,
  locale: 'auto',
  titleTemplate: 'DeepSeek Harness',
  bodyTemplate: '{emoji} {session} · {status}',
  timeoutMs: 5_000,
  audit: true,
  auditPath: '',
  debug: false,
});

const CHANNELS = new Set(['auto', 'osascript', 'notify-send', 'none']);
const LOCALES = new Set(['auto', 'en', 'zh']);

const STATUS_LABELS = {
  en: {
    completed: 'completed',
    error: 'failed',
    aborted: 'cancelled',
    interrupted: 'interrupted',
    'max-tokens': 'hit the token limit',
    blocked: 'blocked',
    forked: 'forked',
  },
  zh: {
    completed: '任务完成',
    error: '任务失败',
    aborted: '任务已取消',
    interrupted: '任务已中断',
    'max-tokens': '达到 token 上限',
    blocked: '任务被阻塞',
    forked: '任务已分叉',
  },
};

const STATUS_EMOJI = Object.freeze({
  completed: '\u2705',
  error: '\u274c',
  aborted: '\u23f9\ufe0f',
  interrupted: '\u26a0\ufe0f',
  'max-tokens': '\ud83d\udd36',
  blocked: '\u26d4',
  forked: '\ud83c\udf3f',
});

/** Characters that can corrupt notification presentation (C0/C1 and bidi controls). */
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampNumber(value, minimum, maximum, fallback) {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function clampString(value, maximum, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  return trimmed.length > maximum ? trimmed.slice(0, maximum) : trimmed;
}

function normalizeSound(value) {
  if (value === false || value === null) return '';
  if (value === undefined) return DEFAULT_CONFIG.sound;
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '' || /^(?:false|off|none|silent)$/i.test(trimmed)) return '';
  // Invalid names fall back to silence, never to an unexpected sound.
  return /^[A-Za-z0-9 ._-]{1,64}$/.test(trimmed) ? trimmed : '';
}

function normalizeNotifyOn(value) {
  if (value === undefined || value === null) return [...DEFAULT_CONFIG.notifyOn];
  if (Array.isArray(value) && value.length === 0) return [];
  if (typeof value === 'string' && value.trim() === '') return [];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const selected = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toLowerCase();
    if (key === '' || key === 'false' || key === 'none') continue;
    if (key === 'all' || key === '*') {
      for (const reason of NOTIFY_REASONS) selected.add(reason);
      continue;
    }
    const canonical = key === 'max_tokens' ? 'max-tokens' : key;
    if (NOTIFY_REASONS.includes(canonical)) selected.add(canonical);
  }
  return [...selected];
}

/**
 * Validate a raw loader-row config into the effective plugin config.
 * @param {unknown} raw config authored in `cordis.patch.yml`
 * @returns {typeof DEFAULT_CONFIG} normalized config
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {};
  return {
    enabled: input.enabled === undefined ? DEFAULT_CONFIG.enabled : input.enabled !== false,
    channel: CHANNELS.has(input.channel) ? input.channel : DEFAULT_CONFIG.channel,
    sound: normalizeSound(input.sound),
    notifyOn: normalizeNotifyOn(input.notifyOn),
    includeSubagents: input.includeSubagents === true,
    minDurationMs: clampNumber(input.minDurationMs, 0, 86_400_000, DEFAULT_CONFIG.minDurationMs),
    maxPerMinute: clampNumber(input.maxPerMinute, 0, 600, DEFAULT_CONFIG.maxPerMinute),
    locale: LOCALES.has(input.locale) ? input.locale : DEFAULT_CONFIG.locale,
    titleTemplate: clampString(input.titleTemplate, 200, DEFAULT_CONFIG.titleTemplate),
    bodyTemplate: clampString(input.bodyTemplate, 800, DEFAULT_CONFIG.bodyTemplate),
    timeoutMs: clampNumber(input.timeoutMs, 500, 30_000, DEFAULT_CONFIG.timeoutMs),
    audit: input.audit === undefined ? DEFAULT_CONFIG.audit : input.audit !== false,
    auditPath: typeof input.auditPath === 'string' ? input.auditPath.trim() : '',
    debug: input.debug === true,
  };
}

function detectMacLocale() {
  if (process.platform !== 'darwin') return '';
  try {
    const value = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** The macOS system locale is probed once per Host process. */
let cachedSystemLocale;

function defaultSystemLocale() {
  if (cachedSystemLocale === undefined) cachedSystemLocale = detectMacLocale();
  return cachedSystemLocale;
}

/**
 * Resolve the effective notification language.
 * Priority: explicit config > macOS system locale > LC_ALL/LC_MESSAGES/LANG >
 * JavaScript Intl default > English.
 * @param {typeof DEFAULT_CONFIG} config normalized config
 * @param {Record<string, string | undefined>} env environment used for detection
 * @param {() => string} systemLocale injectable detector (tests)
 * @returns {'en' | 'zh'} locale id
 */
export function resolveLocale(config, env = process.env, systemLocale = defaultSystemLocale) {
  if (config.locale !== 'auto') return config.locale;

  const explicit = env.DSH_NOTIFY_LOCALE;
  if (typeof explicit === 'string' && explicit.trim()) {
    return /^zh/i.test(explicit.trim()) ? 'zh' : 'en';
  }

  let detected = '';
  try {
    detected = systemLocale() || '';
  } catch {
    detected = '';
  }
  if (detected) return /^zh/i.test(detected) ? 'zh' : 'en';

  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) {
      return /^zh/i.test(value.trim()) ? 'zh' : 'en';
    }
  }

  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    return /^zh/i.test(tag) ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

/**
 * Localized human label for a turn-end reason.
 * @param {string} reason kind such as `completed`
 * @param {'en' | 'zh'} locale locale id
 */
export function statusLabel(reason, locale = 'en') {
  const table = STATUS_LABELS[locale] ?? STATUS_LABELS.en;
  return table[reason] ?? STATUS_LABELS.en[reason] ?? String(reason);
}

/** Emoji prefix for a turn-end reason. */
export function statusEmoji(reason) {
  return STATUS_EMOJI[reason] ?? '\ud83d\udd14';
}

/**
 * Render a compact, human-friendly duration such as `12s`, `3m 5s`, `1h 2m`.
 * @param {number | undefined} milliseconds duration
 * @param {'en' | 'zh'} locale locale id
 */
export function formatDuration(milliseconds, locale = 'en') {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (locale === 'zh') {
    if (hours > 0) return `${hours}小时${minutes > 0 ? `${minutes}分` : ''}${rest > 0 ? `${rest}秒` : ''}`;
    if (minutes > 0) return `${minutes}分${rest > 0 ? `${rest}秒` : ''}`;
    return `${rest}秒`;
  }
  if (hours > 0) {
    return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}${rest > 0 ? ` ${rest}s` : ''}`;
  }
  if (minutes > 0) return `${minutes}m${rest > 0 ? ` ${rest}s` : ''}`;
  return `${rest}s`;
}

/**
 * Replace `{placeholder}` tokens. Unknown placeholders stay verbatim so typos in
 * a user template remain visible instead of silently disappearing.
 * @param {string} template message template
 * @param {Record<string, string | number | undefined>} variables placeholder values
 */
export function renderTemplate(template, variables) {
  return String(template ?? '').replace(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g, (match, key) => {
    if (!Object.hasOwn(variables, key)) return match;
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Strip unsafe control characters and clamp text length for a notification.
 * @param {unknown} value raw text
 * @param {number} maximum maximum character count
 * @param {string} [ellipsis] overflow marker
 */
export function sanitizeText(value, maximum, ellipsis = '\u2026') {
  let text = String(value ?? '').replace(UNSAFE_CHARACTERS, ' ').replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (maximum > 0 && text.length > maximum) {
    text = `${text.slice(0, Math.max(0, maximum - ellipsis.length)).trimEnd()}${ellipsis}`;
  }
  return text;
}
