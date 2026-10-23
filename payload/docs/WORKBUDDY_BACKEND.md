# WorkBuddy 后端（backend: \"workbuddy\"）

桥接原本只支持 DSH（DeepSeek Harness）作为 agent 后端。本页说明如何切到 WorkBuddy 内置的
`codebuddy` CLI，以及两者的边界差异。

## 它做了什么

`config.json` 里的 `backend` 决定用哪个客户端：

```json
"backend": "dsh"        // 默认，行为与之前完全一致
"backend": "workbuddy"  // 走 src/wb-client.js
```

`src/wb-client.js` 把 CLI 的 headless 会话包装成 `bridge.js` 已在用的那套接口面：

```
api.sessions.{create,prompt,selectModel,list}   api.workspace.{create,rename,archiveSession}
api.events.{mux,follow,forget}                  api.settings.{describe,update}
api.agentPresets.list                           api.respond  api.callUnary  api.stopSessionWork
```

所以 QQ 侧（SnowLuma 连接、白名单、引用解析、表情/图片、人格注入、仿真模式、黑话学习、
控制台、token 账本）一行都没改。CLI 的事件被翻译成 DSH 的会话事件形状：
`turn/start` → `assistant/message` → `turn/end`，工具调用翻译成 `tool/call` / `tool/result`。

## 安全边界（与 RULES.md 一致）

QQ 群是不可信输入，而 CLI 默认带 Bash/文件/网络工具。适配层固定这样做：

| 措施 | 作用 |
|---|---|
| `--tools <SAFE_BUILTIN_TOOLS>` | 只放行 5 个无害内置工具（ToolSearch / DeferExecuteTool / ListMcpResources / ReadMcpResource / WaitForMcpServers），init 帧实测只剩 5 个 |
| `--permission-mode dontAsk` | 无人值守，避免回合挂在等人审批上（**注意**：它本身不拦 Bash，别把它当成唯一防线） |
| `--strict-mcp-config` + 只注入三个桥接自带 MCP | 只保留 QQ 收发/查询 + 只读联网搜索，绝不加载桌面端自己的 MCP/插件/skills（实测不加会把桌面端 weixinpay、sheetagent 带进来） |
| 环境变量白名单 | 只透传 PATH/TEMP 等系统变量 + 必须的 `CODEBUDDY_CONFIG_DIR`，桌面端的会话/代理变量一律不外泄 |

**`--tools ""` 是个坑**：在 2.173 里空串等于「不过滤」，内置工具全在，`dontAsk` 也拦不住，
`echo` 这类命令会被真的执行。适配层因此改用显式白名单，不要改回空串。

验证方式（必须在普通终端跑，WorkBuddy 自带的沙箱会干扰）：

```
node scripts/wb-tool-leak-test.mjs
```

判据是两条模型猜不出来的信号：标记只存在于环境变量 `LEAK_MARKER`（回复里出现即证明真执行了
`echo`），以及让它创建随机文件名后直接查文件系统。旧版把标记写进提示词（`echo TOOL_LEAK_xxx`），
模型复述一遍就会被误判成泄漏，所以才有过「时好时坏」的假阳性。

如果想让 AI 只有聊天能力（连 QQ 工具都不给），把 `workbuddy.mcpEnabled` 设为 `false`。

## 配置项

```json
"workbuddy": {
  "cliPath": "D:/workbuddy/resources/app.asar.unpacked/cli/bin/codebuddy",
  "nodePath": "D:/nvm/nodejs/node.exe",
  "homeDir": "<项目目录>/state/wb-home",  // CLI 专属 home（登录态在这）
  "configDir": "",                // 仅在 homeDir 留空时有意义
  "model": "glm-5.3-flash",
  "reasoningEffort": "",          // off/minimal/low/medium/high/max，空=用 CLI 默认
  "toolsMode": "empty",           // empty = --tools ""；denylist = 逐个拉黑内置工具
  "deniedTools": ["Bash", "Read", "..."],
  "permissionMode": "dontAsk",
  "sessionCwd": "",               // 空 = state/agents
  "usePresetPersona": true,       // 把 dsh/agent-presets/<preset> 的仿真层提示词注入 CLI
  "mcpEnabled": true,
  "turnTimeoutMs": 600000,
  "idleRecycleMs": 0,             // 0 = 不回收常驻进程；配毫秒数即启用空闲回收
  "maxSessions": 0,               // 0 = 不限制常驻会话数
  "logRaw": false                 // true 会把 CLI 原始事件打到日志（排查用）
}
```

`idleRecycleMs` / `maxSessions` 默认都是关闭的，字段保留着，随时可以打开。

## 登录：装完整版 CLI + 独立 home（一次性）

这是整个接入里最坑的一处，实测结论如下：

- 桌面端自带的 CLI 只有 `codebuddy-lite-wb.mjs`（精简 headless 产物），**没有 TUI**，
  所以它永远弹不出 `/login` 界面，只能报 `Authentication required`。
- 桌面端的登录态也借不来：令牌是 `$wbEncrypted` 信封（DPAPI），把 keyblob + auth 文件
  整份复制到另一套 home 也不行；借用桌面进程的网关环境变量同样无效。
- 认证目录按 `os.homedir()` 算（Windows 读 `USERPROFILE`），所以**给 CLI 一套自己的 home
  并自己登录一次**是唯一可行路径。

### 一条命令装好（推荐）

```
install.ps1            # 或： node scripts/setup-workbuddy.mjs
```

