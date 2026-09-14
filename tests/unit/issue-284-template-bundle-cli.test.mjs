import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';

import { buildSourceDiscovery } from '../../app/http/source-discovery.mjs';
import { SOURCE_TEMPLATE_BUNDLE_PATH } from '../../app/contracts/source-contract.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/catalog/imagegen-comfyui-source-read.mjs');
const TEMPLATE_ID = '284001';

function templateBundle(overrides = {}) {
  return {
    id: Number(TEMPLATE_ID),
    title: 'Issue 284 template',
    workflow_json: {
      version: 0.4,
      last_node_id: 2,
      last_link_id: 0,
      nodes: [],
      links: [],
      groups: [],
      config: {},
      extra: {}
    },
    ...overrides
  };
}

function runCli(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: '/',
      env: { ...process.env, ...(options.env ?? {}) },
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
    if (typeof options.onChild === 'function') options.onChild(child);
  });
}

function runCliBuffers(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: '/',
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => { stdout.push(Buffer.from(chunk)); });
    child.stderr.on('data', (chunk) => { stderr.push(Buffer.from(chunk)); });
    child.on('error', rejectPromise);
    child.on('close', (status, signal) => resolvePromise({
      status,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr)
    }));
    if (typeof options.onChild === 'function') options.onChild(child);
  });
}

async function startServer({
  discovery = buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT }),
  discoveryStatus = 200,
  discoveryBody,
  bundleStatus = 200,
  bundleBody = templateBundle(),
  bundleDelayMs = 0,
  hangBundle = false
} = {}) {
  const requests = [];
  let bundleStarted;
  const bundleStartedPromise = new Promise((resolvePromise) => { bundleStarted = resolvePromise; });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
      if (request.method === 'GET' && request.url === '/internal/comfyui-source') {
        response.writeHead(discoveryStatus, { 'content-type': 'application/json' });
        response.end(discoveryBody === undefined ? JSON.stringify(discovery) : discoveryBody);
        return;
      }
      if (request.method === 'GET' && request.url === `/internal/comfyui-source/templates/${TEMPLATE_ID}/bundle`) {
        bundleStarted();
        if (hangBundle) return;
        if (bundleDelayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, bundleDelayMs));
        response.writeHead(bundleStatus, { 'content-type': 'application/json' });
        response.end(Buffer.isBuffer(bundleBody) || typeof bundleBody === 'string' ? bundleBody : JSON.stringify(bundleBody));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return {
    port: server.address().port,
    requests,
    bundleStarted: bundleStartedPromise,
    close: () => new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()))
  };
}

function assertFixedError(result, code, status, message) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, JSON.stringify({ error: { code, message } }) + '\n');
}

function assertServiceError(result, body) {
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, typeof body === 'string' ? body : JSON.stringify(body));
}

function assertFixedBufferError(result, code, status, message) {
  assert.equal(result.status, status, result.stderr.toString('utf8'));
  assert.equal(result.signal, null);
  assert.equal(result.stdout.length, 0);
  assert.deepEqual(result.stderr, Buffer.from(`${JSON.stringify({ error: { code, message } })}\n`, 'utf8'));
}

async function withServer(options, callback) {
  const fixture = await startServer(options);
  try {
    return await callback(fixture);
  } finally {
    await fixture.close();
  }
}

test('Issue 284 Source CLI reads a complete TemplateBundle from the live second operation', async () => {
  await withServer({}, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), templateBundle());
    assert.deepEqual(fixture.requests.map(({ method, url }) => ({ method, url })), [
      { method: 'GET', url: '/internal/comfyui-source' },
      { method: 'GET', url: `${SOURCE_TEMPLATE_BUNDLE_PATH.replace('{template_id}', TEMPLATE_ID)}` }
    ]);
  });
});

test('Issue 284 Source CLI rejects invalid TemplateBundle IDs before network access', async () => {
  await withServer({}, async (fixture) => {
    for (const id of ['0', '01', '1.0', '123456789012345678901']) {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', id]);
      assertFixedError(result, 'INVALID_ARGUMENT', 2, 'CLI arguments are invalid.');
    }
    assert.deepEqual(fixture.requests, []);
  });
});

test('Issue 286 Source CLI forwards any non-empty JSON value from a 2xx Template Bundle response unchanged', async () => {
  for (const responseText of [
    '  ["opaque-template-no-final-newline"]  ',
    '\n\t["opaque-template-with-final-newline"]\n'
  ]) {
    await withServer({ bundleStatus: 201, bundleBody: responseText }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, responseText);
    });
  }
});

test('Issue 286 Template Bundle CLI forwards arbitrary undeclared non-2xx JSON as raw stderr', async () => {
  const responseText = '\n {"error":{"code":"UNDECLARED_TEMPLATE_ERROR","message":"preserve this body"}} \n';
  await withServer({ bundleStatus: 599, bundleBody: responseText }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
    assert.equal(result.status, 7, result.stderr);
    assert.notEqual(result.status, 6);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, responseText);
  });
});

