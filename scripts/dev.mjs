import { spawn } from 'node:child_process';

const children = [
  { name: 'API', child: spawn(process.execPath, ['scripts/watch-api.mjs'], { stdio: 'inherit' }) },
  { name: 'Web', child: spawn('npm', ['run', 'dev:web'], { stdio: 'inherit' }) },
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300).unref();
}

for (const { name, child } of children) {
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${name} 开发进程异常退出（code=${code}, signal=${signal}）`);
      stop(code || 1);
    }
  });
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