向导会：检查环境 → 装依赖 → 安装完整版 `@tencent-ai/codebuddy-code` 到
`state/wb-cli/` → 拉起 TUI 让你 `/login`（浏览器授权，用你自己的 WorkBuddy 账号，
消耗你自己的积分）→ 交互配置 QQ 号/群白名单 → 写 `config.json` → 跑六项自检 → 启动桥接。

登录态落在 `state/wb-home/AppData/Local/CodeBuddyExtension/Data/Public/auth/`，
文件名随产品版本变化（国内版 `workbuddy-desktop.info`，公开版
`Tencent-Cloud.coding-copilot.info`），所以只检查目录里有没有 `.info`。
`state/` 在 .gitignore 里，不会进仓库。

单独重跑登录：`npm run login:wb`。

## 先自检，再切换

```
npm run selftest:wb
```

必须在**普通终端**里跑：WorkBuddy 桌面端自己的沙箱会拦掉写入，在那里发起同样会失败。

产物在 `state/wb-selftest/`：`report.md`（人看）+ `*.jsonl`（机器看）。六项检查：
单次问答、常驻双回合、`--resume` 续聊、MCP 工具注入、图片输入、工具越权检查。
失败项会附 stderr 摘要，方便直接定位。

全部通过后，把 `config.json` 的 `backend` 改成 `workbuddy`，然后 `restart.bat`。
想回退就改回 `dsh`，DSH 侧没有任何改动。

## 差异与已知限制

- **成本**：切过去消耗的是 **WorkBuddy 账号积分**（已实测可用），不再是 `config.json` 里那套
  中转 key 的计费。控制台「令牌与花费」页仍按原价目表折算，数字只作参考。
- **提问/审批转发**：当前口径下 CLI 不会产生 `ask_user_question` / 审批事件，
  桥接的转发逻辑保持待命但不触发。AI 需要澄清时会在回复正文里直接问。
- **预设**：`qq-chat` / `qq-chat-v2` 的「行为与协议」提示词通过 `--append-system-prompt` 注入；
  「人格」仍由桥接按 `roles/*.md` 每条消息注入，两套机制都保留。
- **会话映射**：一个 QQ 会话对应一个常驻 CLI 进程（约 100~300MB）。进程退出后用
  `--resume` 接回同一 CLI 会话；桥接自己的 `state/sessions.json` 映射不变。

## 2026-10-23 修复记录（实机排障）

内置 WorkBuddy CLI 的发行版只有 `codebuddy-lite-wb.mjs`（精简 headless 产物），
**没有 TUI/headless 完整产物**，因此 `npm run login:wb` 的无参数 TUI 起不来，
`--serve` 的 Web UI 也未构建（页面写着 "Web UI is not built"），登录一直卡在
`Authentication required`。

修复：

1. **改用公开完整版 CLI**：`npm i @tencent-ai/codebuddy-code@2.173.0` 装到
   `<项目目录>/state/wb-cli`，config 指向
   `workbuddy.cliPath = <项目目录>/state/wb-cli/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`，
   并设 `workbuddy.forceLiteBundle = false`（完整版有 TUI/headless 产物，不能强制 lite）。
2. **登录**：用完整版 CLI 在隔离 home（`state/wb-home`）里跑 TUI，`/login` → 浏览器授权
   → `/exit`。登录态文件名是 `Tencent-Cloud.coding-copilot.info`（不是
   `workbuddy-desktop.info`），`ensureAuth()` 已改为检查目录内任意 `.info`。
3. **工具安全边界**（关键）：完整版 CLI 在 headless 下 `--tools ""` 空串**不生效**，
   `--disallowedTools` 也拦不住 PowerShell（实测模型能执行 `echo` 标记命令）。
   现在 `_buildArgs` 固定传 `--tools <SAFE_BUILTIN_TOOLS>`（只保留 ToolSearch /
   DeferExecuteTool / ListMcpResources / ReadMcpResource / WaitForMcpServers，
   MCP 工具不受影响），并由 `_ensureSecuritySettings()` 往隔离 home 的
   `.workbuddy/settings.json` 写 `permissions.deny` 全量内置工具作为第二层保险。
   自检第 6 项 + 确定性标记测试 5/5 均拦截。
4. **`bridge.js` `loadConfig()` 漏了 `backend` 与 `workbuddy` 字段**（切了 backend 仍走
   DSH 的根因），已补上。
5. **自检解析兼容完整版输出**：完整版 CLI 的 `--output-format json` 输出的是
   消息数组（user/assistant/result 帧），不是单对象；`wb-selftest.mjs` 的
   `parseCliJson()` 同时认两种形状。

维护提醒：CLI 升级/重装后 `lib/` 与 settings 可能被覆盖，需重新跑
`npm run selftest:wb`；登录态在 `state/wb-home`，换账号重新 `npm run login:wb`。
`state/` 已在 .gitignore 中。

### wb2（2026-10-23 晚）

- **修复模型来源**：nsureChatModel() 之前写死 cfg.dsh.model，导致切到 workbuddy 后端后
  config.workbuddy.model / reasoningEffort 不生效（会话仍用旧模型）。现在按 ackend 选择：
  workbuddy 读 config.workbuddy.*，dsh 读 config.dsh.*。
- **安装向导默认值**：默认模型改为 deepseek-v4.1-flash，新增思考强度询问
  （off/low/high/max，默认 low），写入 workbuddy.reasoningEffort。