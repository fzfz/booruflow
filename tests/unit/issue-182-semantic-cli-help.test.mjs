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

async function withDiscoveryServer(callback) {
  const requests = [];
  const discovery = buildSemanticDiscovery({ repositoryRoot, mediaOrigin: 'http://127.0.0.1:19082' });
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method === 'GET' && request.url === '/internal/semantic') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(discovery));
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

test('Issue #182 offline help is fixed, does not contact discovery, and does not expose Catalog fields', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /imagegen-semantic-query/u);
  assert.match(result.stdout, /--path <catalog-operation-path> --mode search/u);
  assert.match(result.stdout, /--path <catalog-operation-path> --mode resolve --id <stable-id>/u);
  assert.doesNotMatch(result.stdout, /queries|groups|base_model_name|x-noobai/u);
});

test('Issue #182 live help lists Catalog operations and operation help uses the live schema example', async () => {
  await withDiscoveryServer(async ({ port, requests }) => {
    const list = await runCli(['--port', String(port), '--help']);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(list.stderr, '');
    assert.match(list.stdout, /POST \/internal\/semantic\/base-models/u);
    assert.match(list.stdout, /POST \/internal\/semantic\/generation-models/u);
    assert.doesNotMatch(list.stdout, /base_model_id|watercolor|operationId|responses/u);
    assert.deepEqual(requests, [{ method: 'GET', url: '/internal/semantic' }]);

    const operation = await runCli(['--port', String(port), '--path', baseModelPath, '--help']);
    assert.equal(operation.status, 0, operation.stderr);
    assert.equal(operation.stderr, '');
    assert.match(operation.stdout, /Usage:|Parameters:|Example:/u);
    assert.match(operation.stdout, /--mode search/u);
    assert.doesNotMatch(operation.stdout, /queries|groups|operationId|responses/u);
  });
});

test('Issue #182 keeps legal Catalog paths while rejecting dynamic paths and hyphenated business flags', async () => {
  const local = await runCli(['--port', '1234', '--path', baseModelPath, '--page-size', '2']);
  assert.equal(local.status, 2);
  assert.equal(local.stdout, '');
  assert.equal(JSON.parse(local.stderr).error.code, 'INVALID_ARGUMENT');

  await withDiscoveryServer(async ({ port }) => {
    const legal = await runCli(['--port', String(port), '--path', '/internal/semantic/works', '--help']);
    assert.equal(legal.status, 0, legal.stderr);
    assert.equal(legal.stdout.includes('Usage:'), true);
    assert.equal(legal.stderr, '');

    const result = await runCli(['--port', String(port), '--path', '/internal/semantic/works/123', '--help']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
  });
});
