// WorkBuddy 后端适配层（backend: "workbuddy"）。
//
// 为什么需要它：qq-bridge 原本是照着 DSH（DeepSeek Harness）的 Web 协议写的
// （离线铸造会话 Cookie、斜杠 RPC、`/api/remote.mux` 事件流、session/control 队列、
// projections 投影）。WorkBuddy 没有这套东西，但它内置的 codebuddy CLI 提供了
// 一条更适合的做法：`-p --input-format stream-json --output-format stream-json`
// 的常驻 headless 会话。
//
// 本模块把 CLI 的调用包装成 bridge.js 已经在用的那 8 个接口面：
//   api.sessions.{create,prompt,selectModel,list} / api.workspace.* / api.events.{mux,follow,forget}
//   api.respond / api.settings.* / api.agentPresets.list / api.callUnary / api.stopSessionWork
// 于是 QQ 侧（SnowLuma 连接、白名单、人格注入、仿真模式、黑话、控制台、token 账本）
// 一行都不用改。
//
// 安全边界（与 RULES.md 一致：QQ 群是不可信输入）：
//   * `--tools ""` —— 关掉全部内置工具（Bash / 读写文件 / 网络抓取 / 子代理……）
//   * `--strict-mcp-config` + 只注入桥接自带的三个安全 MCP server —— 绝不加载
//     用户自己的 MCP / 插件 / skills，避免桌面端配置把本机能力漏给 QQ 群
//   * `--permission-mode dontAsk` —— 无人值守，不存在“等人点通过”的窗口
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { extractPresetPrefix } from './preset-prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 默认 CLI 路径（空 = 必须由 config.workbuddy.cliPath 指定；安装向导会自动写入完整版 CLI 路径）。
// 历史默认值曾指向 WorkBuddy 桌面端内置 CLI（精简版，无 TUI、无法登录），已不再作为兜底。
export const DEFAULT_CLI_PATH = '';

/**
 * 允许 AI 使用的内置工具白名单：只保留 MCP 延迟调用所需的无副作用工具。
 * MCP 工具（mcp__snowluma__qq_* 等）不受 --tools 影响，仍然可用。
 */
export const SAFE_BUILTIN_TOOLS = 'ToolSearch,DeferExecuteTool,ListMcpResources,ReadMcpResource,WaitForMcpServers';

/** 只有这些环境变量会传给 CLI：桌面端/桥接自己的 CODEBUDDY_* 全都不外泄。 */
const PASSTHROUGH_ENV = [
  'PATH', 'Path', 'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'HOME', 'USERNAME', 'LOGONSERVER', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LC_ALL', 'OS'
];

/**
 * 构造 CLI 子进程的环境变量。
 *
 * 三个坑都是实测踩出来的：
 *  1. 直接继承 WorkBuddy 自己的 shell 环境不行 —— CODEBUDDY_SESSION_ID / CODEBUDDY_MCP_CONFIG /
 *     HTTP_PROXY 之类会挂到桌面会话上，行为不可控（伴随 setProxy 崩溃）。
 *  2. 完全干净的 env 也不行 —— CLI 把配置目录默认当作 ~/.codebuddy，找不到 keyblob 就解不开令牌。
 *  3. 就算把配置目录指到 ~/.workbuddy 也没用：桌面端的登录态（DPAPI 加密信封）在独立进程里
 *     解不出来，CLI 一律报 "Authentication required. Please use /login"。实测把 keyblob 和
 *     auth 文件一起复制到另一套 home 也不行。
 *
 * 因此正确做法是**给 CLI 一套自己的 home**（默认 state/wb-home），在里面用 `npm run login:wb`
 * 登录一次，之后令牌由 CLI 自己刷新，与桌面端互不干扰。认证目录由 os.homedir() 决定，
 * 所以这里必须同时改写 USERPROFILE/HOME/APPDATA/LOCALAPPDATA。
 *
 * forceLiteBundle：内置精简版 CLI（WorkBuddy 安装目录里的 cli/bin/codebuddy）只有
 * codebuddy-lite-wb 产物，必须强制走它；完整版 CLI（@tencent-ai/codebuddy-code，
 * 带 TUI/headless 产物）不需要强制，按 -p 等参数正常路由。默认 true 保持旧行为。
 */
