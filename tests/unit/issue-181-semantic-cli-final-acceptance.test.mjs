import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/imagegen-semantic-query.mjs');
const BASE_MODEL_PATH = '/internal/semantic/base-models';
const GENERATION_MODEL_PATH = '/internal/semantic/generation-models';
const PACKAGE_VERSION = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8')).version;

function catalogDiscovery() {
  return buildSemanticDiscovery({
    repositoryRoot: REPOSITORY_ROOT,
    mediaOrigin: 'http://127.0.0.1:19082',
    mediaPublicPrefix: '/assets/media'
  });
}

function baseModelPage({ resolve = false } = {}) {
  return {
    contract_id: 'imagegen-source-contract',
    contract_version: 1,
    kind: 'base-model',
    items: [{
      id: '12',
      title: 'Alpha',
      subtitle: null,
      cover_url: null,
      source_release_version: PACKAGE_VERSION,
      result_contract_id: 'imagegen.catalog.base-model.v1',
      data: { name: 'Alpha' }
    }],
    page: 1,
    page_size: resolve ? 1 : 20,
    total_count: 1
  };
}

function generationModelPage({ resolve = false } = {}) {
  return {
    contract_id: 'imagegen-source-contract',
    contract_version: 1,
    kind: 'model',
    items: [{
      id: '21',
      title: 'alpha.safetensors',
      subtitle: 'Fixture Author',
      cover_url: null,
      source_release_version: PACKAGE_VERSION,
      result_contract_id: 'imagegen.catalog.generation-model.v1',
      data: {
        base_model_id: '12',
        file_name: 'alpha.safetensors',
        file_format: 'safetensors',
        precision_or_quantization: 'fp16',
        author: 'Fixture Author',
        version: null,
        description: 'Fixture generation model.',
        usage: 'Use the fixture generation model.',
        skill_name: null
      }
    }],
    page: 1,
    page_size: resolve ? 1 : 20,
    total_count: 1
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startFixtureServer({ discovery, expectedPath, responseBody = null }) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({ method: request.method, url: request.url, body });
    if (request.method === 'GET' && request.url === '/internal/semantic') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(discovery));
      return;
    }
    if (request.method === 'POST' && request.url === expectedPath) {
      response.writeHead(200, { 'content-type': 'application/json' });
      const payload = typeof responseBody === 'function' ? responseBody({ body }) : responseBody;
      response.end(JSON.stringify(payload));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST' } }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return {
    server,
    port: server.address().port,
    requests,
    close: () => new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    })
  };
}

function runCli(args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
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

function assertSuccessfulInformation(result, expectedText) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, expectedText);
}

