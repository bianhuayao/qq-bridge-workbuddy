#!/usr/bin/env node
/**
 * qq-bridge × WorkBuddy 后端扩展：安装器
 *
 * 用法（在扩展包目录运行，或由 install.ps1 调用）：
 *   node payload/scripts/setup-apply.mjs                      # 交互式安装
 *   node payload/scripts/setup-apply.mjs --target D:\qq-bridge # 指定 qq-bridge 目录
 *   node payload/scripts/setup-apply.mjs --uninstall --target D:\qq-bridge
 *   node payload/scripts/setup-apply.mjs --dry-run            # 只检查/复制，不做 npm/登录/启动
 *
 * 流程：定位原版 qq-bridge → 备份 bridge.js → 复制补丁文件 → npm 依赖 →
 *       安装完整版 CodeBuddy CLI → 登录 WorkBuddy 账号 → 写 config.json →
 *       六项安全自检 → 启动桥接。
 *
 * 本脚本不包含任何账号凭据；登录由使用者自己完成。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD = path.resolve(__dirname, '..'); // 扩展包里的 payload/ 目录
const CLI_PKG = '@tencent-ai/codebuddy-code';
const CLI_VERSION = '2.173.0';
const BASELINE_VERSION = '0.2.0-r4';
const AUTO_YES = process.argv.includes('--yes');
const DRY_RUN = process.argv.includes('--dry-run');
const UNINSTALL = process.argv.includes('--uninstall');

const C = { r: '\x1b[0m', b: '\x1b[1m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const say = (t = '') => console.log(t);
const ok = (t) => say(`${C.green}✔ ${t}${C.r}`);
const warn = (t) => say(`${C.yellow}⚠ ${t}${C.r}`);
const bad = (t) => say(`${C.red}✘ ${t}${C.r}`);
const step = (n, t) => say(`\n${C.bold}${C.cyan}[${n}] ${t}${C.r}`);

let rl = null;
async function ask(question, defaultValue = '') {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = defaultValue !== '' ? ` ${C.dim}(默认: ${defaultValue})${C.r}` : '';
  const a = (await rl.question(`${question}${hint} `)).trim();
  return a === '' ? defaultValue : a;
}
async function askYes(question, defaultYes = true) {
  if (AUTO_YES) return true; // --yes：自动模式一律确认（调用方会在需要保留现状时自己短路）
  const a = (await ask(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a === '' ? defaultYes : a.startsWith('y');
}
async function askList(question, defaults = []) {
  const v = await ask(question, defaults.join(','));
  return v.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}
function run(command, args, options = {}) {
  say(`${C.dim}$ ${command} ${args.join(' ')}${C.r}`);
  const isCmdScript = process.platform === 'win32' && /\.cmd$/i.test(command);
  return spawnSync(command, args, { stdio: 'inherit', shell: isCmdScript || options.shell === true, ...options });
}
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : null; };
  return { target: get('--target') };
}

function isQqBridgeRoot(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    return fs.existsSync(path.join(dir, 'src', 'bridge.js')) && fs.existsSync(path.join(dir, 'scripts'));
  } catch { return false; }
}

async function locateTarget(explicit) {
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(process.cwd(), path.resolve(PAYLOAD, '..', 'qq-bridge'), path.resolve(process.cwd(), 'qq-bridge'), path.resolve(process.cwd(), '..', 'qq-bridge'));
  for (const dir of candidates) {
    if (isQqBridgeRoot(dir)) return dir;
  }
  say('');
  say('没有自动找到 qq-bridge 目录。请先把原版 qq-bridge 下载并解压/克隆到本机，然后输入它的路径。');
  say('（例如：C:\\Users\\你的用户名\\qq-bridge，或 D:\\qq-bridge）');
  const answer = await ask('qq-bridge 目录路径:');
  const dir = path.resolve(answer);
  if (!isQqBridgeRoot(dir)) {
    bad(`这个目录不像 qq-bridge 根目录（需要 package.json + src/bridge.js + scripts/）：${dir}`);
    process.exit(1);
  }
  return dir;
}

function detectVersion(target) {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version ?? '';
  } catch { return ''; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function manifestPath(target) { return path.join(target, 'state', '.workbuddy-extension.json'); }
function readManifest(target) { return readJson(manifestPath(target), null); }

const COPY_FILES = [
  ['src/bridge.js', 'src/bridge.js'],
  ['src/wb-client.js', 'src/wb-client.js'],
  ['scripts/wb-login.mjs', 'scripts/wb-login.mjs'],
  ['scripts/wb-selftest.mjs', 'scripts/wb-selftest.mjs'],
  ['scripts/stop-bridge.mjs', 'scripts/stop-bridge.mjs'],
  ['scripts/setup-apply.mjs', 'scripts/setup-workbuddy.mjs'],
  ['docs/WORKBUDDY_BACKEND.md', 'docs/guides/WORKBUDDY_BACKEND.md'],
];

async function doUninstall(target) {
  const manifest = readManifest(target);
  if (!manifest) { bad('没有找到安装清单 state/.workbuddy-extension.json，无法自动卸载。'); process.exit(1); }
  say(`${C.bold}将撤销 WorkBuddy 扩展${C.r}`);
  say(`  目标：${target}`);
  say(`  文件：${manifest.files.length} 个；bridge.js 备份：${manifest.bridgeBackup ?? '(无)'}`);
  if (!(await askYes('确认卸载？', false))) { say('已取消。'); return; }
  // 恢复 bridge.js 备份
  if (manifest.bridgeBackup && fs.existsSync(manifest.bridgeBackup)) {
    fs.copyFileSync(manifest.bridgeBackup, path.join(target, 'src', 'bridge.js'));
    ok('已恢复 src/bridge.js 备份');
  } else warn('没有 bridge.js 备份，跳过恢复');
  // 删除新增文件（wb-client、wb-* 脚本、docs）
  for (const rel of manifest.files) {
    if (rel === 'src/bridge.js') continue;
    const file = path.join(target, rel);
    try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
  ok('已删除扩展新增文件');
  try { fs.rmSync(manifestPath(target), { force: true }); } catch { /* ignore */ }
  say(`\n提示：config.json 里的 workbuddy 配置与登录态没有删除（如需彻底清理，手动删除 state/wb-home 与 state/wb-cli）。`);
}

