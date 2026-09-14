import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';

import { buildSourceDiscovery } from '../../app/http/source-discovery.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/imagegen-comfyui-source-read.mjs');

function instanceSource(overrides = {}) {
  return {
    id: 31,
    title: 'Fixture ComfyUI',
    url: 'http://127.0.0.1:8188/',
    credential_type: 'none',
    authorization: null,
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

async function startServer({ discovery = buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT }), discoveryStatus = 200, discoveryBody, instanceStatus = 200, instanceBody = instanceSource(), instanceDelayMs = 0, hangInstance = false } = {}) {
  const requests = [];
  let instanceStarted;
  const instanceStartedPromise = new Promise((resolvePromise) => { instanceStarted = resolvePromise; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
      if (request.method === 'GET' && request.url === '/internal/comfyui-source') {
        response.writeHead(discoveryStatus, { 'content-type': 'application/json' });
        response.end(discoveryBody === undefined ? JSON.stringify(discovery) : discoveryBody);
        return;
      }
      if (request.method === 'GET' && request.url === '/internal/comfyui-source/instances/31') {
        instanceStarted();
        if (hangInstance) return;
        if (instanceDelayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, instanceDelayMs));
        response.writeHead(instanceStatus, { 'content-type': 'application/json' });
        response.end(Buffer.isBuffer(instanceBody) || typeof instanceBody === 'string' ? instanceBody : JSON.stringify(instanceBody));
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
    instanceStarted: instanceStartedPromise,
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

test('Issue 283 Source CLI reads one live-discovered instance and emits the raw success JSON', async () => {
  await withServer({}, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(instanceSource()));
    assert.deepEqual(fixture.requests.map(({ method, url }) => ({ method, url })), [
      { method: 'GET', url: '/internal/comfyui-source' },
      { method: 'GET', url: '/internal/comfyui-source/instances/31' }
    ]);
  });
});

test('Issue 283 Source CLI keeps Authorization in successful stdout only and rejects invalid local arguments', async () => {
  await withServer({ instanceBody: instanceSource({ credential_type: 'bearer', authorization: 'Bearer fixture-token' }) }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).authorization, 'Bearer fixture-token');
    assert.equal(result.stderr, '');
  });
  await withServer({}, async (fixture) => {
    for (const args of [
      ['instance'],
      ['instance', '--id', '0'],
      ['instance', '--id', '01'],
      ['instance', '--id', '123456789012345678901'],
      ['instance', '--id', '1.0'],
      ['instance', '--id', '31', '--hostname', '127.0.0.1'],
      ['--port', 'http://127.0.0.1:8188', 'instance', '--id', '31']
    ]) {
      const result = await runCli(args[0] === '--port' ? args : ['--port', String(fixture.port), ...args]);
      assertFixedError(result, 'INVALID_ARGUMENT', 2, 'CLI arguments are invalid.');
    }
  });
});

test('Issue 286 Source CLI forwards any non-empty JSON value from a 2xx Instance response unchanged', async () => {
  for (const responseText of [
    '  ["opaque-instance-no-final-newline"]  ',
    '\n\t["opaque-instance-with-final-newline"]\n'
  ]) {
    await withServer({ instanceStatus: 201, instanceBody: responseText }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, responseText);
    });
  }
});

test('Issue 286 Instance CLI forwards arbitrary undeclared non-2xx JSON as raw stderr', async () => {
  const responseText = ' {"error":{"code":"UNDECLARED_INSTANCE_ERROR","message":"preserve this body"}} ';
  await withServer({ instanceStatus: 418, instanceBody: responseText }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
    assert.equal(result.status, 7, result.stderr);
    assert.notEqual(result.status, 6);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, responseText);
  });
});