export function buildCliEnv(extra = {}, { homeDir = '', configDir = '', forceLiteBundle = true } = {}) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value != null && value !== '') env[key] = value;
  }
  const wbHome = homeDir || '';
  const wbConfigDir = configDir || (wbHome ? path.join(wbHome, '.workbuddy') : path.join(os.homedir(), '.workbuddy'));
  Object.assign(env, {
    // 认证目录 = <homedir>/AppData/Local/CodeBuddyExtension/Data/Public/auth
    CODEBUDDY_CONFIG_DIR: wbConfigDir,
    WORKBUDDY_CONFIG_DIR: wbConfigDir,
    WORKBUDDY_USER_DATA_DIR: path.join(wbConfigDir, 'app'),
    // 内置精简版 CLI 的 dist 只发布 lite-wb 产物，不强制就 require('../dist/codebuddy') 报 MODULE_NOT_FOUND；
    // 完整版 CLI 不设置该变量（否则 TUI 会被迫走 lite 产物而静默退出）。
    ...(forceLiteBundle ? { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' } : {}),
    // 无人值守场景不需要 Git Bash 探测与 IDE 自动连接
    CODEBUDDY_SKIP_GIT_BASH_CHECK: '1',
    CODEBUDDY_DISABLE_IDE: '1',
    CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
    CODEBUDDY_DISABLE_BROWSER_MCP: '1',
    CODEBUDDY_DISABLE_CRON: '1',
    CODEBUDDY_DISABLE_SESSION_HISTORY_CLEANUP: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0'
  }, extra);
  if (wbHome) {
    env.HOME = wbHome;
    env.USERPROFILE = wbHome;
    env.HOMEDRIVE = path.parse(wbHome).root.replace(/\\$/, '');
    env.HOMEPATH = wbHome.slice(env.HOMEDRIVE.length) || '\\';
    env.APPDATA = path.join(wbHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(wbHome, 'AppData', 'Local');
    env.TEMP = path.join(wbHome, 'AppData', 'Local', 'Temp');
    env.TMP = env.TEMP;
  }
  return env;
}

/** 合并 config.workbuddy 与默认值。 */
export function resolveWorkbuddyOptions(cfg = {}) {
  const raw = cfg.workbuddy ?? {};
  const turnTimeoutMs = Number(raw.turnTimeoutMs);
  const idleRecycleMs = Number(raw.idleRecycleMs);
  return {
    cliPath: String(raw.cliPath || DEFAULT_CLI_PATH),
    nodePath: String(raw.nodePath || process.execPath),
    // CLI 的专属 home（认证目录、配置、会话都在里面，与桌面端完全隔离）；留空则用真实用户 home
    homeDir: raw.homeDir === '' ? '' : String(raw.homeDir || path.join(ROOT, 'state', 'wb-home')),
    // 桌面端的配置目录：仅在不使用隔离 home 时才有意义
    configDir: String(raw.configDir || ''),
    // 内置精简版 CLI（app.asar.unpacked 里）只有 lite-wb 产物，必须强制；完整版 CLI 正常路由。
    // 默认按 cliPath 判断，可用 config.workbuddy.forceLiteBundle 显式覆盖。
    forceLiteBundle: raw.forceLiteBundle === undefined
      ? /app\.asar(\.unpacked)?[\\/]+cli[\\/]+bin[\\/]+codebuddy$/i.test(String(raw.cliPath || DEFAULT_CLI_PATH))
      : raw.forceLiteBundle === true,
    model: String(raw.model || cfg.dsh?.model || 'deepseek-v4.1-flash'),
    reasoningEffort: String(raw.reasoningEffort || ''),
    // 工具口径：'empty' = --tools "" ；'denylist' = 逐个拉黑内置工具（保留 MCP 工具）
    toolsMode: raw.toolsMode === 'denylist' ? 'denylist' : 'empty',
    // 内置工具黑名单。完整版 CLI（2.173）的 init 帧会列出 60+ 个内置工具，`--tools ""`
    // 在完整版上实测拦不住 PowerShell（自检第 6 项跑出了 whoami 输出），所以必须显式拉黑
    // 所有内置工具名；MCP 工具（mcp__snowluma__qq_* 等）不在清单里、不受影响。
    deniedTools: Array.isArray(raw.deniedTools) && raw.deniedTools.length
      ? raw.deniedTools.map(String)
      : ['Agent', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'PowerShell',
        'WebFetch', 'WebSearch', 'Task', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'TaskOutput',
        'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'AskUserForStructuredInput', 'StructuredOutput',
        'Skill', 'SkillManage', 'Component', 'Mods', 'ToolSearch', 'DeferExecuteTool', 'SendMessage', 'SendUserMessage',
        'TeamCreate', 'TeamDelete', 'LSP', 'ImageGen', 'ViewImage', 'LibraryUpload', 'VideoGen', 'AudioTranscribe',
        'Artifact', 'ArtifactControl', 'EnterWorktree', 'LeaveWorktree', 'CronCreate', 'CronDelete', 'CronList',
        'WeChatReply', 'WeComReply', 'PushNotification', 'ReportFindings', 'ComputerUse', 'ListMcpResources',
        'ReadMcpResource', 'WaitForMcpServers', 'Workflow', 'Monitor', 'REPL', 'A2AGetAgentCard', 'A2ASendMessage',
        'A2AGetTask', 'A2ACancelTask', 'MessageColleague', 'SpeakInChannel', 'ChannelTasks', 'CreateColleague',
        'CreateChannel', 'ListColleagues', 'KillShell', 'BashOutput'],
    permissionMode: String(raw.permissionMode || 'dontAsk'),
    sessionCwd: String(raw.sessionCwd || path.join(ROOT, 'state', 'agents')),
    appendSystemPrompt: raw.appendSystemPrompt ? String(raw.appendSystemPrompt) : '',
    usePresetPersona: raw.usePresetPersona !== false,
    extraArgs: Array.isArray(raw.extraArgs) ? raw.extraArgs.map(String) : [],
    // 0 = 不回收常驻进程（默认）。保留字段，日后想省内存可直接配数值。
    idleRecycleMs: Number.isFinite(idleRecycleMs) && idleRecycleMs > 0 ? idleRecycleMs : 0,
    maxSessions: Number.isFinite(Number(raw.maxSessions)) && Number(raw.maxSessions) > 0 ? Number(raw.maxSessions) : 0,
    turnTimeoutMs: Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? turnTimeoutMs : 10 * 60 * 1000,
    mcpEnabled: raw.mcpEnabled !== false,
    logRaw: raw.logRaw === true
  };
}

const ok = (value) => ({ result: { ok: true, value: value ?? {} } });
const fail = (code, message) => ({ result: { ok: false, error: { code, message } } });
const nowMs = () => Date.now();

/** bridge 的 content 块 → CLI(Anthropic 风格) 的 content 块。 */
function mapContentBlocks(content) {
  const out = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      out.push({
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType || 'image/jpeg', data: block.data }
      });
      continue;
    }
    if (typeof block.text === 'string') out.push({ type: 'text', text: block.text });
  }
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}

