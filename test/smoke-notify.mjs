#!/usr/bin/env node
/**
 * Send one real notification through the same code path the plugin uses.
 * Useful after installation to confirm the OS notification channel works.
 *
 *   node test/smoke-notify.mjs
 *   node test/smoke-notify.mjs --zh
 *   DSH_NOTIFY_SOUND=Ping node test/smoke-notify.mjs
 */

import { normalizeConfig, resolveLocale, statusLabel } from '../lib/config.js';
import { buildNotificationCommand, resolveChannel, resolveSound, runNotification } from '../lib/notify.js';

const config = normalizeConfig({
  locale: process.argv.includes('--zh') ? 'zh' : 'auto',
  sound: process.env.DSH_NOTIFY_SOUND ?? 'Glass',
  debug: true,
});
const locale = resolveLocale(config);
const channel = resolveChannel(config);
const sound = channel === 'osascript' ? resolveSound(config) : '';

if (channel === 'none') {
  console.error('dsh-notify: no supported notification channel on this platform (macOS or Linux required).');
  process.exit(1);
}

const spec = buildNotificationCommand(channel, {
  title: 'DeepSeek Harness',
  body: `dsh-notify smoke test · ${statusLabel('completed', locale)}`,
  sound,
});

const result = await runNotification(spec, { timeoutMs: config.timeoutMs });
if (result.ok) {
  console.log(`dsh-notify: sent via ${channel}${sound ? ` (sound: ${sound})` : ''}`);
  process.exit(0);
}
console.error(`dsh-notify: delivery failed: ${result.error ?? 'unknown error'}`);
process.exit(1);
