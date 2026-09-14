import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = resolve(repositoryRoot, 'scripts/imagegen-semantic-query.mjs');
const baseModelPath = '/internal/semantic/base-models';
const generationModelPath = '/internal/semantic/generation-models';

function emptyPage(kind) {
  return {
    contract_id: 'imagegen-source-contract',
    contract_version: 1,
    kind,
    items: [],
    page: 1,
    page_size: 20,
    total_count: 0
  };
}

function runCli(args) {
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
  });
}

async function withServer(callback) {
  const requests = [];
  const discovery = buildSemanticDiscovery({ repositoryRoot, mediaOrigin: 'http://127.0.0.1:19082' });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: request.method, url: request.url, bodyText });
    if (request.method === 'GET' && request.url === '/internal/semantic') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(discovery));
      return;
    }
    if (request.method === 'POST' && request.url === baseModelPath) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(emptyPage('base-model')));
      return;
    }
    if (request.method === 'POST' && request.url === generationModelPath) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(emptyPage('model')));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    return await callback({ port: server.address().port, requests });
  } finally {
    await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  }
}

test('Issue #179 sends one closed Catalog request with raw underscore parameter names', async () => {
  await withServer(async ({ port, requests }) => {
    const result = await runCli([
      '--port', String(port), '--path', baseModelPath, '--mode', 'search',
      '--query', 'watercolor', '--page', '2', '--page_size', '3'
    ]);
    assert.deepEqual(result, { status: 0, signal: null, stdout: JSON.stringify(emptyPage('base-model')), stderr: '' });
    assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
      { method: 'GET', url: '/internal/semantic' },
      { method: 'POST', url: baseModelPath }
    ]);
    assert.deepEqual(JSON.parse(requests[1].bodyText), { mode: 'search', query: 'watercolor', page: 2, page_size: 3 });
  });
});

test('Issue #179 sends stable string IDs for Catalog resolve without a legacy groups envelope', async () => {
  await withServer(async ({ port, requests }) => {
    const id = '12345678901234567890';
    const result = await runCli(['--port', String(port), '--path', generationModelPath, '--mode', 'resolve', '--id', id]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).kind, 'model');
    assert.deepEqual(JSON.parse(requests[1].bodyText), { mode: 'resolve', id });
    assert.doesNotMatch(result.stdout, /groups|queries|ok|data/u);
  });
});

test('Issue #179 rejects the removed dynamic query flags and non-Catalog operation paths', async () => {
  const local = await runCli(['--port', '1234', '--path', baseModelPath, '--queries', 'legacy']);
  assert.equal(local.status, 2);
  assert.equal(local.stdout, '');
  assert.equal(JSON.parse(local.stderr).error.code, 'INVALID_ARGUMENT');

  await withServer(async ({ port, requests }) => {
    const result = await runCli(['--port', String(port), '--path', '/internal/semantic', '--help']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(requests, []);
  });
});
