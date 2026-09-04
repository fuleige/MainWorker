import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(projectRoot, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (process.env.WORKBENCH_TOKEN?.trim()) {
  process.stdout.write(`${process.env.WORKBENCH_TOKEN.trim()}\n`);
  process.exit(0);
}
const tokenFile = path.join(projectRoot, '.data', 'access-token');
if (!fs.existsSync(tokenFile)) {
  console.error('访问口令尚未生成，请先启动工作台。');
  process.exit(1);
}
process.stdout.write(fs.readFileSync(tokenFile, 'utf8'));