async function doInstall(target) {
  const version = detectVersion(target);
  say(`${C.bold}目标 qq-bridge：${target}${C.r}（版本 ${version || '未知'}）`);
  if (version && version !== BASELINE_VERSION) {
    warn(`扩展包按 v${BASELINE_VERSION} 适配，当前版本是 ${version}。继续可能覆盖掉新版本特性（会先备份 bridge.js）。`);
    if (!(await askYes('仍然继续吗？', false))) process.exit(1);
  }
  const already = fs.existsSync(path.join(target, 'src', 'wb-client.js'));
  if (already) warn('检测到已安装过 WorkBuddy 扩展，将更新（bridge.js 会重新备份）。');

  // ── 备份 bridge.js ──
  step(1, '备份并复制扩展文件');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(target, 'src', `bridge.js.wb-backup-${ts}`);
  fs.copyFileSync(path.join(target, 'src', 'bridge.js'), backup);
  ok(`bridge.js 已备份：${backup}`);

  // ── 复制文件 ──
  const copied = [];
  for (const [from, to] of COPY_FILES) {
    const source = path.join(PAYLOAD, from);
    const dest = path.join(target, to);
    if (!fs.existsSync(source)) { bad(`扩展包缺少文件：${source}`); process.exit(1); }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    copied.push(to);
  }
  fs.mkdirSync(path.join(target, 'state'), { recursive: true });
  writeJson(manifestPath(target), { installedAt: new Date().toISOString(), baseline: BASELINE_VERSION, bridgeBackup: backup, files: copied });
  ok(`已复制 ${copied.length} 个文件（清单：state/.workbuddy-extension.json）`);

  if (DRY_RUN) { say('\n--dry-run：跳过 npm/登录/配置/自检/启动。'); return; }

  // ── npm install ──
  step(2, '安装项目依赖（首次 1~3 分钟）');
  if (!fs.existsSync(path.join(target, 'node_modules', '@snowluma', 'sdk'))) {
    const r = run(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: target });
    if (r.status !== 0) { bad('npm install 失败，请检查网络/npm 源。'); process.exit(1); }
  } else ok('依赖已安装，跳过');

  // ── 安装完整版 CLI ──
  step(3, '安装 WorkBuddy 命令行（CodeBuddy CLI）');
  const wbHome = path.join(target, 'state', 'wb-home');
  const wbCli = path.join(target, 'state', 'wb-cli');
  fs.mkdirSync(wbHome, { recursive: true });
  fs.mkdirSync(wbCli, { recursive: true });
  const cliPkg = path.join(wbCli, 'node_modules', '@tencent-ai', 'codebuddy-code', 'package.json');
  let needCli = true;
  if (fs.existsSync(cliPkg)) {
    try { needCli = JSON.parse(fs.readFileSync(cliPkg, 'utf8')).version !== CLI_VERSION; } catch { needCli = true; }
    if (!needCli) ok(`CLI 已安装（${CLI_VERSION}）`);
  }
  if (needCli) {
    if (!fs.existsSync(path.join(wbCli, 'package.json'))) writeJson(path.join(wbCli, 'package.json'), { name: 'wb-cli-local', version: '1.0.0', private: true });
    const r = run(npmCmd, ['install', `${CLI_PKG}@${CLI_VERSION}`, '--no-save', '--no-audit', '--no-fund', '--prefix', wbCli], { cwd: target });
    if (r.status !== 0) { bad('CLI 安装失败，请检查网络/npm 源。'); process.exit(1); }
  }
  const cliPath = path.join(wbCli, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
  if (!fs.existsSync(cliPath)) { bad(`找不到 CLI 入口：${cliPath}`); process.exit(1); }
  ok(`CLI 就绪：${cliPath}`);

  // ── 登录 ──
  step(4, '登录 WorkBuddy 账号（一次性）');
  const authDir = path.join(wbHome, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  const hasAuth = () => { try { return fs.readdirSync(authDir).some((n) => n.endsWith('.info')); } catch { return false; } };
  if (hasAuth() && (AUTO_YES || !(await askYes('检测到已有登录态，要重新登录吗？', false)))) {
    ok('使用已有登录态');
  } else {
    say('接下来会打开 CodeBuddy CLI 登录界面：输入 /login → 浏览器选你的 WorkBuddy 账号授权 → 成功后 /exit。');
    if (!(await askYes('准备好了吗？', true))) process.exit(1);
    const env = buildCliEnvLocal(wbHome, path.join(wbHome, '.workbuddy'));
    const child = spawn(process.execPath, [cliPath], { cwd: target, env, stdio: 'inherit', windowsHide: false });
    await new Promise((resolve) => child.on('exit', resolve));
  }
  if (!hasAuth()) { bad('没有检测到登录态。请重新运行本安装器完成 /login。'); process.exit(1); }
  ok('WorkBuddy 账号已登录');

  // ── 配置 ──
  step(5, '写配置（config.json）');
  const configFile = path.join(target, 'config.json');
  let config = readJson(configFile, null);
  if (!config) {
    const example = readJson(path.join(target, 'config.example.json'), {});
    config = { ...example };
    ok('没有 config.json，已从 config.example.json 创建');
  }
  const ownerQQ = await ask('你的 QQ 号（机器人管理员，必填）', String(config.ownerQQ ?? ''));
  if (!ownerQQ) { bad('必须填写 ownerQQ。'); process.exit(1); }
  const groups = await askList('允许机器人加入的群号（逗号分隔，可留空）', (config.allow?.groups ?? []).map(String));
  const wsUrl = await ask('SnowLuma OneBot WebSocket 地址', String(config.snowluma?.wsUrl ?? 'ws://127.0.0.1:3001'));
  const accessToken = await ask('SnowLuma accessToken（可留空）', String(config.snowluma?.accessToken ?? ''));
  const model = await ask('模型', String(config.workbuddy?.model ?? 'deepseek-v4.1-flash'));
  const effort = await ask('思考强度（off/low/high/max）', String(config.workbuddy?.reasoningEffort ?? 'low'));
  config = {
    ...config,
    backend: 'workbuddy',
    ownerQQ: Number(ownerQQ) || ownerQQ,
    allow: { ...(config.allow ?? {}), private: [Number(ownerQQ) || ownerQQ], groups },
    snowluma: { ...(config.snowluma ?? {}), wsUrl, accessToken },
    workbuddy: {
      ...(config.workbuddy ?? {}),
      cliPath,
      nodePath: process.execPath,
      homeDir: wbHome,
      model,
      reasoningEffort: String(effort ?? '').toLowerCase(),
      forceLiteBundle: false,
      permissionMode: 'dontAsk',
      mcpEnabled: true,
      usePresetPersona: true,
    },
  };
  writeJson(configFile, config);
  ok(`config.json 已写入（backend=workbuddy, model=${model}, effort=${effort || '默认'}）`);

  // ── 自检 ──
  step(6, '安全自检（六项，必须全部通过）');
  const report = path.join(target, 'state', 'wb-selftest', 'report.md');
  try { fs.rmSync(path.join(target, 'state', 'wb-selftest'), { recursive: true, force: true }); } catch { /* ignore */ }
  const selftest = spawnSync(process.execPath, [path.join(target, 'scripts', 'wb-selftest.mjs')], { cwd: target, stdio: 'inherit', env: process.env });
  let passed = 0;
  try { passed = (fs.readFileSync(report, 'utf8').match(/\| \w+ \| 通过 \|/g) ?? []).length; } catch { passed = 0; }
  if (selftest.status !== 0 || passed < 6) {
    bad(`自检未全部通过（${passed}/6），已停止启动。请查看：${report}`);
    process.exit(1);
  }
  ok('自检 6/6 全部通过');

  // ── 启动 ──
  step(7, '启动桥接');
  const pidFile = path.join(target, 'state', 'bridge.pid');
  try {
    if (fs.existsSync(pidFile)) { const old = Number(fs.readFileSync(pidFile, 'utf8').trim()); if (old) process.kill(old); }
  } catch { /* ignore */ }
  const out = fs.openSync(path.join(target, 'state', 'bridge-run.log'), 'a');
  const err = fs.openSync(path.join(target, 'state', 'bridge-run.err.log'), 'a');
  const child = spawn(process.execPath, [path.join(target, 'src', 'bridge.js')], {
    cwd: target, detached: true, stdio: ['ignore', out, err], windowsHide: true,
    env: buildCliEnvLocal(wbHome, path.join(wbHome, '.workbuddy')),
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 12000));
  const logFile = path.join(target, 'state', 'bridge.log');
  const started = fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('桥接已启动');
  if (!started) warn('桥接可能没有成功启动，请查看 state/bridge.log'); else ok(`桥接已启动（PID ${child.pid}）`);

  // ── 完成 ──
  say('');
  say(`${C.bold}${C.green}━━━ 安装完成 ━━━${C.r}`);
  say(`控制台：${C.cyan}http://127.0.0.1:${config.consolePort ?? 3100}${C.r}（token 在 state/console-token）`);
  say(`日志：${C.dim}${path.join(target, 'state', 'bridge.log')}${C.r}`);
  say(`停止：${C.dim}node scripts/stop-bridge.mjs${C.r}`);
  say('');
  say(`${C.yellow}提醒：${C.r}本扩展依赖 WorkBuddy 官方 CLI 与你自己的账号额度；请遵守相关服务条款，风险自负。`);
  say(`卸载：node payload/scripts/setup-apply.mjs --uninstall（或 install.ps1 --uninstall）`);
}

function buildCliEnvLocal(wbHome, configDir) {
  const passthrough = ['PATH', 'Path', 'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
  const env = {};
  for (const key of passthrough) if (process.env[key] != null) env[key] = process.env[key];
  env.CODEBUDDY_CONFIG_DIR = configDir;
  env.WORKBUDDY_CONFIG_DIR = configDir;
  env.WORKBUDDY_USER_DATA_DIR = path.join(configDir, 'app');
  env.CODEBUDDY_SKIP_GIT_BASH_CHECK = '1';
  env.CODEBUDDY_DISABLE_IDE = '1';
  env.CODEBUDDY_DISABLE_AUTO_MEMORY = '1';
  env.CODEBUDDY_DISABLE_BROWSER_MCP = '1';
  env.CODEBUDDY_DISABLE_CRON = '1';
  env.HOME = wbHome;
  env.USERPROFILE = wbHome;
  env.HOMEDRIVE = path.parse(wbHome).root.replace(/\\$/, '');
  env.HOMEPATH = wbHome.slice(env.HOMEDRIVE.length) || '\\';
  env.APPDATA = path.join(wbHome, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(wbHome, 'AppData', 'Local');
  env.TEMP = path.join(wbHome, 'AppData', 'Local', 'Temp');
  env.TMP = env.TEMP;
  return env;
}

async function main() {
  say('');
  say(`${C.bold}${C.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.r}`);
  say(`${C.bold}${C.cyan}  qq-bridge × WorkBuddy 后端扩展 · 安装器${C.r}`);
  say(`${C.bold}${C.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.r}`);
  say(`${C.dim}扩展包：${PAYLOAD}${C.r}`);
  const { target: explicit } = parseArgs();
  const target = await locateTarget(explicit);
  if (UNINSTALL) { await doUninstall(target); }
  else { await doInstall(target); }
  if (rl) rl.close();
}

main().catch((error) => {
  bad(`安装失败：${error?.message ?? error}`);
  process.exit(1);
});
