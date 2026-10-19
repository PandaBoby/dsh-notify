# dsh-notify

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话提供系统原生的任务完成通知。

DeepSeek Harness 本身没有“任务已完成”的提示。`dsh-notify` 是一个小型 Cordis 插件：它监听持久化的会话日志，在一轮任务完成、失败或被取消时弹出操作系统通知，让你切到别的窗口后也能及时知道该回来了。

[English README](./README.md)

## 功能

- **轮次结束通知**：订阅持久化的 `session/event` 事件流（`turn/end`），不做轮询。
- **可点击通知**：连接 DSH Web/桌面客户端时，点击通知会聚焦应用并打开刚结束的会话。
- **区分任务结果**：`completed`、`error`、`aborted`、`interrupted`、`max-tokens`、`blocked`。
- **丰富的消息变量**：会话标题、耗时、回复摘要等均可写入模板（基于实时事件；插件激活前已开始的轮次没有耗时/回复摘要）。
- **默认只通知根会话**：子智能体、Agent Teams 成员和工作流成员默认不打扰；可用 `includeSubagents` 打开。
- **macOS 通知中心**（`osascript`）与 **Linux**（`notify-send`）。
- **不经过 shell**：标题与正文以 `argv` 传入，引号、反引号、`$(...)` 都只会作为普通文本。
- **可配置**：提示音、语言、模板、限流、最短时长。
- **本地审计日志**：`$DSH_HOME/dsh-notify/audit.jsonl`，便于排查通知是否送达。
- **零运行时依赖**：纯 ESM + Node 内置模块。

## 环境要求

- 具备 Host 插件能力（`session/event`、`session/disposed`）的 DeepSeek Harness，已在 `0.2.1-rc.2` 上验证。
- macOS 12+，或带通知守护进程的 Linux 桌面。
- Node.js 20+（由 Harness 提供）。

Windows 目前没有零依赖的通知通道：`channel: auto` 会解析为 `none`，插件只记录一条警告，不会影响 Harness 运行。

## 安装

`dsh-notify` 是一个 profile bundle：只插入一条 Host 插件行，不含客户端代码。

1. 克隆仓库到固定位置：

   ```sh
   git clone https://github.com/PandaBoby/dsh-notify.git
   ```

2. 通过插件管理器安装 bundle：

   - 在 DSH Web UI 打开 **Settings → Plugins**，从本地目录安装该 bundle；或
   - 让 DSH 智能体调用 `plugin_manager` 工具的 `install_bundle` 动作，`target` 填本目录的绝对路径。

   插件管理器会把目录链接进当前 profile，并把 `dsh-notify` 加入 bundle 列表。通常通过 HMR 即时生效；替换已安装的旧副本时可能需要重启 Harness。

3. 单独验证系统通知通道：

   ```sh
   node test/smoke-notify.mjs
   node test/smoke-notify.mjs --zh   # 中文消息
   ```

4. 结束任意一轮 DSH 任务，轮次关闭时应收到通知。如果安装前客户端页面已经打开，请刷新一次以加载新的客户端 bundle；Host 端回退通道会立即生效。

## 配置

bundle patch 只负责插入插件行；自定义配置时，把本包 `cordis.patch.yml` 中的空 `config: {}` 替换为你的配置（或在 profile patch 中以 `id: dsh-notify` 覆盖）。未写的键始终回退到下面的默认值，因此可以只覆盖部分字段。

