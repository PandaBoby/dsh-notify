# dsh-notify

Native task-completion notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions.

DeepSeek Harness has no built-in "your task is done" signal. `dsh-notify` is a small Cordis plugin that watches the durable session log and raises an operating-system notification when a turn finishes, fails, or is cancelled — so you can switch to another window and still know when to come back.

[中文说明](./README.zh-CN.md)

## Features

- **Turn-end notifications** from the durable `session/event` feed (`turn/end`), not a poller.
- **Clickable notifications** when the DSH Web/desktop client is attached: clicking the banner focuses the app and opens the finished session.
- **Outcome-aware messages** for `completed`, `error`, `aborted`, `interrupted`, `max-tokens` and `blocked`.
- **Duration, session title and reply preview** available as template placeholders, built from live events (a turn that began before the plugin activated has no duration or reply preview).
- **Root sessions only by default**; subagent, teammate and workflow member sessions are skipped unless `includeSubagents` is enabled.
- **macOS Notification Center** via `osascript` and **Linux** via `notify-send`.
- **No shell**: titles and bodies are passed as `argv`, so quotes, backticks and `$(...)` stay literal.
- **Configurable** sound, locale, templates, rate limit and minimum turn duration.
- **Local audit trail** at `$DSH_HOME/dsh-notify/audit.jsonl` for diagnosing delivery.
- **Zero runtime dependencies** — plain ESM and Node built-ins only.

## Requirements

- DeepSeek Harness with the Host plugin surface (`session/event`, `session/disposed`), tested on `0.2.1-rc.2`.
- macOS 12+ or a Linux desktop with a notification daemon.
- Node.js 20+ (provided by the Harness).

Windows currently has no dependency-free notification channel; `channel: auto` resolves to `none` there and the plugin logs one warning instead of failing.

## Install

`dsh-notify` is a profile bundle: it inserts one Host row and ships no client code.

1. Clone this repository somewhere stable:

   ```sh
   git clone https://github.com/PandaBoby/dsh-notify.git
   ```

2. Install the bundle into the running DSH profile with the Plugin Manager:

   - In the DSH Web UI, open **Settings → Plugins** and install the bundle from the checkout directory, or
   - ask the DSH agent to run the `plugin_manager` tool with `action: install_bundle` and the absolute path to this directory.

   The manager links the directory into the profile and adds `dsh-notify` to the profile bundle list. The Host half activates through HMR in most cases; a version that adds or changes the client half requires **one full DeepSeek Harness restart** (quit and reopen the app), because the Web client plugin graph is composed at app boot. Host-only fallback notifications work before that restart.

3. Verify the OS channel independently:

   ```sh
   node test/smoke-notify.mjs
   node test/smoke-notify.mjs --zh   # Chinese message
   ```

4. End any DSH turn. When the turn closes you should receive the notification. Clickable notifications require the one-time app restart described above; after it, the audit log contains a `client-ready` line and the banner comes from DeepSeek Harness.

## Configuration

The bundle patch inserts the row; customize it by replacing the empty `config: {}` in this package's `cordis.patch.yml` (or in a profile patch targeting `id: dsh-notify`). Missing keys always fall back to the defaults below, so a partial override is safe.

