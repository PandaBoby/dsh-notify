/**
 * dsh-notify — native task-completion notifications for DeepSeek Harness.
 *
 * The plugin listens to the durable `session/event` feed, and on `turn/end`
 * renders a short message from the session title, turn outcome and elapsed time.
 *
 * When a Web client is connected, the client shows a clickable Notification
 * (clicking focuses the app and opens the finished session); the Host falls
 * back to `osascript`/`notify-send` if the client cannot display it. Without a
 * connected client, the OS notification channel is used directly.
 *
 * Configuration lives in the bundle row config; see README.md for every key.
 */

import { normalizeConfig } from './lib/config.js';
import { focusDshWindow } from './lib/focus.js';
import { createRuntime } from './lib/runtime.js';

export const name = 'dsh-notify';

async function readJson(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function reply(value) {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } });
}

/**
 * Register the authenticated routes used by the Web client half:
 * `latest` claims a queued decision, `ack` reports whether it was displayed,
 * `ready` records client activation and `focus` raises the desktop window when
 * a notification is clicked.
 * @param {object} ctx plugin context
 * @param {ReturnType<typeof createRuntime>} runtime notification runtime
 */
function registerClientRoutes(ctx, runtime) {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection');
    const register = connection?.fetch?.register;
    if (typeof register !== 'function') {
      ctx.logger?.warn?.('dsh-notify: connection.fetch is unavailable; client notifications disabled');
      return;
    }
    const bind = register.bind(connection.fetch);

    const registerRoute = (route, label) => {
      try {
        const dispose = bind(route, label);
        return typeof dispose === 'function' ? dispose : undefined;
      } catch (error) {
        ctx.logger?.warn?.(`dsh-notify: failed to register ${label}: ${String(error?.message ?? error)}`);
        return undefined;
      }
    };

    scope.effect(() => {
      const disposers = [
        registerRoute(
          {
            path: '/api/dsh-notify/ready',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              try {
                const body = await readJson(request);
                runtime.markClientReady(body);
                return reply({ ok: true });
              } catch (error) {
                return reply({ ok: false, error: String(error?.message ?? error) });
              }
            },
          },
          'dsh-notify: client ready',
        ),
        registerRoute(
          {
            path: '/api/dsh-notify/latest',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              try {
                const body = await readJson(request);
                return reply({ ok: true, value: runtime.takeClientDecision(body.sessionId) });
              } catch (error) {
                return reply({ ok: false, error: String(error?.message ?? error) });
              }
            },
          },
          'dsh-notify: latest decision',
        ),
        registerRoute(
          {
            path: '/api/dsh-notify/event',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              try {
                const body = await readJson(request);
                return reply({ ok: true, accepted: runtime.markClientEvent(body) });
              } catch (error) {
                return reply({ ok: false, error: String(error?.message ?? error) });
              }
            },
          },
          'dsh-notify: client notification event',
        ),
        registerRoute(
          {
            path: '/api/dsh-notify/focus',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              try {
                const body = await readJson(request);
                const focused = focusDshWindow();
                runtime.markClientClick({ sessionId: body.sessionId, href: body.href, focused });
                return reply({ ok: true, focused });
              } catch (error) {
                return reply({ ok: false, error: String(error?.message ?? error) });
              }
            },
          },
          'dsh-notify: focus window',
        ),
        registerRoute(
          {
            path: '/api/dsh-notify/ack',
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              try {
                const body = await readJson(request);
                const accepted = runtime.ackClientDecision(body.sessionId, body.shown === true);
                return reply({ ok: true, accepted });
              } catch (error) {
                return reply({ ok: false, error: String(error?.message ?? error) });
              }
            },
          },
          'dsh-notify: client acknowledgement',
        ),
      ];
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            // Route already gone.
          }
        }
      };
    }, 'dsh-notify: client routes');
  });
}

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
  ctx.effect(() => () => runtime.dispose(), 'dsh-notify: pending client timers');

  if (config.clientNotifications) registerClientRoutes(ctx, runtime);

  ctx?.logger?.info?.(`dsh-notify: active (channel=${runtime.channel}, locale=${runtime.locale}, client=${config.clientNotifications})`);
}
