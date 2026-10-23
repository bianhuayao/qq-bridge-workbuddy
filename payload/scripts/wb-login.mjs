#!/usr/bin/env node
// WorkBuddy CLI 一次性登录：在隔离 home 里跑一次交互式 TUI，用 /login 完成账号授权。
//
// 为什么必须单独登录一次：桌面端的登录态是 DPAPI 加密信封，独立进程解不出来，
// CLI 会一律报 "Authentication required"（实测把 keyblob + auth 文件整份复制过去也不行）。
// 登录态落在 <workbuddy.homeDir>/AppData/Local/CodeBuddyExtension/Data/Public/auth 下，
// 之后由 CLI 自己刷新，与桌面端互不干扰。
//
// 用法：npm run login:wb      （必须在真正的终端窗口里跑，TUI 需要 TTY）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkbuddyOptions, buildCliEnv } from '../src/wb-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    const text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const opt = resolveWorkbuddyOptions(loadConfig());
const homeDir = opt.homeDir;

if (!homeDir) {
  console.error('config.json 里 workbuddy.homeDir 为空，表示复用系统 home。');
  console.error('这种情况下 CLI 会和桌面端抢同一份登录态（实测会互相踢掉），不建议。');
  console.error('请把 workbuddy.homeDir 设为例如 "<项目目录>/state/wb-home" 后重试。');
  process.exit(1);
}

const authDir = path.join(homeDir, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
// 登录态文件名随 CLI 产品版本变化（workbuddy-desktop.info / Tencent-Cloud.coding-copilot.info 等），
// 所以只看目录里有没有任意 .info。
const findAuthFile = () => {
  try {
    const name = fs.readdirSync(authDir).find((entry) => entry.endsWith('.info'));
    return name ? path.join(authDir, name) : '';
  } catch { return ''; }
};
for (const dir of [homeDir, path.join(homeDir, 'AppData', 'Local', 'Temp'), path.join(homeDir, 'AppData', 'Roaming'), path.join(homeDir, '.workbuddy')]) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' WorkBuddy CLI 登录（只做一次）');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(` CLI  ：${opt.cliPath}`);
console.log(` home ：${homeDir}   ← 与桌面端完全隔离`);
console.log(` 登录态：${authDir}\\<任意>.info`);
console.log('');
console.log(' 接下来在打开的界面里：');
console.log('   1) 输入 /login 回车');
console.log('   2) 选你自己的账号，按提示在浏览器里完成授权');
console.log('   3) 看到登录成功提示后，输入 /exit 退出');
console.log('');
console.log(' 顺手确认一下模型：/model 里能看到 glm-5.3-flash 这类条目即可。');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

const child = spawn(opt.nodePath, [opt.cliPath], {
  cwd: homeDir,
  env: buildCliEnv({}, { homeDir, configDir: opt.configDir, forceLiteBundle: opt.forceLiteBundle }),
  stdio: 'inherit',
  windowsHide: false
});

child.on('error', (error) => {
  console.error('启动 CLI 失败：', error?.message ?? error);
  process.exit(1);
});

child.on('exit', (code) => {
  console.log('');
  const authFile = findAuthFile();
  if (authFile) {
    console.log(`✅ 登录态已写入：${authFile}`);
    console.log('下一步：npm run selftest:wb');
  } else {
    console.log(`⚠️ 没找到登录态文件（${authDir} 下没有 .info）。`);
    console.log('   如果刚才没看到登录成功提示，请重跑 npm run login:wb，务必完成 /login 流程。');
  }
  process.exit(code ?? 0);
});
