import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = resolve(repositoryRoot, 'scripts/imagegen-semantic-query.mjs');
const path = '/internal/semantic/base-models';
const page = { contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'base-model', items: [], page: 1, page_size: 20, total_count: 0 };

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

async function startServer() {
  const requests = [];
  const discovery = buildSemanticDiscovery({ repositoryRoot, mediaOrigin: 'http://127.0.0.1:19082' });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
    if (request.method === 'GET' && request.url === '/internal/semantic') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(discovery));
      return;
    }
    if (request.method === 'POST' && request.url === path) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(page));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return { port: server.address().port, requests, close: () => new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise())) };
}

test('Issue #184 documents the fixed Catalog help and explicit port command sequence', async () => {
  const noPort = await runCli(['--path', path, '--help']);
  assert.equal(noPort.status, 2);
  assert.equal(noPort.stdout, '');
  assert.equal(JSON.parse(noPort.stderr).error.code, 'INVALID_ARGUMENT');

  const fixture = await startServer();
  try {
    const list = await runCli(['--port', String(fixture.port), '--help']);
    const pathHelp = await runCli(['--port', String(fixture.port), '--path', path, '--help']);
    const query = await runCli(['--port', String(fixture.port), '--path', path, '--mode', 'search', '--query', 'guide probe']);
    for (const result of [list, pathHelp, query]) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
    }
    assert.match(list.stdout, new RegExp(path, 'u'));
    assert.match(pathHelp.stdout, /--mode search|--query/u);
    assert.equal(query.stdout, JSON.stringify(page));
    assert.deepEqual(fixture.requests.map(({ method, url }) => ({ method, url })), [
      { method: 'GET', url: '/internal/semantic' },
      { method: 'GET', url: '/internal/semantic' },
      { method: 'GET', url: '/internal/semantic' },
      { method: 'POST', url: path }
    ]);
    assert.deepEqual(JSON.parse(fixture.requests.at(-1).body), { mode: 'search', query: 'guide probe' });
  } finally {
    await fixture.close();
  }
});