test('Issue 286 Template Bundle CLI preserves response Buffers and rejects invalid UTF-8, empty, and multiple JSON bodies', async () => {
  const validBody = Buffer.from('\t{"message":"模板原始多字节响应"} \n', 'utf8');
  await withServer({ bundleStatus: 201, bundleBody: validBody }, async (fixture) => {
    const result = await runCliBuffers(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
    assert.equal(result.status, 0, result.stderr.toString('utf8'));
    assert.equal(result.signal, null);
    assert.deepEqual(result.stdout, validBody);
    assert.equal(result.stderr.length, 0);
  });

  const serviceErrorBody = Buffer.from('\n{"error":{"message":"模板原始错误多字节"}}\n', 'utf8');
  await withServer({ bundleStatus: 599, bundleBody: serviceErrorBody }, async (fixture) => {
    const result = await runCliBuffers(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
    assert.equal(result.status, 7, result.stderr.toString('utf8'));
    assert.equal(result.signal, null);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(result.stderr, serviceErrorBody);
  });

  const invalidUtf8Body = Buffer.from([0x7b, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  for (const bundleBody of [invalidUtf8Body, Buffer.alloc(0), Buffer.from('{}{}', 'utf8')]) {
    await withServer({ bundleBody }, async (fixture) => {
      const result = await runCliBuffers(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
      assertFixedBufferError(result, 'CONTRACT_PROTOCOL_ERROR', 6, 'Source contract response is invalid.');
    });
  }
});

test('Issue 284 Source CLI ignores declared response statuses while leaving Template Bundle success JSON opaque', async () => {
  const canonical = buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  const openRoot = structuredClone(canonical);
  openRoot.components.schemas.CatalogSourceResultRecord.additionalProperties = true;
  const openBinding = structuredClone(canonical);
  openBinding.components.schemas.CatalogSourceResultRecord.description = 'Opaque database record.';
  for (const discovery of [openRoot, openBinding]) {
    const responseText = ' ["opaque-template-schema"] ';
    await withServer({ discovery, bundleBody: responseText }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, responseText);
    });
  }
  const cases = [];
  const missingBundleStatus = structuredClone(canonical);
  delete missingBundleStatus.paths[SOURCE_TEMPLATE_BUNDLE_PATH].get.responses['409'];
  cases.push({ discovery: missingBundleStatus });
  const extraBundleStatus = structuredClone(canonical);
  extraBundleStatus.paths[SOURCE_TEMPLATE_BUNDLE_PATH].get.responses['418'] = structuredClone(extraBundleStatus.paths[SOURCE_TEMPLATE_BUNDLE_PATH].get.responses['500']);
  cases.push({ discovery: extraBundleStatus });
  for (const options of cases) {
    await withServer({ ...options, bundleBody: ' ["opaque-template-response-status"] ' }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, ' ["opaque-template-response-status"] ');
    });
  }

  for (const bundleBody of [
    '',
    '   ',
    'not-json',
    '{}{}'
  ]) {
    await withServer({ bundleBody }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
      assertFixedError(result, 'CONTRACT_PROTOCOL_ERROR', 6, 'Source contract response is invalid.');
    });
  }
  for (const bundleBody of [
    { ...templateBundle(), unexpected: true },
    { ...templateBundle(), legacy_metadata: { release: 'not-semver' } },
    { ...templateBundle(), opaque_extension: [{ name: 'preserved-by-generic-cli' }] }
  ]) {
    await withServer({ bundleBody }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(bundleBody));
    });
  }
});

test('Issue 284 Source CLI forwards fixed TemplateBundle service errors and keeps stdout empty', async () => {
  const errors = [
    [404, 'SOURCE_TEMPLATE_NOT_FOUND', 'ComfyUI template was not found.'],
    [409, 'SOURCE_TEMPLATE_UNAVAILABLE', 'ComfyUI template data is unavailable.'],
    [422, 'SOURCE_REQUEST_INVALID', 'Source request is invalid.'],
    [500, 'SOURCE_INTERNAL_ERROR', 'Source read failed.'],
    [503, 'SOURCE_DATABASE_BUSY', 'Source catalog is busy.']
  ];
  for (const [status, code, message] of errors) {
    await withServer({ bundleStatus: status, bundleBody: { error: { code, message } } }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
      assertServiceError(result, { error: { code, message } });
    });
  }
});

test('Issue 284 Source CLI maps TemplateBundle timeout and parent cancellation', async () => {
  await withServer({ bundleDelayMs: 80 }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--timeout-ms', '20', 'template-bundle', '--id', TEMPLATE_ID]);
    assertFixedError(result, 'TOTAL_TIMEOUT', 5, 'Source request timed out.');
  });
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    await withServer({ hangBundle: true }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID], {
        onChild: async (child) => {
          await fixture.bundleStarted;
          child.kill(signal);
        }
      });
      assertFixedError(result, 'PROCESS_CANCELLED', status, `Source request was cancelled by ${signal}.`);
    });
  }
});

