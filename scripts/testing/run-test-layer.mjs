import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const DEFAULT_TEST_CONCURRENCY_OPTION = '--test-concurrency=2';
const [directory, testConcurrencyOption = DEFAULT_TEST_CONCURRENCY_OPTION, ...extraArguments] = process.argv.slice(2);
if (typeof directory !== 'string' || directory.length === 0) throw new Error('test directory is required');
if (extraArguments.length > 0) throw new Error('test layer accepts only a directory and one test concurrency option');
if (!/^--test-concurrency=[1-9]\d*$/u.test(testConcurrencyOption)) {
  throw new Error('test concurrency must use --test-concurrency=<positive integer>');
}

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

const root = resolve(directory);
const files = (await collectTests(root)).sort();
if (files.length === 0) throw new Error(`no test files found under ${root}`);

const child = spawn(process.execPath, ['--test', testConcurrencyOption, ...files], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test', NOOBAI_TEST_EMPTY_COMFYUI_CATALOG: '1' }
});
child.once('error', (error) => { throw error; });
const [code, signal] = await new Promise((resolvePromise) => child.once('exit', (exitCode, exitSignal) => resolvePromise([exitCode, exitSignal])));
if (signal !== null) process.kill(process.pid, signal);
process.exitCode = code ?? 1;