/** 从 CLI 消息里抠出纯文本（兼容 message.content / content 两种形状）。 */
function textOfMessage(msg) {
  const blocks = msg?.message?.content ?? msg?.content;
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  let text = '';
  for (const block of blocks) {
    if (typeof block === 'string') { text += block; continue; }
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

function contentBlocksOf(msg) {
  const blocks = msg?.message?.content ?? msg?.content;
  return Array.isArray(blocks) ? blocks : [];
}

export class WbApiClient {
  constructor(cfg = {}, { log = () => {} } = {}) {
    this.cfg = cfg;
    this.opt = resolveWorkbuddyOptions(cfg);
    this.log = log;
    this._sessions = new Map(); // sessionId -> state
    this._followed = new Set();
    this._subscribers = new Set();
    this._settings = new Map(); // ns -> { user:{} }
    this._personaFiles = new Map(); // preset -> { file, mtimeMs }
    this._mcpConfigPath = null;
    this._closed = false;

    this.sessions = {
      create: (params) => this._createSession(params),
      prompt: (params) => this._prompt(params),
      selectModel: (params) => this._selectModel(params),
      list: () => this._listSessions()
    };
    this.workspace = {
      create: (params) => this._workspaceCreate(params),
      rename: async () => ok({}),
      archiveSession: ({ sessionId } = {}) => this._archiveSession(sessionId)
    };
    this.events = {
      follow: (sessionId) => { if (sessionId) this._followed.add(String(sessionId)); },
      forget: (sessionId) => { if (sessionId) this._followed.delete(String(sessionId)); },
      mux: () => this._mux()
    };
    this.settings = {
      describe: async () => this._describeSettings(),
      update: (params) => this._updateSettings(params)
    };
    this.agentPresets = {
      list: async () => ok({ presets: this._presetList() })
    };

    this._prepareMcpConfig();
    fs.mkdirSync(this.opt.sessionCwd, { recursive: true });
    if (this.opt.homeDir) {
      for (const dir of [
        this.opt.homeDir,
        path.join(this.opt.homeDir, 'AppData', 'Local', 'Temp'),
        path.join(this.opt.homeDir, 'AppData', 'Roaming'),
        path.join(this.opt.homeDir, '.workbuddy')
      ]) fs.mkdirSync(dir, { recursive: true });
    }
    this._ensureSecuritySettings();
    this.log(`WorkBuddy 后端就绪：CLI=${this.opt.cliPath} model=${this.opt.model} tools=${this.opt.toolsMode} home=${this.opt.homeDir || '(系统 home)'}`);
    if (this.opt.idleRecycleMs > 0) {
      this._recycler = setInterval(() => this._recycleIdle(), Math.min(this.opt.idleRecycleMs, 60000));
      this._recycler.unref?.();
    }
  }

  /**
   * 隔离 home 的 CLI 设置里写入权限白名单：只允许 MCP 工具与少量无副作用工具，
   * 其余内置工具（Bash/PowerShell/Read/Write/...）全部 deny。
   *
   * 为什么必须写 settings：实测完整版 CLI（2.173）在 headless 下 `--tools ""`
   * 不能可靠清空工具清单，`--disallowedTools` 也拦不住 PowerShell；只有
   * settings.permissions.deny 能稳定阻止 QQ 群友注入命令执行（自检第 6 项）。
   */
  _ensureSecuritySettings() {
    if (!this.opt.homeDir) return;
    const file = path.join(this.opt.homeDir, '.workbuddy', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) ?? {}; } catch { settings = {}; }
    const allow = ['mcp__*', 'DeferExecuteTool', 'ToolSearch', 'WaitForMcpServers', 'ListMcpResources', 'ReadMcpResource', 'AskUserQuestion'];
    const deny = [...this.opt.deniedTools];
    settings.permissions = { ...(settings.permissions ?? {}), allow, deny, defaultMode: 'dontAsk' };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.log(`写 CLI 权限设置失败（${error?.message ?? error}）；安全边界可能不完整`);
    }
  }

  // ── 鉴权/探活：CLI 用自己的 home 里的登录态（见 buildCliEnv 的说明）────────────
  async ensureAuth() {
    if (!fs.existsSync(this.opt.cliPath)) {
      throw new Error(`找不到 WorkBuddy CLI：${this.opt.cliPath}（请检查 config.json 的 workbuddy.cliPath）`);
    }
    if (this.opt.homeDir) {
      // 完整版 CLI 的登录文件名随产品变化（国内 WorkBuddy 是 workbuddy-desktop.info，
      // 公开版 CodeBuddy Code 是 Tencent-Cloud.coding-copilot.info），所以只看目录里有没有 .info。
      const authDir = path.join(this.opt.homeDir, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
      let hasAuthFile = false;
      try { hasAuthFile = fs.readdirSync(authDir).some((name) => name.endsWith('.info')); } catch { hasAuthFile = false; }
      if (!hasAuthFile) {
        throw new Error(`WorkBuddy CLI 还没登录（${authDir} 下没有 auth 文件）。请先在普通终端运行一次：npm run login:wb`);
      }
    }
    return true;
  }

  hasAuth() { return true; }

  invalidateAuth() { /* CLI 自带登录态，无需在此失效 */ }

  // ── 会话 ────────────────────────────────────────────────────────────────
  async _createSession(params = {}) {
    const sessionId = `wb-${crypto.randomUUID()}`;
    this._sessions.set(sessionId, {
      sessionId,
      cliSessionId: null,
      preset: typeof params.agentPreset === 'string' ? params.agentPreset : '',
      model: this.opt.model,
      effort: this.opt.reasoningEffort,
      cwd: this.opt.sessionCwd,
      queue: [],
      running: false,
      turnSeq: 0,
      turnText: '',
      turnStartedAt: 0,
      child: null,
      startedAt: nowMs(),
      lastUsedAt: nowMs(),
      toolsMode: this.opt.toolsMode
    });
    return ok({ sessionId });
  }

  _session(sessionId) {
    return this._sessions.get(String(sessionId ?? '')) ?? null;
  }

  async _selectModel({ sessionId, model, reasoningEffort } = {}) {
    const s = this._session(sessionId);
    if (!s) return fail('session/not-found', 'session not found');
    if (typeof model === 'string' && model) s.model = model;
    if (typeof reasoningEffort === 'string' && reasoningEffort) s.effort = reasoningEffort;
    // 模型是进程启动参数，切换后下一次 spawn/重启才真正生效；这里先把方案记下来。
    const previous = s.model;
    if (s.child && s.model !== previous) this._restartChild(s, 'model changed');
    return ok({ selected: { provider: 'workbuddy', model: s.model, reasoningEffort: s.effort || undefined } });
  }

  async _listSessions() {
    const items = [...this._sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      origin: 'root',
      createdAt: s.startedAt,
      lastUsedAt: s.lastUsedAt
    }));
    return ok({ items });
  }

  async _workspaceCreate({ path: dir } = {}) {
    return ok({ workspace: { workspaceId: 'qq-bridge-workbuddy', path: dir ?? this.opt.sessionCwd }, created: false });
  }

  async _archiveSession(sessionId) {
    const s = this._session(sessionId);
    if (!s) return ok({});
    this._killChild(s, 'archived');
    this._sessions.delete(String(sessionId));
    this._followed.delete(String(sessionId));
    return ok({});
  }

  async _prompt({ sessionId, content, mode } = {}) {
    const s = this._session(sessionId);
    if (!s) return fail('session/not-found', 'session not found');
    s.lastUsedAt = nowMs();
    s.queue.push({ content: mapContentBlocks(content), mode: mode ?? 'queue' });
    this._drain(s);
    return ok({});
  }

  async stopSessionWork(sessionId) {
    const s = this._session(sessionId);
    if (!s) return ok({});
    s.queue.length = 0;
    if (s.running) {
      // 正在跑的回合：杀掉进程让 `turn/end`（aborted）立刻发出，避免桥接判忙到租约过期。
      this._endTurn(s, { kind: 'aborted' });
      this._killChild(s, 'stopSessionWork');
    }
    return ok({});
  }

  // ── 事件流 ──────────────────────────────────────────────────────────────
  async *_mux() {
    const queue = [];
    let wake = null;
    const push = (envelope) => {
      if (wake) { const resolve = wake; wake = null; resolve(envelope); }
      else queue.push(envelope);
    };
    this._subscribers.add(push);
    try {
      while (!this._closed) {
        const envelope = queue.length ? queue.shift() : await new Promise((resolve) => { wake = resolve; });
        if (envelope === null || this._closed) break;
        yield envelope;
      }
    } finally {
      this._subscribers.delete(push);
    }
  }

  _emit(sessionId, event) {
    if (!this._followed.has(sessionId)) return;
    const envelope = { payload: { type: 'session/event', sessionId, event } };
    for (const push of this._subscribers) push(envelope);
  }

  // ── 设置（桥接模式 / ownerQQ 等）────────────────────────────────────────
  _describeSettings() {
    const namespaces = [...this._settings.entries()].map(([ns, value]) => ({
      ns,
      value: value.user,
      user: value.user,
      schema: { type: 'object', properties: {} }
    }));
    return ok({ namespaces });
  }

  async _updateSettings({ ns, patch } = {}) {
    if (!ns) return fail('settings/invalid', 'missing ns');
    const current = this._settings.get(ns) ?? { user: {} };
    current.user = { ...current.user, ...(patch ?? {}) };
    this._settings.set(ns, current);
    return ok({});
  }

  _presetList() {
    // 桥接的 fail-closed 校验只认这两个 id（见 bridge.js 的 strictPreset 分支）：
    // 报出来就等于承诺「这两个 preset 一定不带本地工具」——对 CLI 来说由 --tools 口径保证。
    return [
      { id: 'qq-chat', title: 'QQ 聊天（一代）', source: 'workbuddy' },
      { id: 'qq-chat-v2', title: 'QQ 聊天（二代仿真）', source: 'workbuddy' }
    ];
  }

  async callUnary(method, payload) {
    switch (String(method)) {
      case 'session/modelCatalog':
      case 'session/models':
        return ok({
          models: [
            { id: 'deepseek-v4.1-flash', provider: 'workbuddy', label: 'DeepSeek-V4.1-Flash', multimodal: true },
            { id: 'deepseek-v4-pro', provider: 'workbuddy', label: 'DeepSeek-V4-Pro', multimodal: true },
            { id: 'glm-5.3-flash', provider: 'workbuddy', label: 'GLM-5.3-Flash', multimodal: true },
            { id: 'glm-5.3', provider: 'workbuddy', label: 'GLM-5.3', multimodal: true },
            { id: 'kimi-k3-1', provider: 'workbuddy', label: 'Kimi-K3.1', multimodal: true }
          ],
          reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
          payload
        });
      default:
        return fail('rpc/unsupported', `workbuddy backend 不支持 ${method}`);
    }
  }

  // ── 提问/审批：--tools "" + dontAsk 下不会产生，回执按空处理 ──────────────
  async respond(payload = {}) {
    this.log(`收到提问/审批回执（WorkBuddy 后端不产生此类事件，忽略）: ${payload.eventId ?? payload.rpcId ?? '-'}`);
    return ok({});
  }

  // ── CLI 进程管理 ────────────────────────────────────────────────────────
  _prepareMcpConfig() {
    if (!this.opt.mcpEnabled) return;
    const dir = path.join(ROOT, 'state', 'wb');
    fs.mkdirSync(dir, { recursive: true });
    const servers = {
      snowluma: path.join(ROOT, 'src', 'mcp-snowluma-safe.js'),
      'snowluma-host': path.join(ROOT, 'src', 'mcp-host-server.js'),
      'web-search-safe': path.join(ROOT, 'src', 'mcp-web-search-safe.js')
    };
    const mcpServers = {};
    for (const [name, script] of Object.entries(servers)) {
      if (!fs.existsSync(script)) continue;
      mcpServers[name] = {
        command: this.opt.nodePath,
        args: [script],
        env: { QQ_BRIDGE_ROOT: ROOT }
      };
    }
    const file = path.join(dir, 'mcp-config.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers }, null, 2), 'utf8');
    this._mcpConfigPath = file;
  }

  /** 取 preset 的「仿真层」提示词正文（以 --append-system-prompt 内联传入）。 */
  _personaTextFor(preset) {
    if (!this.opt.usePresetPersona || !preset) return this.opt.appendSystemPrompt || '';
    if (this.opt.appendSystemPrompt) return this.opt.appendSystemPrompt;
    const cached = this._personaFiles.get(preset);
    const src = path.join(ROOT, 'dsh', 'agent-presets', preset, 'agent.cordis.yml');
    if (!fs.existsSync(src)) return '';
    let stat;
    try { stat = fs.statSync(src); } catch { return ''; }
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    let prefix = null;
    try { prefix = extractPresetPrefix(fs.readFileSync(src, 'utf8')); } catch { prefix = null; }
    if (!prefix) return '';
    // Windows 命令行总长上限 32767 个字符：超长时宁可不注入，也不要把 CLI 启动搞崩。
    if (prefix.length > 20000) {
      this.log(`preset ${preset} 的提示词过长（${prefix.length} 字），已跳过注入`);
      return '';
    }
    this._personaFiles.set(preset, { text: prefix, mtimeMs: stat.mtimeMs });
    return prefix;
  }

  _buildArgs(s, { resume = false } = {}) {
    const args = [
      this.opt.cliPath,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.opt.permissionMode
    ];
    // 安全白名单：内置工具只保留 5 个无副作用工具（MCP 工具不受 --tools 影响，仍然可用）。
    // 实测 `--tools ""`（空串）在完整版 CLI headless 下不生效（Bash/PowerShell 仍可执行），
    // 非空白名单才可靠拦住；settings.permissions 的 deny 作为第二层保险（_ensureSecuritySettings）。
    args.push('--tools', SAFE_BUILTIN_TOOLS);
    if (this.opt.deniedTools.length && this.opt.toolsMode === 'denylist') args.push('--disallowedTools', this.opt.deniedTools.join(','));
    if (this.opt.mcpEnabled && this._mcpConfigPath) {
      args.push('--mcp-config', this._mcpConfigPath, '--strict-mcp-config');
    }
    if (s.model) args.push('--model', s.model);
    if (s.effort) args.push('--effort', this._mapEffort(s.effort));
    const persona = this._personaTextFor(s.preset);
    if (persona) args.push('--append-system-prompt', persona);
    if (resume && s.cliSessionId) args.push('--resume', s.cliSessionId);
    else args.push('--session-id', s.sessionId.replace(/^wb-/, 'wb'));
    if (this.opt.extraArgs.length) args.push(...this.opt.extraArgs);
    return args;
  }

  _mapEffort(effort) {
    const value = String(effort || '').toLowerCase();
    if (value === 'off' || value === 'none' || value === '') return 'minimal';
    if (value === 'xhigh' || value === 'max') return 'max';
    if (['minimal', 'low', 'medium', 'high'].includes(value)) return value;
    return 'minimal';
  }

  _ensureChild(s) {
    if (s.child && s.child.exitCode == null) return Promise.resolve();
    const args = this._buildArgs(s, { resume: Boolean(s.cliSessionId) });
    const child = spawn(this.opt.nodePath, args, {
      cwd: s.cwd,
      env: buildCliEnv({}, { homeDir: this.opt.homeDir, configDir: this.opt.configDir, forceLiteBundle: this.opt.forceLiteBundle }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.__decoder = new StringDecoder('utf8');
    child.__buffer = '';
    child.__stderrTail = [];
    s.child = child;

    child.stdout.on('data', (chunk) => {
      child.__buffer += child.__decoder.write(chunk);
      let index;
      while ((index = child.__buffer.indexOf('\n')) >= 0) {
        const line = child.__buffer.slice(0, index).replace(/\r$/, '');
        child.__buffer = child.__buffer.slice(index + 1);
        if (line.trim()) this._handleLine(s, line);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = child.__decoder.write(chunk).trim();
      if (!text) return;
      child.__stderrTail.push(text);
      if (child.__stderrTail.length > 20) child.__stderrTail.shift();
      if (this.opt.logRaw) this.log(`[cli:${s.sessionId.slice(-6)}] ${text.slice(0, 300)}`);
    });
    child.on('error', (error) => {
      this.log(`CLI 启动失败（${s.sessionId}）：${error?.message ?? error}`);
      if (s.running) this._endTurn(s, { kind: 'error', message: String(error?.message ?? error) });
    });
    child.on('exit', (code, signal) => {
      if (s.child === child) s.child = null;
      const tail = child.__stderrTail.join(' ').slice(-300);
      if (code !== 0 && tail) this.log(`CLI 退出 code=${code} signal=${signal ?? '-'}：${tail}`);
      if (s.running) {
        // 回合还没结束进程就没了：让桥接拿到明确的失败信号，而不是等到租约过期。
        this._endTurn(s, { kind: 'error', message: `CLI exited (code=${code})` });
      }
    });
    this.log(`已启动 WorkBuddy CLI（${s.sessionId.slice(-8)} preset=${s.preset || '默认'} resume=${Boolean(s.cliSessionId)}）`);
    return Promise.resolve();
  }

  _writeLine(s, payload) {
    const child = s.child;
    if (!child || child.killed || child.exitCode != null) throw new Error('CLI 进程不可用');
    child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
  }

  _drain(s) {
    if (this._closed || s.running) return;
    const item = s.queue.shift();
    if (!item) return;
    s.running = true;
    s.turnSeq += 1;
    s.turnText = '';
    s.turnStartedAt = nowMs();
    const turn = s.turnSeq;
    this._emit(s.sessionId, { type: 'turn/start', data: { turn } });
    clearTimeout(s.turnTimer);
    s.turnTimer = setTimeout(() => {
      if (!s.running) return;
      this.log(`回合超时（${s.sessionId} ${Math.round(this.opt.turnTimeoutMs / 1000)}s），强制中断`);
      this._endTurn(s, { kind: 'aborted', message: 'turn timeout' });
      this._killChild(s, 'turn timeout');
    }, this.opt.turnTimeoutMs);
    s.turnTimer.unref?.();

    this._ensureChild(s)
      .then(() => {
        this._writeLine(s, {
          type: 'user',
          message: { role: 'user', content: item.content },
          session_id: s.cliSessionId || s.sessionId
        });
      })
      .catch((error) => {
        this.log(`投递到 CLI 失败（${s.sessionId}）：${error?.message ?? error}`);
        this._endTurn(s, { kind: 'error', message: String(error?.message ?? error) });
        this._killChild(s, 'write failed');
      });
  }

  _handleLine(s, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (this.opt.logRaw) this.log(`[cli:raw:${s.sessionId.slice(-6)}] ${line.slice(0, 200)}`);
      return;
    }
    if (this.opt.logRaw) this.log(`[cli:${msg.type ?? '?'}] ${line.slice(0, 240)}`);

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          if (typeof msg.session_id === 'string' && msg.session_id) s.cliSessionId = msg.session_id;
          const toolCount = Array.isArray(msg.tools) ? msg.tools.length : null;
          const mcpCount = Array.isArray(msg.mcp_servers) ? msg.mcp_servers.length : null;
          this.log(`CLI 会话就绪（${s.sessionId}）：model=${msg.model ?? s.model}${toolCount != null ? ` tools=${toolCount}` : ''}${mcpCount != null ? ` mcp=${mcpCount}` : ''}`);
        }
        return;
      }
      case 'assistant': {
        if (!s.running) return; // 与 DSH 一样：只认当前回合里的 assistant 消息
        const blocks = contentBlocksOf(msg);
        const text = textOfMessage(msg);
        for (const block of blocks) {
          if (block?.type !== 'tool_use') continue;
          this._emit(s.sessionId, {
            type: 'tool/call',
            data: { name: block.name, callId: block.id, arguments: block.input }
          });
        }
        if (text && text.trim()) {
          s.turnText += text;
          this._emit(s.sessionId, {
            type: 'assistant/message',
            data: { turn: s.turnSeq, message: { content: [{ type: 'text', text }] }, usage: msg.message?.usage ?? msg.usage }
          });
        }
        return;
      }
      case 'user': {
        for (const block of contentBlocksOf(msg)) {
          if (block?.type !== 'tool_result') continue;
          const resultText = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
              : '';
          this._emit(s.sessionId, {
            type: 'tool/result',
            data: {
              message: {
                source: { callId: block.tool_use_id },
                isError: block.is_error === true,
                content: [{ type: 'text', text: resultText, isError: block.is_error === true }]
              }
            }
          });
        }
        return;
      }
      case 'result': {
        if (!s.running) return;
        // 兜底：有些回合只产出 result 而不发 assistant 文本（纯工具回合、或流被裁剪）
        if (!s.turnText.trim() && typeof msg.result === 'string' && msg.result.trim()) {
          s.turnText = msg.result;
          this._emit(s.sessionId, {
            type: 'assistant/message',
            data: { turn: s.turnSeq, message: { content: [{ type: 'text', text: msg.result }] }, usage: msg.usage }
          });
        }
        const isError = msg.is_error === true || (msg.subtype && msg.subtype !== 'success');
        this._endTurn(s, isError
          ? { kind: 'error', message: String(msg.result ?? msg.subtype ?? 'error') }
          : { kind: 'completed' });
        return;
      }
      case 'stream_event':
      case 'rate_limit_event':
      case 'ping':
        return;
      default:
        return;
    }
  }

  _endTurn(s, reason) {
    if (!s.running) return;
    s.running = false;
    clearTimeout(s.turnTimer);
    s.turnTimer = null;
    s.lastUsedAt = nowMs();
    this._emit(s.sessionId, { type: 'turn/end', data: { turn: s.turnSeq, reason } });
    // 队列里还有消息就接着跑
    setImmediate(() => this._drain(s));
  }

  _killChild(s, why) {
    const child = s.child;
    if (!child) return;
    s.child = null;
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
    this.log(`已结束 CLI 进程（${s.sessionId.slice(-8)}）：${why}`);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref?.();
  }

  _restartChild(s, why) {
    this._killChild(s, why);
    s.cliSessionId = null;
  }

  _recycleIdle() {
    const limit = nowMs() - this.opt.idleRecycleMs;
    for (const s of this._sessions.values()) {
      if (s.running || !s.child) continue;
      if (s.lastUsedAt > limit) continue;
      this._killChild(s, 'idle recycle');
    }
  }

  async close() {
    this._closed = true;
    for (const push of this._subscribers) push(null);
    this._subscribers.clear();
    clearInterval(this._recycler);
    for (const s of this._sessions.values()) this._killChild(s, 'shutdown');
  }
}

/** 按 config.backend 选择后端；dsh 是默认值，保证一行配置就能切回去。 */
export async function createApiClient(cfg, { log } = {}) {
  const backend = String(cfg?.backend ?? 'dsh').toLowerCase();
  if (backend === 'workbuddy') {
    const client = new WbApiClient(cfg, { log });
    await client.ensureAuth();
    return client;
  }
  const { NodeApiClient } = await import('./dsh-client.js');
  return new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    allowRemote: cfg.dsh.allowRemote === true
  });
}
