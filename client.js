/**
 * dsh-notify — Web client half.
 *
 * The Host decides which turn-end events deserve a notification, renders the
 * text, and queues the decision. This client holds one authenticated long-poll
 * open against the Host; a queued decision wakes it immediately, so sessions
 * outside the current workspace (which never appear in the visible session
 * list) still produce clickable notifications. The client shows a native
 * Notification and reports whether it was displayed. Clicking focuses the app
 * and opens the finished session.
 */

window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory() {
    const WAIT_ROUTE = '/api/dsh-notify/wait';
    const ACK_ROUTE = '/api/dsh-notify/ack';
    const READY_ROUTE = '/api/dsh-notify/ready';
    const FOCUS_ROUTE = '/api/dsh-notify/focus';
    const EVENT_ROUTE = '/api/dsh-notify/event';
    const RETRY_DELAY_MS = 1_500;
    const NOTIFICATION_LIFETIME_MS = 5 * 60_000;
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    /**
     * Keep constructed notifications alive until they close. Some Electron
     * Windows builds tie the toast to the JS wrapper; a notification that is
     * only reachable through its own onclick cycle can be garbage-collected
     * before Windows displays it.
     * @type {Set<Notification>}
     */
    const activeNotifications = new Set();

    async function postJson(path, payload, signal) {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    }

    function acknowledge(sessionId, shown) {
      void postJson(ACK_ROUTE, { sessionId, shown });
    }

    /** Report a client-side notification lifecycle event for troubleshooting. */
    function reportEvent(sessionId, event, detail) {
      void postJson(EVENT_ROUTE, { sessionId, event, detail });
    }

    function closeActiveNotifications() {
      for (const notification of activeNotifications) {
        try {
          notification.close();
        } catch {
          // Already closed.
        }
      }
      activeNotifications.clear();
    }

    /** Show one Host-rendered decision as a clickable notification. */
    async function showDecision(ctx, decision) {
      const sessionId = decision?.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') return;

      if (typeof Notification !== 'function') {
        acknowledge(sessionId, false);
        return;
      }

      let permission = Notification.permission;
      if (permission === 'default') {
        try {
          permission = await Notification.requestPermission();
        } catch {
          permission = 'denied';
        }
      }
      if (permission !== 'granted') {
        acknowledge(sessionId, false);
        return;
      }

      let notification;
      try {
        // Keep the option set minimal. `tag`/`renotify` are not reliably
        // supported by every Electron Windows build and were observed to
        // suppress the toast; the title/body are plain strings.
        notification = new Notification(decision.title || 'DeepSeek Harness', {
          body: decision.body || '',
        });
      } catch {
        acknowledge(sessionId, false);
        reportEvent(sessionId, 'notification-error', 'constructor threw');
        return;
      }

      activeNotifications.add(notification);
      const release = () => {
        activeNotifications.delete(notification);
      };
      const lifetime = setTimeout(release, NOTIFICATION_LIFETIME_MS);
      if (typeof lifetime.unref === 'function') lifetime.unref();
      notification.onshow = () => reportEvent(sessionId, 'notification-shown');
      notification.onerror = (event) =>
        reportEvent(sessionId, 'notification-error', String(event?.message ?? event ?? 'unknown'));
      notification.onclose = () => {
        clearTimeout(lifetime);
        release();
      };

      notification.onclick = () => {
        // A renderer cannot raise its own OS window reliably. The Host opens
        // the shell's dsh://open deep link, whose handler restores/focuses the
        // real window; then this page navigates to the finished session.
        void postJson(FOCUS_ROUTE, { sessionId, href: location.href });
        try {
          window.focus();
        } catch {
          // Secondary best-effort; the deep link above owns activation.
        }
        try {
          ctx.uiWorkspace.openSession(sessionId);
        } catch {
          // The session may have been archived between completion and click.
        }
        try {
          notification.close();
        } catch {
          // Already closed.
        }
      };
      acknowledge(sessionId, true);
    }

    return {
      inject: ['uiWorkspace'],
      apply(ctx) {
        const controller = new AbortController();
        let disposed = false;

        const pump = async () => {
          while (!disposed) {
            const payload = await postJson(WAIT_ROUTE, {}, controller.signal);
            if (disposed) return;
            if (payload?.ok === true && Array.isArray(payload.value)) {
              for (const decision of payload.value) await showDecision(ctx, decision);
              continue;
            }
            // Transport problem or an aborted request: back off, then reconnect.
            if (!payload) await sleep(RETRY_DELAY_MS);
          }
        };

        ctx.effect(() => {
          void pump();
          return () => {
            disposed = true;
            controller.abort();
            closeActiveNotifications();
          };
        });

        void postJson(READY_ROUTE, {
          href: location.href,
          permission: typeof Notification === 'function' ? Notification.permission : 'unsupported',
        });
      },
    };
  },
});