```yaml
- id: dsh-notify
  name: dsh-notify
  config:
    sound: Glass
    notifyOn: [completed, error, aborted]
    bodyTemplate: "{emoji} {session} · {status}\n{reply}"
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Turn the plugin's listener off without uninstalling it. |
| `channel` | string | `"auto"` | `auto`, `osascript` (macOS), `notify-send` (Linux) or `none`. |
| `sound` | string | `"Glass"` | macOS system sound name from `/System/Library/Sounds` (without `.aiff`). `""` disables sound. |
| `notifyOn` | string[] | `["completed", "error"]` | Turn-end reasons that notify. Use `all` for every reason, `[]` for none. || `includeSubagents` | boolean | `false` | Also notify for subagent, teammate and workflow-member turns. |
| `minDurationMs` | number | `0` | Skip turns shorter than this. `0` notifies every turn. |
| `maxPerMinute` | number | `12` | Sliding-window rate limit across all sessions. `0` disables it. |
| `locale` | string | `"auto"` | `auto`, `en` or `zh`. `auto` follows `DSH_NOTIFY_LOCALE`, the macOS system locale, `LC_ALL`/`LANG`, then `Intl`. |
| `titleTemplate` | string | `"DeepSeek Harness"` | Notification title template. |
| `bodyTemplate` | string | `"{emoji} {session} · {status}"` | Notification body template. `\n` is allowed. |
| `clientNotifications` | boolean | `true` | When a Web client is attached, let it show a clickable notification; the Host falls back to the OS channel if the client cannot display it. |
| `clientFallbackMs` | number | `2500` | Grace period for the client to confirm display before the Host sends its own notification. |
| `timeoutMs` | number | `5000` | Kill the notification command after this many milliseconds. |
| `audit` | boolean | `true` | Append delivery attempts to the audit log. |
| `auditPath` | string | `""` | Override the audit log path. `~` expands to the home directory. |
| `debug` | boolean | `false` | Log rendered notifications and delivery details through `ctx.logger.debug`. |

### Message templates

`titleTemplate` and `bodyTemplate` accept these placeholders:

| Placeholder | Value |
| --- | --- |
| `{session}` / `{title}` | Session title (log-backed title, else working-directory folder). |
| `{workspace}` | Folder name of the effective session working directory. |
| `{cwd}` | Full effective session working directory (tracks in-session directory changes). |
| `{status}` | Localized outcome label, e.g. `completed` / `任务完成`. |
| `{emoji}` | Outcome emoji (✅ ❌ ⏹️ ⚠️ 🔶 ⛔). |
| `{duration}` | Turn duration, e.g. `12s`, `3m 5s`, `1h 2m 5s`; empty when the turn began before the plugin was active. |
| `{turn}` | Turn number. |
| `{sessionId}` | Full session id. |
| `{reply}` | Preview of the last assistant text observed in the live feed for this turn; empty when unavailable. |
| `{error}` | Error message for `error` turns. |

Unknown placeholders stay verbatim so a typo is visible instead of silently disappearing. Text is sanitized and clamped to 120 characters for the title and 400 for the body.

## How it works

1. The plugin subscribes to `session/event` and records each session's live `turn/start` time and last `assistant/message` text. It never rescans a session log.
2. On `turn/end` it checks the outcome against `notifyOn`, skips delegated sessions unless configured otherwise, and honors `minDurationMs`.
3. It resolves the session title through the optional `sessionTitle` service and the effective directory through the optional `workingDirectory` service, falling back to the session header.
4. It renders the templates and applies the sliding-window rate limit at the point of a real delivery attempt.
5. **Client lane:** when `clientNotifications` is on, the Host queues the rendered message; the client detects the running → idle transition, claims the message over an authenticated route, shows a clickable Notification, and acknowledges. Clicking focuses the app and calls `uiWorkspace.openSession(sessionId)`. If no client claims and confirms within `clientFallbackMs` (or reports it cannot show one), the Host sends the OS notification instead.
6. **Host lane:** when `clientNotifications` is off, or as the fallback above, the Host spawns the platform notification command with `argv` (never a shell).
7. It queues one JSON line for the audit log asynchronously; the Host turn never waits for notification delivery or disk I/O.

Nothing is appended to the session log; the plugin only observes live events.

## Platform notes

### macOS

With the DSH client attached, the banner is a Web/Electron notification attributed to **DeepSeek Harness**; clicking it focuses the app and opens the finished session. Allow notifications for DeepSeek Harness in **System Settings → Notifications**.

Without an attached client, the Host falls back to `display notification` through `osascript`, so macOS attributes that banner to **Script Editor** and it has no click action. If no banner appears at all:

1. Open **System Settings → Notifications → DeepSeek Harness** (client lane) or **Script Editor** (host fallback) and allow notifications.
2. Check that Focus / Do Not Disturb is off.
3. Run `node test/smoke-notify.mjs` and check the audit log (`~/.dsh/dsh-notify/audit.jsonl` by default).

Use a sound name from `ls /System/Library/Sounds` (for example `Glass`, `Ping`, `Submarine`). An unknown name is ignored and the notification is sent silently.

### Linux

Requires `notify-send` from libnotify and a running notification daemon. Headless servers and SSH sessions have no daemon; set `channel: none` there.

### Windows

No dependency-free toast channel ships in v1. `channel: auto` resolves to `none` and logs one warning. Contribute a PowerShell/WinRT channel if you need one.

## Audit log

When `audit` is enabled (default), each attempt is appended asynchronously as one JSON line to `$DSH_HOME/dsh-notify/audit.jsonl` (`~/.dsh/dsh-notify/audit.jsonl` unless `DSH_HOME` is set). Records contain the rendered title/body, channel, reason, session id/title, working directory, turn, duration and delivery result. A `client-ready` line is also appended when the Web client half activates, which makes a missing client bundle easy to diagnose. The file is created with `0600` and rotates to `audit.jsonl.1` at 512 KiB. Writes are serialized and best-effort: a line can be lost if the Host exits immediately after a notification.

Notification text can contain session titles or assistant reply snippets; the log stays local. Set `audit: false` or point `auditPath` elsewhere if you prefer.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No notification, audit says `no supported notification channel` | Platform is macOS/Linux and `channel` is not `none`. |
| Audit says `failed` | Run `node test/smoke-notify.mjs`; inspect `error` in the last audit line. |
| No clickable banner from DeepSeek Harness | Restart DeepSeek Harness once after installing (the client plugin graph is composed at app boot), keep the client page open, allow notifications for DeepSeek Harness, and confirm `clientNotifications` is not `false`. The audit log gets a `client-ready` line when the client half activates. |
| Banner appears from **Script Editor** | No client was attached, or the client could not show a notification within `clientFallbackMs`; this is the non-clickable host fallback. |
| Clicking the banner does nothing | The session may have been archived after it finished; otherwise check the notification permission and the client console. |
| Nothing in the audit log | The row may not be active, or `audit`/`enabled` is off. Check the Plugins page and the Host log for `dsh-notify: active`. |
| Notification appears for every short turn | Raise `minDurationMs` or narrow `notifyOn`. |
| Too many notifications during Agent Teams work | Keep `includeSubagents: false` (default) or lower `maxPerMinute`. |
| Notification while you are already watching the chat | v1 has no focus awareness; the Host process cannot see window focus. |

## Development

```sh
node --test test/          # unit + integration tests (36 cases)
node test/smoke-notify.mjs # real notification through the same code path
```

The package has no build step and no dependencies: `index.js` is the Host entry, `client.js` is the Web client half (clickable notifications and navigation), `lib/config.js` handles normalization/locales/templates, `lib/decide.js` is the pure notification decision, `lib/notify.js` builds and runs the platform command, and `lib/runtime.js` wires events, the client decision queue and host fallback together.

## Uninstall

Use the Plugin Manager to remove the `dsh-notify` bundle (or the `plugin_manager` tool with `action: remove_bundle`, target `dsh-notify`). Restart the Harness if the change reports `restart-required`.

## License

MIT © 2026 PandaBoby