```yaml
- id: dsh-notify
  name: dsh-notify
  config:
    sound: Glass
    notifyOn: [completed, error, aborted]
    bodyTemplate: "{emoji} {session} · {status}\n{reply}"
```

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 关闭监听而不卸载插件。 |
| `channel` | string | `"auto"` | `auto`、`osascript`（macOS）、`notify-send`（Linux）或 `none`。 |
| `sound` | string | `"Glass"` | macOS 系统提示音名称（`/System/Library/Sounds` 下，不含 `.aiff`）；`""` 表示静音。 |
| `notifyOn` | string[] | `["completed", "error"]` | 触发通知的结束原因；`all` 表示全部，`[]` 表示全部不通知。 |
| `includeSubagents` | boolean | `false` | 同时通知子智能体、团队成员与工作流成员的轮次。 |
| `minDurationMs` | number | `0` | 短于该时长的轮次不通知；`0` 表示每轮都通知。 |
| `maxPerMinute` | number | `12` | 跨会话滑动窗口限流；`0` 表示关闭限流。 |
| `locale` | string | `"auto"` | `auto`、`en` 或 `zh`；`auto` 依次参考 `DSH_NOTIFY_LOCALE`、macOS 系统语言、`LC_ALL`/`LANG`、`Intl`。 |
| `titleTemplate` | string | `"DeepSeek Harness"` | 通知标题模板。 |
| `bodyTemplate` | string | `"{emoji} {session} · {status}"` | 通知正文模板，允许 `\n` 换行。 |
| `clientNotifications` | boolean | `true` | 连接 Web 客户端时，由客户端显示可点击通知；客户端无法显示时 Host 回退到系统通道。 |
| `clientFallbackMs` | number | `2500` | 等待客户端确认显示的宽限时间，超时后 Host 自行发送通知。 |
| `timeoutMs` | number | `5000` | 通知命令超时后强制结束。 |
| `audit` | boolean | `true` | 是否写入本地审计日志。 |
| `auditPath` | string | `""` | 自定义审计日志路径，支持 `~` 展开。 |
| `debug` | boolean | `false` | 通过 `ctx.logger.debug` 输出渲染结果与投递细节。 |

### 消息模板

`titleTemplate` 与 `bodyTemplate` 支持以下占位符：

| 占位符 | 内容 |
| --- | --- |
| `{session}` / `{title}` | 会话标题（优先取日志标题，否则用工作目录名）。 |
| `{workspace}` | 会话当前工作目录的文件夹名。 |
| `{cwd}` | 完整当前工作目录（跟随会话内目录切换）。 |
| `{status}` | 本地化结果文案，如 `completed` / `任务完成`。 |
| `{emoji}` | 结果表情（✅ ❌ ⏹️ ⚠️ 🔶 ⛔）。 |
| `{duration}` | 轮次耗时，如 `12秒`、`3分5秒`、`1小时2分5秒`；插件激活前已开始的轮次为空。 |
| `{turn}` | 轮次编号。 |
| `{sessionId}` | 完整会话 id。 |
| `{reply}` | 本轮实时事件中最后一条助手文本的摘要；不可用时为空。 |
| `{error}` | `error` 结果对应的错误信息。 |

未知占位符会原样保留，方便发现模板拼写错误。文本会被清理并截断：标题 120 字符、正文 400 字符。

## 工作原理

1. 插件订阅 `session/event`，记录每个会话的实时 `turn/start` 时间与最后一条 `assistant/message` 文本，不重扫会话日志。
2. 收到 `turn/end` 后，按 `notifyOn` 过滤结果；默认跳过委派会话，并应用 `minDurationMs`。
3. 通过可选的 `sessionTitle` 服务读取会话标题，通过可选的 `workingDirectory` 服务读取当前目录；不可用时回退到会话头信息。
4. 渲染模板，并在实际投递时应用滑动窗口限流。
5. **客户端通道**：`clientNotifications` 开启时，Host 暂存渲染结果；客户端检测到 running → idle 后，通过认证路由领取消息、显示可点击 Notification 并回执。点击通知会聚焦应用并调用 `uiWorkspace.openSession(sessionId)` 打开会话。若在 `clientFallbackMs` 内没有客户端领取并确认（或客户端明确无法显示），Host 改发系统通知。
6. **Host 通道**：`clientNotifications` 关闭时，或作为上述回退，Host 以 `argv` 方式启动平台通知命令（不经过 shell）。
7. 异步排队写入审计日志；Harness 的轮次关闭不会等待通知投递或磁盘 I/O。

插件只观察实时事件，不向会话日志追加任何内容。

## 平台说明

### macOS

连接 DSH 客户端时，通知由 Web/Electron 发出并归属 **DeepSeek Harness**；点击会聚焦应用并打开刚结束的会话。请在 **系统设置 → 通知 → DeepSeek Harness** 中允许通知。

