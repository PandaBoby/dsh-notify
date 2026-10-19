/**
 * dsh-notify — native task-completion notifications for DeepSeek Harness.
 *
 * The plugin listens to the durable `session/event` feed, and on `turn/end`
 * renders a short message from the session title, turn outcome and elapsed time.
 * Delivery uses the OS notification center (macOS `osascript`, Linux
 * `notify-send`) without a shell, so titles and bodies are never interpreted.
 *
 * Configuration lives in the bundle row config; see README.md for every key.
 */

import { normalizeConfig } from './lib/config.js';
import { createRuntime } from './lib/runtime.js';

export const name = 'dsh-notify';

/**
 * Cordis plugin entry point.
 * @param {object} ctx plugin context
 * @param {unknown} rawConfig loader-row config
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  if (!config.enabled) {
    ctx?.logger?.info?.('dsh-notify: disabled by config');
    return;
  }

  const runtime = createRuntime({ ctx, config });

  ctx.on('session/event', runtime.onSessionEvent);
  ctx.on('session/disposed', runtime.onSessionDisposed);

  ctx?.logger?.info?.(`dsh-notify: active (channel=${runtime.channel}, locale=${runtime.locale})`);
}
