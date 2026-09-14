import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = resolve(repositoryRoot, 'scripts/imagegen-semantic-query.mjs');
const path = '/internal/semantic/generation-models';
const page = { contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'model', items: [], page: 1, page_size: 20, total_count: 0 };

function runCli(port, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, '--port', String(port), '--path', path, ...args], { cwd: '/', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function startFixture({ status = 200, response = page } = {}) {
  const requests = [];
  const discovery = buildSemanticDiscovery({ repositoryRoot, mediaOrigin: 'http://127.0.0.1:19082' });
  const server = createServer(async (request, responseWriter) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
    if (request.method === 'GET' && request.url === '/internal/semantic') {
      responseWriter.writeHead(200, { 'content-type': 'application/json' });
      responseWriter.end(JSON.stringify(discovery));
      return;
    }
    responseWriter.writeHead(status, { 'content-type': 'application/json' });
    responseWriter.end(JSON.stringify(response));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return { port: server.address().port, requests, close: () => new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise())) };
}

test('Issue #212 Catalog CLI sends explicit base_model_id without a legacy business-path parameter', async () => {
  const fixture = await startFixture();
  try {
    const result = await runCli(fixture.port, ['--mode', 'search', '--base_model_id', '12345678901234567890']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, JSON.stringify(page));
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(fixture.requests[1].body), { mode: 'search', base_model_id: '12345678901234567890' });
  } finally {
    await fixture.close();
  }
});

test('Issue #212 Catalog CLI rejects removed Style base_model_name and batch query parameters before POST', async () => {
  const fixture = await startFixture();
  try {
    for (const args of [['--mode', 'search', '--base_model_name', 'WAI'], ['--mode', 'search', '--queries', 'watercolor']]) {
      const result = await runCli(fixture.port, args);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
    }
    assert.deepEqual(fixture.requests, []);
  } finally {
    await fixture.close();
  }
});

test('Issue #212 Catalog CLI forwards a recognized closed service error only on stderr', async () => {
  const fixture = await startFixture({ status: 404, response: { error: { code: 'CATALOG_REF_NOT_FOUND', message: 'Catalog record was not found.' } } });
  try {
    const result = await runCli(fixture.port, ['--mode', 'resolve', '--id', '1']);
    assert.equal(result.status, 7);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, JSON.stringify({ error: { code: 'CATALOG_REF_NOT_FOUND', message: 'Catalog record was not found.' } }));
  } finally {
    await fixture.close();
  }
});