test('Issue #181 uses one CLI file for complete Catalog acceptance across two isolated loopback ports', async (t) => {
  const callerDirectory = await mkdtemp(join(tmpdir(), 'noobai-issue-181-caller-'));
  const discovery = catalogDiscovery();
  const primary = await startFixtureServer({
    discovery,
    expectedPath: BASE_MODEL_PATH,
    responseBody: ({ body }) => body.includes('"mode":"resolve"') ? baseModelPage({ resolve: true }) : baseModelPage()
  });
  const secondary = await startFixtureServer({
    discovery,
    expectedPath: GENERATION_MODEL_PATH,
    responseBody: ({ body }) => body.includes('"mode":"resolve"') ? generationModelPage({ resolve: true }) : generationModelPage()
  });
  let evidence;
  try {
    assert.notEqual(primary.port, secondary.port);
    const cliSource = await readFile(CLI_PATH, 'utf8');
    for (const legacyFixtureName of [
      '/fixture/semantic/',
      'signals',
      'clarity',
      'catalog_key',
      'locale_hint',
      'descriptions',
      'maximum_hits',
      'accepted_by',
      'queries'
    ]) assert.equal(cliSource.includes(legacyFixtureName), false, `CLI source unexpectedly contains ${legacyFixtureName}`);

    const commands = {
      primaryHelp: ['--port', String(primary.port)],
      primaryPathHelp: ['--port', String(primary.port), '--path', BASE_MODEL_PATH, '--help'],
      primaryQuery: [
        '--port', String(primary.port),
        '--path', BASE_MODEL_PATH,
        '--mode', 'search',
        '--query', 'alpha',
        '--page', '1',
        '--page_size', '20'
      ],
      primaryResolve: [
        '--port', String(primary.port),
        '--path', BASE_MODEL_PATH,
        '--mode', 'resolve',
        '--id', '12'
      ],
      secondaryHelp: ['--port', String(secondary.port)],
      secondaryPathHelp: ['--port', String(secondary.port), '--path', GENERATION_MODEL_PATH, '--help'],
      secondaryQuery: [
        '--port', String(secondary.port),
        '--path', GENERATION_MODEL_PATH,
        '--mode', 'search',
        '--query', 'sdxl',
        '--page', '1',
        '--page_size', '20',
        '--base_model_id', '12'
      ],
      secondaryResolve: [
        '--port', String(secondary.port),
        '--path', GENERATION_MODEL_PATH,
        '--mode', 'resolve',
        '--id', '21'
      ]
    };
    const results = {};
    for (const [name, args] of Object.entries(commands)) results[name] = await runCli(args, callerDirectory);

    assertSuccessfulInformation(results.primaryHelp, /POST \/internal\/semantic\/base-models - Search or resolve base-model records/u);
    assertSuccessfulInformation(results.primaryPathHelp, /--mode search/u);
    assert.match(results.primaryPathHelp.stdout, /--query watercolor/u);
    assert.equal(results.primaryQuery.stdout, JSON.stringify(baseModelPage()));
    assert.equal(results.primaryQuery.stderr, '');
    assert.equal(results.primaryResolve.stdout, JSON.stringify(baseModelPage({ resolve: true })));
    assert.equal(results.primaryResolve.stderr, '');

    assertSuccessfulInformation(results.secondaryHelp, /POST \/internal\/semantic\/generation-models - Search or resolve generation-model records/u);
    assertSuccessfulInformation(results.secondaryPathHelp, /--base_model_id 123/u);
    assert.equal(results.secondaryQuery.stdout, JSON.stringify(generationModelPage()));
    assert.equal(results.secondaryQuery.stderr, '');
    assert.equal(results.secondaryResolve.stdout, JSON.stringify(generationModelPage({ resolve: true })));
    assert.equal(results.secondaryResolve.stderr, '');

    assert.equal(primary.requests.length, 6);
    assert.equal(primary.requests.filter((request) => request.url === '/internal/semantic').length, 4);
    assert.deepEqual(primary.requests.at(-3), {
      method: 'POST',
      url: BASE_MODEL_PATH,
      body: JSON.stringify({ mode: 'search', query: 'alpha', page: 1, page_size: 20 })
    });
    assert.deepEqual(primary.requests.at(-1), {
      method: 'POST',
      url: BASE_MODEL_PATH,
      body: JSON.stringify({ mode: 'resolve', id: '12' })
    });
    assert.equal(secondary.requests.length, 6);
    assert.equal(secondary.requests.filter((request) => request.url === '/internal/semantic').length, 4);
    assert.deepEqual(secondary.requests.at(-3), {
      method: 'POST',
      url: GENERATION_MODEL_PATH,
      body: JSON.stringify({ mode: 'search', query: 'sdxl', page: 1, page_size: 20, base_model_id: '12' })
    });
    assert.deepEqual(secondary.requests.at(-1), {
      method: 'POST',
      url: GENERATION_MODEL_PATH,
      body: JSON.stringify({ mode: 'resolve', id: '21' })
    });

    evidence = {
      cli_file: CLI_PATH,
      caller_directory: callerDirectory,
      ports: { primary: primary.port, secondary: secondary.port },
      commands: Object.fromEntries(Object.entries(commands).map(([name, args]) => [name, [process.execPath, CLI_PATH, ...args]])),
      results,
      requests: { primary: primary.requests, secondary: secondary.requests },
      request_counts: {
        primary: { discovery: 4, catalog: 2, total: primary.requests.length },
        secondary: { discovery: 4, catalog: 2, total: secondary.requests.length }
      }
    };
  } finally {
    await Promise.all([primary.close(), secondary.close()]);
    await rm(callerDirectory, { recursive: true, force: true });
  }
  assert.equal(primary.server.listening, false);
  assert.equal(secondary.server.listening, false);
  await assert.rejects(() => access(callerDirectory), { code: 'ENOENT' });
  evidence.cleanup = {
    primary_listener_closed: !primary.server.listening,
    secondary_listener_closed: !secondary.server.listening,
    caller_directory_removed: true
  };
  t.diagnostic(`ISSUE_181_EVIDENCE ${JSON.stringify(evidence)}`);
});

test('Issue #181 Catalog discovery schema mutations fail closed before any Catalog request', async () => {
  const mutations = [
    (discovery) => { discovery.components.schemas.CatalogBaseModelRequest.additionalProperties = true; },
    (discovery) => { discovery.components.schemas.CatalogBaseModelSearchRequest.properties.query.maxLength = 201; },
    (discovery) => { discovery.components.schemas.CatalogBaseModelResolveRequest.properties.id.pattern = '^[0-9]+$'; }
  ];
  for (const mutate of mutations) {
    const discovery = structuredClone(catalogDiscovery());
    mutate(discovery);
    const fixture = await startFixtureServer({ discovery, expectedPath: BASE_MODEL_PATH });
    try {
      const result = await runCli(['--port', String(fixture.port)]);
      assert.equal(result.status, 6, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '{"error":{"code":"CONTRACT_PROTOCOL_ERROR","message":"Source contract response is invalid."}}\n');
      assert.deepEqual(fixture.requests, [{ method: 'GET', url: '/internal/semantic', body: '' }]);
    } finally {
      await fixture.close();
    }
  }
});
