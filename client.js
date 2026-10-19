/**
 * dsh-notify — Web client half.
 *
 * The Host renders the notification text (title, body, outcome) and queues it
 * when this page is connected. This module detects a root session transitioning
 * from running to idle, claims the queued message through the authenticated
 * Host route, shows a native browser/Electron Notification, and reports whether
 * it was displayed. Clicking the notification focuses the app and opens the
 * finished session through the Client workspace service.
 */

window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory() {
    const LATEST_ROUTE = '/api/dsh-notify/latest';
    const ACK_ROUTE = '/api/dsh-notify/ack';
    const RETRY_DELAYS_MS = [150, 300, 500];
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    async function postJson(path, payload) {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    }

    /** Claim the queued decision for one session; the Host may not have stored it yet. */
    async function fetchDecision(sessionId) {
      const attempts = RETRY_DELAYS_MS.length + 1;
      for (let index = 0; index < attempts; index += 1) {
        const payload = await postJson(LATEST_ROUTE, { sessionId });
        if (payload?.ok === true && payload.value) return payload.value;
        if (index < attempts - 1) await sleep(RETRY_DELAYS_MS[index]);
      }
      return null;
    }

    function acknowledge(sessionId, shown) {
      void postJson(ACK_ROUTE, { sessionId, shown });
    }

    async function notifyFinishedSession(ctx, sessionId) {
      const decision = await fetchDecision(sessionId);
      if (!decision) return;

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
        notification = new Notification(decision.title || 'DeepSeek Harness', {
          body: decision.body || '',
          tag: `dsh-notify:${sessionId}`,
          renotify: true,
          silent: false,
        });
      } catch {
        acknowledge(sessionId, false);
        return;
      }

      notification.onclick = () => {
        try {
          window.focus();
        } catch {
          // Focus is best-effort; Electron usually activates the app itself.
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
      inject: ['sessions', 'uiWorkspace'],
      apply(ctx) {
        const sessions = ctx.sessions;
        /** @type {Map<string, { running?: boolean, origin?: string, parentSessionId?: string }> | null} */
        let previous = null;
        let disposed = false;

        const update = () => {
          if (disposed) return;
          let snapshot;
          try {
            snapshot = sessions.list.getSnapshot();
          } catch {
            return;
          }
          const next = new Map();
          for (const id of snapshot?.ids ?? []) {
            const summary = snapshot?.byId?.[id];
            if (summary) next.set(String(id), summary);
          }

          // Notify only on a real running → idle transition observed while this
          // client was attached; the initial load is a silent baseline.
          if (previous !== null) {
            for (const [id, summary] of next) {
              const before = previous.get(id);
              if (!before || before.running !== true || summary.running !== false) continue;
              if (summary.origin === 'subagent' || summary.parentSessionId) continue;
              void notifyFinishedSession(ctx, id);
            }
          }
          previous = next;
        };

        ctx.effect(() => {
          const unsubscribe = sessions.list.subscribe(update);
          return () => {
            disposed = true;
            unsubscribe();
          };
        });
        update();
      },
    };
  },
});
