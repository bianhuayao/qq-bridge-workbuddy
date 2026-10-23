#!/usr/bin/env node
/** 停止由安装向导启动的 qq-bridge（读取 state/bridge.pid）。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const pidFile = path.join(ROOT, 'state', 'bridge.pid');

if (!fs.existsSync(pidFile)) {
  console.log('没有找到 state/bridge.pid（桥接可能不是由安装向导启动的）。');
  process.exit(0);
}
const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
if (!pid) {
  console.log('state/bridge.pid 内容无效。');
  process.exit(1);
}
try {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit', shell: true });
  } else {
    process.kill(pid, 'SIGTERM');
  }
  console.log(`已发送停止信号：PID ${pid}`);
} catch (error) {
  console.log(`停止失败（进程可能已退出）：${error?.message ?? error}`);
}
try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ }
