import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = resolve(repositoryRoot, 'scripts/catalog/imagegen-semantic-query.mjs');
const operationPath = '/internal/semantic/base-models';

function page() {
  return { contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'base-model', items: [], page: 1, page_size: 20, total_count: 0 };
}

function runCli(args, { onChild } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: '/', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
    onChild?.(child);
  });
}

async function startServer({ discoveryStatus = 200, discoveryDelayMs = 0, postDelayMs = 0, postBody = page(), postStatus = 200, hangPost = false } = {}) {
  const requests = [];
  let resolvePostStarted;
  const postStarted = new Promise((resolvePromise) => { resolvePostStarted = resolvePromise; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url });
    if (request.method === 'POST') resolvePostStarted();
    const delay = request.method === 'GET' ? discoveryDelayMs : postDelayMs;
    if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    if (request.method === 'GET' && request.url === '/internal/semantic') {
      response.writeHead(discoveryStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(buildSemanticDiscovery({ repositoryRoot, mediaOrigin: 'http://127.0.0.1:19082' })));
      return;
    }
    if (request.method === 'POST' && request.url === operationPath) {
      if (hangPost) return;
      response.writeHead(postStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(postBody));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return {
    port: server.address().port,
    requests,
    postStarted,
    close: () => new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()))
  };
}

function assertFixed(result, status, code) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { error: { code, message: {
    INVALID_ARGUMENT: 'CLI arguments are invalid.',
    DISCOVERY_HTTP_ERROR: 'Source discovery returned an error.',
    SOURCE_CONNECTION_FAILED: 'Source service is unavailable.',
    TOTAL_TIMEOUT: 'Source request timed out.',
    PROCESS_CANCELLED: 'Source request was cancelled by SIGTERM.'
  }[code] } });
}

test('Issue #183 maps missing, malformed, and duplicate CLI arguments to one fixed local error', async () => {
  for (const args of [
    [],
    ['--port', '0', '--discovery-json'],
    ['--port', '65536', '--discovery-json'],
    ['--port', '1234', '--timeout-ms', '0', '--discovery-json'],
    ['--port', '1234', '--path', operationPath, '--page-size', '2'],
    ['--port', '1234', '--path', operationPath, '--mode', 'search', '--mode', 'search']
  ]) {
    const result = await runCli(args);
    assertFixed(result, 2, 'INVALID_ARGUMENT');
  }
});

test('Issue #183 distinguishes discovery HTTP errors from connection failures', async () => {
  const unavailable = await startServer({ discoveryStatus: 503 });
  try {
    assertFixed(await runCli(['--port', String(unavailable.port), '--path', operationPath, '--mode', 'search']), 3, 'DISCOVERY_HTTP_ERROR');
  } finally {
    await unavailable.close();
  }
  const closed = await startServer();
  const port = closed.port;
  await closed.close();
  assertFixed(await runCli(['--port', String(port), '--path', operationPath, '--mode', 'search']), 4, 'SOURCE_CONNECTION_FAILED');
});

test('Issue #183 applies one total timeout and cancellation to the live Catalog request', async () => {
  const timed = await startServer({ discoveryDelayMs: 40, postDelayMs: 70 });
  try {
    const result = await runCli(['--port', String(timed.port), '--timeout-ms', '100', '--path', operationPath, '--mode', 'search']);
    assertFixed(result, 5, 'TOTAL_TIMEOUT');
    assert.equal(timed.requests.filter(({ method }) => method === 'GET').length, 1);
    assert.equal(timed.requests.filter(({ method }) => method === 'POST').length <= 1, true);
  } finally {
    await timed.close();
  }

  const cancelled = await startServer({ hangPost: true });
  try {
    const result = await runCli(['--port', String(cancelled.port), '--path', operationPath, '--mode', 'search'], {
      onChild: async (child) => { await cancelled.postStarted; child.kill('SIGTERM'); }
    });
    assertFixed(result, 143, 'PROCESS_CANCELLED');
  } finally {
    await cancelled.close();
  }
});
