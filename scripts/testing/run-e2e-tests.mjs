import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

async function collectTests(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(child));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(child);
  }
  return files;
}

const files = (await collectTests(resolve('tests/e2e/'))).sort();
if (files.length === 0) throw new Error('no E2E test files found');

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test', NOOBAI_TEST_EMPTY_COMFYUI_CATALOG: '1' }
});
child.once('error', (error) => { throw error; });
const [code, signal] = await new Promise((resolvePromise) => child.once('exit', (exitCode, exitSignal) => resolvePromise([exitCode, exitSignal])));
if (signal !== null) process.kill(process.pid, signal);
process.exitCode = code ?? 1;