test('Issue 284 Source CLI provides offline progressive help for both Source commands', async () => {
  await withServer({}, async (fixture) => {
    const top = await runCli(['--help']);
    assert.equal(top.status, 0);
    assert.equal(top.stderr, '');
    assert.match(top.stdout, /instance --help/);
    assert.match(top.stdout, /template-bundle --help/);
    assert.equal(fixture.requests.length, 0);

    const bundleHelp = await runCli(['template-bundle', '--help']);
    assert.equal(bundleHelp.status, 0);
    assert.equal(bundleHelp.stderr, '');
    assert.match(bundleHelp.stdout, /Usage:/);
    assert.match(bundleHelp.stdout, /Parameters:/);
    assert.match(bundleHelp.stdout, /Example:/);
    assert.match(bundleHelp.stdout, /Output:/);
    assert.match(bundleHelp.stdout, /template-bundle --id <stable-template-id>/);
    assert.match(bundleHelp.stdout, /Stable ID from the corresponding ComfyUI template Catalog item/);
    assert.match(bundleHelp.stdout, /2xx body: the CLI requires the target HTTP body to be non-empty, decode as strict UTF-8, and contain exactly one JSON value; the CLI does not validate a response Schema or fields, and writes the original body Buffer to stdout without adding or removing bytes; stderr is empty and exit code is 0\./);
    assert.match(bundleHelp.stdout, /Non-2xx body: the CLI requires the target HTTP body to be non-empty, decode as strict UTF-8, and contain exactly one JSON value, then writes the original body Buffer to stderr without adding or removing bytes; stdout is empty and exit code is 7; the CLI does not validate the declared HTTP status, Schema, fields, or error code\./);
    assert.match(bundleHelp.stdout, /Target body failure: an empty body, invalid UTF-8, invalid JSON, or multiple JSON values leaves stdout empty, writes the fixed CONTRACT_PROTOCOL_ERROR JSON to stderr, and exits 6\./);
    assert.match(bundleHelp.stdout, /Local failure: the CLI writes a fixed CLI error JSON to stderr, leaves stdout empty, and exits with its corresponding non-zero code for invalid arguments, discovery failure, connection failure, timeout, cancellation, or any other local failure\./);
    assert.doesNotMatch(bundleHelp.stdout, /instance --id/);

    const instanceHelp = await runCli(['instance', '--help']);
    assert.equal(instanceHelp.status, 0);
    assert.equal(instanceHelp.stderr, '');
    assert.match(instanceHelp.stdout, /Example:/);
    assert.match(instanceHelp.stdout, /instance --id <stable-instance-id>/);
    assert.match(instanceHelp.stdout, /Stable ID from the corresponding ComfyUI instance Catalog item/);
    assert.match(instanceHelp.stdout, /2xx body: the CLI requires the target HTTP body to be non-empty, decode as strict UTF-8, and contain exactly one JSON value; the CLI does not validate a response Schema or fields, and writes the original body Buffer to stdout without adding or removing bytes; stderr is empty and exit code is 0\./);
    assert.match(instanceHelp.stdout, /Non-2xx body: the CLI requires the target HTTP body to be non-empty, decode as strict UTF-8, and contain exactly one JSON value, then writes the original body Buffer to stderr without adding or removing bytes; stdout is empty and exit code is 7; the CLI does not validate the declared HTTP status, Schema, fields, or error code\./);
    assert.match(instanceHelp.stdout, /Target body failure: an empty body, invalid UTF-8, invalid JSON, or multiple JSON values leaves stdout empty, writes the fixed CONTRACT_PROTOCOL_ERROR JSON to stderr, and exits 6\./);
    assert.match(instanceHelp.stdout, /Local failure: the CLI writes a fixed CLI error JSON to stderr, leaves stdout empty, and exits with its corresponding non-zero code for invalid arguments, discovery failure, connection failure, timeout, cancellation, or any other local failure\./);
    assert.equal(fixture.requests.length, 0);
  });
});

test('Issue 284 Source CLI keeps closed-port, empty, and invalid JSON responses non-zero', async () => {
  const closedServer = await startServer({});
  const port = closedServer.port;
  await closedServer.close();
  assertFixedError(
    await runCli(['--port', String(port), 'template-bundle', '--id', TEMPLATE_ID]),
    'SOURCE_CONNECTION_FAILED',
    4,
    'Source service is unavailable.'
  );
  for (const bundleBody of ['', '   ', 'not-json', '{}{}']) {
    await withServer({ bundleBody }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'template-bundle', '--id', TEMPLATE_ID]);
      assertFixedError(result, 'CONTRACT_PROTOCOL_ERROR', 6, 'Source contract response is invalid.');
    });
  }
});
