// 给上游 v0.2.0-r4 的 bridge.js 应用 WorkBuddy 后端补丁（5 处），生成扩展包 payload。
const fs = require('node:fs');

const p = require('node:path').join(__dirname, 'payload', 'src', 'bridge.js');
let text = fs.readFileSync(p, 'utf8');

const repl = [
  [
    "import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';",
    "import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';\nimport { createApiClient } from './wb-client.js';",
  ],
  [
    "// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。\n// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。\nconst REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];",
    "// 允许的思考强度取值。WorkBuddy 后端（CodeBuddy CLI）支持 off/low/medium/high/xhigh/max；\n// 这里取 DSH 与 WorkBuddy 都认的四个档位（off = 关闭思考，低延迟低消耗）。\nconst REASONING_EFFORT_OPTIONS = ['off', 'low', 'high', 'max'];",
  ],
  [
    "    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },",
    "    // agent 后端：dsh（默认）或 workbuddy（本机 WorkBuddy CLI headless，见 src/wb-client.js）\n    backend: String(file.backend ?? 'dsh').toLowerCase(),\n    // WorkBuddy 后端的配置段（cliPath/homeDir/model/permissionMode 等）\n    workbuddy: { ...(file.workbuddy ?? {}) },\n    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },",
  ],
  [
    "  // DSH 侧\n  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {\n    token: cfg.dsh.authToken,\n    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。\n    tokenExplicit: cfg.dsh.authTokenExplicit === true,\n    header: cfg.dsh.authHeader,\n    prefix: cfg.dsh.authPrefix,\n    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。\n    allowRemote: cfg.dsh.allowRemote === true\n  });",
    "  // agent 后端：'dsh'（DeepSeek Harness Web API）或 'workbuddy'（CodeBuddy CLI headless）。\n  // 两者对外暴露同一套接口面（见 src/wb-client.js 顶部说明），QQ 侧逻辑与后端无关。\n  const backend = String(cfg.backend ?? 'dsh').toLowerCase();\n  log('agent 后端：' + (backend === 'workbuddy' ? 'WorkBuddy（CLI headless）' : 'DSH（' + cfg.dsh.baseUrl + '）'));\n  const api = await createApiClient(cfg, { log });",
  ],
  [
    "    const provider = String(cfg.dsh?.provider || 'deepseek-official');\n    const model = String(cfg.dsh?.model || 'deepseek-flash');\n    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);\n    let lastError = null;\n    for (let attempt = 1; attempt <= 2; attempt += 1) {\n      try {\n        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');",
    "    // 模型/思考强度的来源按后端区分：\n    //   - workbuddy 后端：config.workbuddy.model / reasoningEffort（CLI 的 --model / --effort）\n    //   - dsh 后端：config.dsh.provider / model / reasoningEffort\n    // 写死 cfg.dsh.* 会导致切到 WorkBuddy 后 config.workbuddy.model 不生效。\n    const workbuddyBackend = String(cfg.backend ?? 'dsh').toLowerCase() === 'workbuddy';\n    const provider = workbuddyBackend ? 'workbuddy' : String(cfg.dsh?.provider || 'deepseek-official');\n    const model = workbuddyBackend\n      ? String(cfg.workbuddy?.model || cfg.dsh?.model || 'deepseek-v4.1-flash')\n      : String(cfg.dsh?.model || 'deepseek-flash');\n    const rawEffort = workbuddyBackend\n      ? String(cfg.workbuddy?.reasoningEffort ?? '')\n      : String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);\n    // WorkBuddy 后端留空 = 不传 --effort（用 CLI 默认）；非空则 off/low/medium/high/xhigh/max。\n    const effort = workbuddyBackend && rawEffort === '' ? undefined : (rawEffort || REASONING_EFFORT_DEFAULT);\n    let lastError = null;\n    for (let attempt = 1; attempt <= 2; attempt += 1) {\n      try {\n        const params = { sessionId, provider, model };\n        if (effort) params.reasoningEffort = effort;\n        const result = unwrap(await api.sessions.selectModel(params), 'session.selectModel');",
  ],
];

let applied = 0;
for (const [from, to] of repl) {
  const count = text.split(from).length - 1;
  if (count !== 1) {
    console.error(`匹配次数异常(${count})：${from.slice(0, 80)}`);
    process.exit(1);
  }
  text = text.replace(from, to);
  applied += 1;
}
fs.writeFileSync(p, text, 'utf8');
console.log(`已应用 ${applied} 处 WorkBuddy 补丁`);
