import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/imagegen-semantic-query.mjs');
const BASE_PATH = '/internal/semantic/base-models';
const MODEL_PATH = '/internal/semantic/generation-models';

function liveDiscovery() {
  return buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin: 'http://127.0.0.1:19082', mediaPublicPrefix: '/assets/media' });
}

function runCli(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: '/',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
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

async function startServer({ discovery = liveDiscovery() } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method !== 'GET' || request.url !== '/internal/semantic') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(discovery));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()))
  };
}

function assertCliError(result, code, status, label = '') {
  assert.equal(result.status, status, label === '' ? result.stderr : `${label}: ${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^\{"error":\{"code":"[A-Z_]+","message":"[^"\n]+"\}\}\n$/u);
  assert.equal(JSON.parse(result.stderr).error.code, code);
}

test('Issue 278 CLI offline help and version do not contact a service', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.equal(help.stdout.endsWith('\n'), true);
  assert.match(help.stdout, /imagegen-semantic-query/u);
  assert.match(help.stdout, /--port <port>/u);
  assert.match(help.stdout, /--discovery-json/u);
  assert.match(help.stdout, /--path <catalog-operation-path> --mode search/u);
  assert.match(help.stdout, /--path <catalog-operation-path> --mode resolve --id <stable-id>/u);
  assert.doesNotMatch(help.stdout, /queries|groups|x-noobai-callable-projection/u);
  assert.doesNotMatch(help.stdout, /^Operations:/mu);
  const globalOptions = help.stdout.slice(help.stdout.indexOf('Global options:'), help.stdout.indexOf('Next:'));
  assert.doesNotMatch(globalOptions, /--(?:mode|query|page|page_size|base_model_id|work_id|id)(?:\s|$)/u);

  const version = await runCli(['--version']);
  assert.deepEqual(version, { status: 0, signal: null, stdout: 'imagegen-semantic-query 2.0.0\n', stderr: '' });
});

test('Issue 278 CLI live list help and discovery JSON use the live Catalog document', async (t) => {
  const fixture = await startServer();
  t.after(() => fixture.close());

  const help = await runCli(['--port', String(fixture.port), '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, new RegExp(`POST ${BASE_PATH}`, 'u'));
  assert.match(help.stdout, new RegExp(`POST ${MODEL_PATH}`, 'u'));
  assert.match(help.stdout, /--path <operation-path> --help/u);
  assert.doesNotMatch(help.stdout, /watercolor|base_model_id|CatalogBaseModel/u);
  assert.doesNotMatch(help.stdout, /Usage:|Global options:/u);
  assert.deepEqual(fixture.requests, [{ method: 'GET', url: '/internal/semantic' }]);

  const discovery = await runCli(['--port', String(fixture.port), '--discovery-json']);
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.equal(discovery.stderr, '');
  assert.equal(discovery.stdout, JSON.stringify(liveDiscovery()));
});

test('Issue 278 CLI operation help uses only the live search request example', async (t) => {
  const discovery = structuredClone(liveDiscovery());
  const searchSchema = discovery.components.schemas.CatalogBaseModelSearchRequest;
  searchSchema.properties.query.example = 'live-only-query';
  searchSchema.properties.page.example = 7;
  searchSchema.properties.page_size.example = 3;
  discovery.components.schemas.CatalogBaseModelRequest.example = { mode: 'search', query: 'live-only-query', page: 7, page_size: 3 };
  const fixture = await startServer({ discovery });
  t.after(() => fixture.close());

  const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage:/u);
  assert.match(result.stdout, /Parameters:/u);
  assert.match(result.stdout, /Example:/u);
  assert.match(result.stdout, /--mode search/u);
  assert.match(result.stdout, /--mode resolve --id <stable-id>/u);
  assert.match(result.stdout, /--id[\s\S]*Type: string[\s\S]*required[\s\S]*length 1\.\.20[\s\S]*stable positive decimal ID/u);
  assert.match(result.stdout, /--query live-only-query/u);
  assert.match(result.stdout, /--page 7/u);
  assert.match(result.stdout, /--page_size 3/u);
  assert.doesNotMatch(result.stdout, /watercolor/u);
  assert.doesNotMatch(result.stdout, /CatalogBaseModel|operationId|requestBody|responses/u);
});

test('Issue 278 CLI rejects undocumented Catalog identities and fields', async () => {
  const mutations = [
    { label: 'unknown registered path', mutate: (discovery) => {
      const operation = discovery.paths[BASE_PATH];
      delete discovery.paths[BASE_PATH];
      discovery.paths['/internal/semantic/widgets'] = operation;
    } },
    { label: 'base operation identity', mutate: (discovery) => { discovery.paths[BASE_PATH].post.operationId = 'querySemanticGenerationModelsForSkill'; } },
    { label: 'base tool identity', mutate: (discovery) => { discovery.paths[BASE_PATH].post['x-harness-tool-name'] = 'query_semantic_generation_models'; } },
    { label: 'generation operation identity', mutate: (discovery) => { discovery.paths[MODEL_PATH].post.operationId = 'querySemanticBaseModelsForSkill'; } },
    { label: 'generation tool identity', mutate: (discovery) => { discovery.paths[MODEL_PATH].post['x-harness-tool-name'] = 'query_semantic_base_models'; } },
    { label: 'generation filter missing', mutate: (discovery) => {
      const generationProperties = discovery.components.schemas.CatalogGenerationModelSearchRequest.properties;
      delete generationProperties.base_model_id;
    } },
    { label: 'base filter unexpected', mutate: (discovery) => {
      const baseProperties = discovery.components.schemas.CatalogBaseModelSearchRequest.properties;
      baseProperties.base_model_id = structuredClone(discovery.components.schemas.CatalogGenerationModelSearchRequest.properties.base_model_id);
    } },
    { label: 'generation filter unexpected', mutate: (discovery) => {
      const generationProperties = discovery.components.schemas.CatalogGenerationModelSearchRequest.properties;
      generationProperties.work_id = structuredClone(generationProperties.base_model_id);
    } },
    { label: 'missing operation summary', mutate: (discovery) => { discovery.paths[BASE_PATH].post.summary = ''; } },
    { label: 'open request root', mutate: (discovery) => { discovery.components.schemas.CatalogBaseModelRequest.additionalProperties = true; } },
    { label: 'closed request root', mutate: (discovery) => { discovery.components.schemas.CatalogBaseModelRequest.additionalProperties = false; } },
    { label: 'open search branch', mutate: (discovery) => { discovery.components.schemas.CatalogBaseModelSearchRequest.additionalProperties = true; } },
    { label: 'resolve branch closure omitted', mutate: (discovery) => { delete discovery.components.schemas.CatalogBaseModelResolveRequest.additionalProperties; } },
    { label: 'request oneOf structure', mutate: (discovery) => { discovery.components.schemas.CatalogBaseModelRequest.oneOf = [discovery.components.schemas.CatalogBaseModelRequest.oneOf[0]]; } },
    { label: 'missing field example', mutate: (discovery) => { delete discovery.components.schemas.CatalogBaseModelSearchRequest.properties.query.example; } },
    { label: 'missing resolve example', mutate: (discovery) => { delete discovery.paths[BASE_PATH].post.requestBody.content['application/json'].examples.resolve; } },
    { label: 'mismatched named example', mutate: (discovery) => { discovery.paths[BASE_PATH].post.requestBody.content['application/json'].examples.resolve.value.mode = 'search'; } }
  ];
  for (const { label, mutate } of mutations) {
    const discovery = structuredClone(liveDiscovery());
    mutate(discovery);
    const fixture = await startServer({ discovery });
    const result = await runCli(['--port', String(fixture.port), '--help']);
    await fixture.close();
    assertCliError(result, 'CONTRACT_PROTOCOL_ERROR', 6, label);
  }
});

test('Issue 278 CLI rejects invalid arguments before contacting the loopback service and rejects unknown paths after discovery', async () => {
  for (const args of [
    ['--port', '0', '--discovery-json'],
    ['--port', '65536', '--discovery-json'],
    ['--port', '1234', '--timeout-ms', '0', '--discovery-json'],
    ['--port', '1234', '--timeout-ms', '600001', '--discovery-json'],
    ['--port', '1234', '--discovery-json', '--path', BASE_PATH],
    ['--port', '1234', '--path', BASE_PATH, '--queries', 'old'],
    ['--port', '1234', '--path', BASE_PATH, '--limit', '3'],
    ['--port', '1234', '--path', BASE_PATH, '--page-size', '3'],
    ['--port', '1234', '--path', BASE_PATH, '--base-model-id', '1'],
    ['--port', '1234', '--path', BASE_PATH, '--work-id', '1']
  ]) {
    const result = await runCli(args);
    assertCliError(result, 'INVALID_ARGUMENT', 2);
  }

  const fixture = await startServer();
  const result = await runCli(['--port', String(fixture.port), '--path', '/internal/semantic/unknown', '--help']);
  await fixture.close();
  assertCliError(result, 'INVALID_ARGUMENT', 2);
  assert.deepEqual(fixture.requests, [{ method: 'GET', url: '/internal/semantic' }]);
});