没有客户端连接时，Host 回退到通过 `osascript` 发送 `display notification`，此时通知归属 **脚本编辑器（Script Editor）** 且没有点击动作。如果完全收不到通知：

1. 在 **系统设置 → 通知 → DeepSeek Harness**（客户端通道）或 **脚本编辑器**（Host 回退）中允许通知。
2. 确认没有开启专注模式 / 勿扰模式。
3. 运行 `node test/smoke-notify.mjs`，并查看审计日志（默认 `~/.dsh/dsh-notify/audit.jsonl`）。

提示音可选 `ls /System/Library/Sounds` 中的名称（如 `Glass`、`Ping`、`Submarine`）；未知名称会被忽略，通知静音发送。

### Linux

需要 libnotify 的 `notify-send` 以及正在运行的通知守护进程。无桌面的服务器或 SSH 会话没有守护进程，请设置 `channel: none`。

### Windows

v1 不包含零依赖的 toast 通道：`channel: auto` 会解析为 `none` 并只记录一条警告。如需支持，可贡献 PowerShell/WinRT 通道。

## 审计日志

开启 `audit`（默认开启）时，每次投递尝试都会异步追加一行 JSON 到 `$DSH_HOME/dsh-notify/audit.jsonl`（默认为 `~/.dsh/dsh-notify/audit.jsonl`）。记录包含渲染后的标题/正文、通道、结果原因、会话 id/标题、工作目录、轮次、耗时与投递结果。客户端半边激活时还会追加一条 `client-ready` 记录，便于判断客户端 bundle 是否加载。文件权限为 `0600`，超过 512 KiB 时轮转为 `audit.jsonl.1`。写入串行且为尽力而为：Host 在通知后立即退出时可能丢失最后一行。

通知文本可能包含会话标题或助手回复摘要，但日志只保存在本机。如需关闭，设置 `audit: false` 或将 `auditPath` 指向别处。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 没有通知，审计显示 `no supported notification channel` | 平台是否为 macOS/Linux，`channel` 是否被设为 `none`。 |
| 审计显示 `failed` | 运行 `node test/smoke-notify.mjs`，看最后一行审计的 `error`。 |
| 审计日志没有记录 | 插件行可能未激活，或 `audit`/`enabled` 被关闭。查看 Plugins 页面与 Host 日志中的 `dsh-notify: active`。 |
| 收不到可点击的 DeepSeek Harness 通知 | 保持 DSH 客户端页面打开、允许 DeepSeek Harness 通知、确认 `clientNotifications` 未被关闭，并在安装/更新后刷新一次页面。 |
| 通知来自「脚本编辑器」 | 当时没有客户端连接，或客户端未能在 `clientFallbackMs` 内显示；这是不可点击的 Host 回退通知。 |
| 点击通知没有反应 | 会话可能已被归档；否则检查通知权限与客户端控制台。 |
| 每轮短任务都弹通知 | 调大 `minDurationMs`，或收窄 `notifyOn`。 |
| Agent Teams 期间通知过多 | 保持 `includeSubagents: false`（默认），或调低 `maxPerMinute`。 |
| 正在看聊天时也会弹通知 | v1 无法感知窗口焦点，Host 进程看不到窗口是否在前台。 |

## 开发

```sh
node --test test/          # 单元 + 集成测试（36 个用例）
node test/smoke-notify.mjs # 通过同一代码路径发送真实通知
```

本包没有构建步骤、没有依赖：`index.js` 是 Host 入口；`client.js` 是 Web 客户端半边（可点击通知与导航）；`lib/config.js` 负责配置归一化、语言与模板；`lib/decide.js` 是纯通知决策；`lib/notify.js` 构建并执行平台命令；`lib/runtime.js` 把事件、客户端决策队列与 Host 回退串起来。

## 卸载

通过插件管理器移除 `dsh-notify` bundle（或调用 `plugin_manager` 的 `remove_bundle`，`target` 填 `dsh-notify`）。如果结果提示 `restart-required`，重启 Harness。

## 许可

MIT © 2026 PandaBoby
