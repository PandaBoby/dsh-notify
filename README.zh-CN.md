# dsh-notify

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话提供系统原生的任务完成通知。

DeepSeek Harness 本身没有“任务已完成”的提示。`dsh-notify` 是一个小型 Cordis 插件：它监听持久化的会话日志，在一轮任务完成、失败或被取消时弹出操作系统通知，让你切到别的窗口后也能及时知道该回来了。

[English README](./README.md)

## 功能

- **轮次结束通知**：订阅持久化的 `session/event` 事件流（`turn/end`），不做轮询。
- **区分任务结果**：`completed`、`error`、`aborted`、`interrupted`、`max-tokens`、`blocked`、`forked`。
- **丰富的消息变量**：会话标题、耗时、回复摘要等均可写入模板。
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

4. 结束任意一轮 DSH 任务，轮次关闭时应收到通知。

## 配置

bundle patch 只负责插入插件行；自定义配置时，编辑该行的 `config`（在 profile patch 中以 `id: dsh-notify` 覆盖，或取消本包 `cordis.patch.yml` 中的注释）。未写的键始终回退到下面的默认值，因此可以只覆盖部分字段。

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
| `timeoutMs` | number | `5000` | 通知命令超时后强制结束。 |
| `audit` | boolean | `true` | 是否写入本地审计日志。 |
| `auditPath` | string | `""` | 自定义审计日志路径，支持 `~` 展开。 |
| `debug` | boolean | `false` | 通过 `ctx.logger.debug` 输出渲染结果与投递细节。 |

### 消息模板

`titleTemplate` 与 `bodyTemplate` 支持以下占位符：

| 占位符 | 内容 |
| --- | --- |
| `{session}` / `{title}` | 会话标题（优先取日志标题，否则用工作目录名）。 |
| `{workspace}` | 会话工作目录的文件夹名。 |
| `{cwd}` | 完整工作目录。 |
| `{status}` | 本地化结果文案，如 `completed` / `任务完成`。 |
| `{emoji}` | 结果表情（✅ ❌ ⏹️ ⚠️ 🔶 ⛔ 🌿）。 |
| `{duration}` | 轮次耗时，如 `12秒`、`3分5秒`、`1小时2分5秒`。 |
| `{turn}` | 轮次编号。 |
| `{sessionId}` | 完整会话 id。 |
| `{reply}` | 本轮最后一条助手文本的摘要（按需读取）。 |
| `{error}` | `error` 结果对应的错误信息。 |

未知占位符会原样保留，方便发现模板拼写错误。文本会被清理并截断：标题 120 字符、正文 400 字符。

## 工作原理

1. 插件订阅 `session/event`，记录每个会话的 `turn/start` 时间。
2. 收到 `turn/end` 后，按 `notifyOn` 过滤结果；默认跳过委派会话，并应用 `minDurationMs` 与 `maxPerMinute`。
3. 通过可选的 `sessionTitle` 服务读取会话标题；不可用时回退到工作目录名。
4. 渲染模板，并以 `argv` 方式启动平台通知命令（不经过 shell）。
5. 向审计日志追加一行 JSON 后立即返回，通知投递不会阻塞 Harness 的轮次关闭。

插件只读取会话日志，不向其中追加任何内容。

## 平台说明

### macOS

`display notification` 通过 `osascript` 发送，因此 macOS 会把通知归属为 **脚本编辑器（Script Editor）**。如果没有看到横幅：

1. 打开 **系统设置 → 通知 → 脚本编辑器**，允许通知。
2. 确认没有开启专注模式 / 勿扰模式。
3. 运行 `node test/smoke-notify.mjs`，并查看审计日志（默认 `~/.dsh/dsh-notify/audit.jsonl`）。

提示音可选 `ls /System/Library/Sounds` 中的名称（如 `Glass`、`Ping`、`Submarine`）；未知名称会被忽略，通知静音发送。

### Linux

需要 libnotify 的 `notify-send` 以及正在运行的通知守护进程。无桌面的服务器或 SSH 会话没有守护进程，请设置 `channel: none`。

### Windows

v1 不包含零依赖的 toast 通道：`channel: auto` 会解析为 `none` 并只记录一条警告。如需支持，可贡献 PowerShell/WinRT 通道。

## 审计日志

开启 `audit`（默认开启）时，每次投递尝试都会向 `$DSH_HOME/dsh-notify/audit.jsonl`（默认为 `~/.dsh/dsh-notify/audit.jsonl`）追加一行 JSON。记录包含渲染后的标题/正文、通道、结果原因、会话 id/标题、工作目录、轮次、耗时与投递结果。文件权限为 `0600`，超过 512 KiB 时轮转为 `audit.jsonl.1`。

通知文本可能包含会话标题或助手回复摘要，但日志只保存在本机。如需关闭，设置 `audit: false` 或将 `auditPath` 指向别处。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 没有通知，审计显示 `no supported notification channel` | 平台是否为 macOS/Linux，`channel` 是否被设为 `none`。 |
| 审计显示 `failed` | 运行 `node test/smoke-notify.mjs`，看最后一行审计的 `error`。 |
| 审计日志没有记录 | 插件行可能未激活，或 `audit`/`enabled` 被关闭。查看 Plugins 页面与 Host 日志中的 `dsh-notify: active`。 |
| 每轮短任务都弹通知 | 调大 `minDurationMs`，或收窄 `notifyOn`。 |
| Agent Teams 期间通知过多 | 保持 `includeSubagents: false`（默认），或调低 `maxPerMinute`。 |
| 正在看聊天时也会弹通知 | v1 无法感知窗口焦点，Host 进程看不到窗口是否在前台。 |

## 开发

```sh
node --test test/          # 单元 + 集成测试（24 个用例）
node test/smoke-notify.mjs # 通过同一代码路径发送真实通知
```

本包没有构建步骤、没有依赖：`index.js` 是 Host 入口；`lib/config.js` 负责配置归一化、语言与模板；`lib/decide.js` 是纯通知决策；`lib/notify.js` 构建并执行平台命令；`lib/runtime.js` 把二者接线。

## 卸载

通过插件管理器移除 `dsh-notify` bundle（或调用 `plugin_manager` 的 `remove_bundle`，`target` 填 `dsh-notify`）。如果结果提示 `restart-required`，重启 Harness。

## 许可

MIT © 2026 PandaBoby