test('Issue 286 Instance CLI preserves response Buffers and rejects invalid UTF-8, empty, and multiple JSON bodies', async () => {
  const validBody = Buffer.from(' \n{"message":"实例原始多字节响应"} \n', 'utf8');
  await withServer({ instanceStatus: 201, instanceBody: validBody }, async (fixture) => {
    const result = await runCliBuffers(['--port', String(fixture.port), 'instance', '--id', '31']);
    assert.equal(result.status, 0, result.stderr.toString('utf8'));
    assert.equal(result.signal, null);
    assert.deepEqual(result.stdout, validBody);
    assert.equal(result.stderr.length, 0);
  });

  const serviceErrorBody = Buffer.from('\n{"error":{"message":"实例原始错误多字节"}}\n', 'utf8');
  await withServer({ instanceStatus: 418, instanceBody: serviceErrorBody }, async (fixture) => {
    const result = await runCliBuffers(['--port', String(fixture.port), 'instance', '--id', '31']);
    assert.equal(result.status, 7, result.stderr.toString('utf8'));
    assert.equal(result.signal, null);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(result.stderr, serviceErrorBody);
  });

  const invalidUtf8Body = Buffer.from([0x7b, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  for (const instanceBody of [invalidUtf8Body, Buffer.alloc(0), Buffer.from('{}{}', 'utf8')]) {
    await withServer({ instanceBody }, async (fixture) => {
      const result = await runCliBuffers(['--port', String(fixture.port), 'instance', '--id', '31']);
      assertFixedBufferError(result, 'CONTRACT_PROTOCOL_ERROR', 6, 'Source contract response is invalid.');
    });
  }
});

test('Issue 283 Source CLI ignores extra discovery metadata while leaving Instance success JSON opaque', async () => {
  const canonicalDiscovery = buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.equal(canonicalDiscovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);
  const discoveryCases = [];
  const extraMetadata = structuredClone(buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT }));
  extraMetadata.legacy_metadata = { identity: 'legacy', release: 'not-semver' };
  discoveryCases.push(extraMetadata);
  const exposedOperation = structuredClone(buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT }));
  exposedOperation.paths['/internal/comfyui-source/instances/{instance_id}'].get['x-harness-tool-name'] = 'leak_source';
  discoveryCases.push(exposedOperation);
  for (const [index, discovery] of discoveryCases.entries()) {
    await withServer({ discovery }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
      assert.equal(result.status, 0, `${index}: ${result.stderr}`);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(instanceSource()));
    });
  }
  const invalidSuccessSchema = structuredClone(canonicalDiscovery);
  invalidSuccessSchema.components.schemas.CatalogSourceResultRecord.additionalProperties = true;
  const unknownUrlSchema = structuredClone(canonicalDiscovery);
  unknownUrlSchema.components.schemas.CatalogSourceResultRecord.unknown = null;
  for (const discovery of [invalidSuccessSchema, unknownUrlSchema]) {
    const responseText = ' ["opaque-instance-schema"] ';
    await withServer({ discovery, instanceBody: responseText }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, responseText);
    });
  }
  for (const instanceBody of [
    { ...instanceSource(), authorization: 'Bearer secret', extra: 'not allowed' },
    instanceSource({ id: 32 })
  ]) {
    await withServer({ instanceBody }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(instanceBody));
    });
  }
});

test('Issue 283 Source CLI forwards fixed service errors and maps timeout and cancellation', async () => {
  await withServer({ instanceStatus: 500, instanceBody: { error: { code: 'SOURCE_CREDENTIAL_UNAVAILABLE', message: 'ComfyUI authorization is unavailable.' } } }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
    assertServiceError(result, { error: { code: 'SOURCE_CREDENTIAL_UNAVAILABLE', message: 'ComfyUI authorization is unavailable.' } });
  });
  await withServer({ instanceDelayMs: 80 }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--timeout-ms', '20', 'instance', '--id', '31']);
    assertFixedError(result, 'TOTAL_TIMEOUT', 5, 'Source request timed out.');
  });
  await withServer({ discoveryStatus: 503, discoveryBody: 'not-json' }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
    assertFixedError(result, 'DISCOVERY_HTTP_ERROR', 3, 'Source discovery returned an error.');
  });
  for (const [signal, code, status] of [['SIGINT', 'PROCESS_CANCELLED', 130], ['SIGTERM', 'PROCESS_CANCELLED', 143]]) {
    await withServer({ hangInstance: true }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31'], {
        onChild: async (child) => {
          await fixture.instanceStarted;
          child.kill(signal);
        }
      });
      assertFixedError(result, code, status, `Source request was cancelled by ${signal}.`);
    });
  }
});

test('Issue 283 Source CLI keeps closed-port, empty, and invalid JSON responses non-zero', async () => {
  const closedServer = await startServer({});
  const port = closedServer.port;
  await closedServer.close();
  assertFixedError(
    await runCli(['--port', String(port), 'instance', '--id', '31']),
    'SOURCE_CONNECTION_FAILED',
    4,
    'Source service is unavailable.'
  );
  for (const instanceBody of ['', '   ', 'not-json', '{}{}']) {
    await withServer({ instanceBody }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), 'instance', '--id', '31']);
      assertFixedError(result, 'CONTRACT_PROTOCOL_ERROR', 6, 'Source contract response is invalid.');
    });
  }
});
