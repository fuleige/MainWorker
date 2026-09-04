import { spawn } from 'node:child_process';
import { watch } from 'node:fs';

try {
  process.loadEnvFile('.env');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const healthUrl = `http://127.0.0.1:${Number(process.env.API_PORT || 4390)}/api/health`;
let child = null;
let restartTimer = null;
let restarting = false;
let stopping = false;
let waitingForRun = false;

function start() {
  restarting = false;
  child = spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' });
  child.once('exit', (code, signal) => {
    if (stopping) process.exit(0);
    if (restarting) {
      setTimeout(start, 50);
      return;
    }
    console.error(`API 服务异常退出（code=${code}, signal=${signal}）`);
    watcher.close();
    process.exit(code || 1);
  });
}

async function restartWhenIdle() {
  if (stopping || restarting) return;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    const health = response.ok ? await response.json() : null;
    if (!health || Number(health.activeRuns || 0) > 0) {
      if (!waitingForRun && health) console.log('检测到运行中的 Web 任务，API 重启将在任务结束后进行');
      waitingForRun = Boolean(health);
      restartTimer = setTimeout(restartWhenIdle, health ? 1000 : 500);
      return;
    }
  } catch {
    restartTimer = setTimeout(restartWhenIdle, 500);
    return;
  }
  waitingForRun = false;
  restarting = true;
  if (child?.exitCode === null) child.kill('SIGTERM');
  else start();
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restartWhenIdle, 120);
}

const watcher = watch('server', { recursive: true }, scheduleRestart);

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  watcher.close();
  if (child?.exitCode === null) child.kill('SIGTERM');
  else process.exit(0);
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
start();
