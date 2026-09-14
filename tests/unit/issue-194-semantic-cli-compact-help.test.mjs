import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = resolve(repositoryRoot, 'scripts/catalog/imagegen-semantic-query.mjs');
const operationPath = '/internal/semantic/base-models';

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

async function startDiscoveryServer() {
  const requests = [];
  const discovery = buildSemanticDiscovery({ repositoryRoot, mediaOrigin: 'http://127.0.0.1:19082' });
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method === 'GET' && request.url === '/internal/semantic') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(discovery));
      return;
    }
    response.writeHead(418, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'help must not query Catalog data' } }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return { port: server.address().port, requests, close: () => new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise())) };
}

test('Issue #194 Catalog operation help stays compact, live, and query-ready', async () => {
  const fixture = await startDiscoveryServer();
  try {
    const result = await runCli(['--port', String(fixture.port), '--path', operationPath, '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const usageIndex = result.stdout.indexOf('Usage:');
    const parametersIndex = result.stdout.indexOf('Parameters:');
    assert.ok(usageIndex >= 0 && usageIndex < parametersIndex);
    assert.match(result.stdout, /Example:/u);
    assert.match(result.stdout, /--mode search/u);
    assert.match(result.stdout, /--mode resolve --id <stable-id>/u);
    assert.match(result.stdout, /--id[\s\S]*Type: string[\s\S]*required[\s\S]*length 1\.\.20[\s\S]*stable positive decimal ID/u);
    assert.match(result.stdout, /--query/u);
    assert.match(result.stdout, /--page/u);
    assert.match(result.stdout, /--page_size/u);
    assert.doesNotMatch(result.stdout, /Operation ID:|requestBody|responses|groups|queries/u);
    assert.equal((result.stdout.match(/^Example:\n/gmu) ?? []).length, 1);
    assert.deepEqual(fixture.requests, [{ method: 'GET', url: '/internal/semantic' }]);
  } finally {
    await fixture.close();
  }
});

test('Issue #194 top-level and live operation help are separate levels', async () => {
  const offline = await runCli(['--help']);
  assert.equal(offline.status, 0, offline.stderr);
  const globalOptions = offline.stdout.slice(offline.stdout.indexOf('Global options:'), offline.stdout.indexOf('Next:'));
  assert.doesNotMatch(globalOptions, /--(?:query|page_size)|Operation ID|groups/u);
  assert.doesNotMatch(offline.stdout, /^Operations:/mu);

  const fixture = await startDiscoveryServer();
  try {
    const live = await runCli(['--port', String(fixture.port), '--help']);
    assert.equal(live.status, 0, live.stderr);
    assert.match(live.stdout, /POST \/internal\/semantic\/base-models/u);
    const operations = live.stdout.slice(live.stdout.indexOf('Operations:'));
    assert.doesNotMatch(live.stdout, /Usage:|Global options:/u);
    assert.doesNotMatch(operations, /--query|--page_size|requestBody|responses/u);
    assert.deepEqual(fixture.requests, [{ method: 'GET', url: '/internal/semantic' }]);
  } finally {
    await fixture.close();
  }
});
