# qq-bridge × WorkBuddy 后端扩展

给 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 加一个可选后端：
**不装 DSH（DeepSeek Harness），改用 WorkBuddy 官方 CLI + 你自己的 WorkBuddy 账号额度来驱动 QQ 机器人。**

> 非腾讯官方项目。使用 WorkBuddy 额度驱动第三方聊天机器人可能违反相关服务条款，存在账号风控风险，
> 风险自负，请勿用于商业用途。本扩展只做"把 WorkBuddy CLI 变成桥接的 agent 后端"，不修改上游核心行为。

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| Windows 10/11 | 目前只在 Windows 验证 |
| Node.js 22+ | <https://nodejs.org/> |
| 原版 qq-bridge **v0.2.0-r4** | 从原作者仓库下载（`git clone` 或 Release zip）；本扩展按该版本适配 |
| SnowLuma | OneBot v11 服务端，自行安装配置（默认 WS `ws://127.0.0.1:3001`） |
| 已登录机器人 QQ 的 QQ 客户端 | 由 SnowLuma 接管 |
| WorkBuddy 账号 | 使用你自己的账号额度 |

## 安装

1. 下载原版 qq-bridge（v0.2.0-r4）并解压/克隆到任意目录，例如 `D:\qq-bridge`。
2. 下载本扩展的 zip 并解压到另一个目录（例如 `D:\qq-bridge-workbuddy-ext`）。
3. 在扩展目录打开 **PowerShell**，运行：
   ```powershell
   .\install.ps1
   ```
   如果提示脚本被禁，用：
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
4. 按向导完成：
   1. 指定 qq-bridge 目录（也可直接 `.\install.ps1 -target D:\qq-bridge`）
   2. 自动备份 `src/bridge.js` 并应用 WorkBuddy 补丁（新增 `src/wb-client.js` 等文件）
   3. 安装依赖 + 安装官方 CodeBuddy CLI（`@tencent-ai/codebuddy-code`）
   4. 登录 WorkBuddy（TUI 里 `/login` → 浏览器授权 → `/exit`）
   5. 填 QQ 号 / 群白名单 / SnowLuma 地址 / 模型（默认 `deepseek-v4.1-flash`）/ 思考强度（默认 `low`）
   6. 六项安全自检（问答、多回合、续聊、MCP 工具、图片、**工具越权拦截**）——6/6 通过才启动
5. 装好后桥接控制台：`http://127.0.0.1:3100`（token 在 qq-bridge 的 `state/console-token`）。

## 卸载

```powershell
.\uninstall.ps1 -target D:\qq-bridge
```

会恢复原版 `bridge.js` 备份、删除扩展新增文件；不会动 `config.json` 与 `state/`（登录态/CLI 在 `state/wb-cli`、`state/wb-home`，需要的话手动删）。

## 安全与设计说明

- 默认关闭 AI 的所有内置命令行/文件工具（只保留 QQ 收发与 MCP 工具），并往 CLI 的隔离 home 写
  `settings.permissions` 作为第二层拦截（实测 `--tools ""` 在完整版 CLI 上不可靠）。
- 扩展不包含任何账号凭据；登录由使用者本人完成，登录态保存在 qq-bridge 的 `state/wb-home/`。
- 上游 MIT License 保留（见 `LICENSE`）；本扩展对 `bridge.js` 的修改集中在 4 处：
  `wb-client` 导入、创建客户端、`loadConfig` 的 `backend`/`workbuddy` 字段、`ensureChatModel` 按后端选择模型。

## 常见问题

**Q：原版 qq-bridge 更新了怎么办？**
本扩展按 v0.2.0-r4 适配；上游更新后重装扩展可能覆盖新特性（安装器会先备份 `bridge.js` 并提示版本不符）。

**Q：机器人不回复？**
检查 SnowLuma 是否在线、qq-bridge 的 `state/bridge.log`、以及重跑 `node scripts/wb-selftest.mjs` 是否 6/6。

**Q：想换模型？**
改 qq-bridge 的 `config.json` → `workbuddy.model` / `workbuddy.reasoningEffort`，重启桥接。
