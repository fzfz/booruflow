import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { main, writeError } from '../../scripts/catalog/imagegen-semantic-query.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/catalog/imagegen-semantic-query.mjs');
const BASE_PATH = '/internal/semantic/base-models';
const MODEL_PATH = '/internal/semantic/generation-models';
const WORK_PATH = '/internal/semantic/works';

function liveDiscovery() {
  return buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin: 'http://127.0.0.1:19082', mediaPublicPrefix: '/assets/media' });
}

function emptyPage(kind, page = 1, pageSize = 20, totalCount = 0) {
  return { status: 'ok', message: null, results: [], page, page_size: pageSize, total_count: totalCount, kind };
}

function generationItem({ coverUrl = null, id = 1 } = {}) {
  return {
    id,
    file_name: 'model.safetensors',
    cover_url: coverUrl,
    base_model_id: 1,
    file_format: 'safetensors'
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

async function startServer({ discovery = liveDiscovery(), discoveryStatus = 200, discoveryBody, post = () => emptyPage('base-model'), discoveryDelayMs = 0, postDelayMs = 0 } = {}) {
  const requests = [];
  let postStarted;
  const postStartedPromise = new Promise((resolvePromise) => { postStarted = resolvePromise; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const entry = { method: request.method, url: request.url, bodyText };
      requests.push(entry);
      if (request.method === 'POST') postStarted();
      const delayMs = request.method === 'GET' ? discoveryDelayMs : postDelayMs;
      if (delayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
      if (request.method === 'GET' && request.url === '/internal/semantic') {
        response.writeHead(discoveryStatus, { 'content-type': 'application/json' });
        response.end(discoveryBody === undefined ? JSON.stringify(discovery) : discoveryBody);
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
        return;
      }
      const resultValue = typeof post === 'function' ? await post({ request, bodyText, requests }) : post;
      const result = resultValue?.hang === true || Object.hasOwn(resultValue ?? {}, 'value') || Object.hasOwn(resultValue ?? {}, 'body') || Object.hasOwn(resultValue ?? {}, 'status')
        ? resultValue
        : { value: resultValue };
      if (result?.hang === true) return;
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      response.end(result.body === undefined ? JSON.stringify(result.value) : result.body);
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return {
    port: server.address().port,
    requests,
    postStarted: postStartedPromise,
    close: () => new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()))
  };
}

function assertFixedError(result, code, status, message) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, JSON.stringify({ error: { code, message } }) + '\n');
}

function assertServiceError(result, body, label = '') {
  assert.equal(result.status, 7, label === '' ? result.stderr : `${label}: ${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, JSON.stringify(body));
}

async function withServer(options, callback) {
  const fixture = await startServer(options);
  try {
    return await callback(fixture);
  } finally {
    await fixture.close();
  }
}

test('Issue 278 Catalog CLI POSTs strict base search and generation filter requests, and resolves 20-digit IDs', async () => {
  await withServer({ post: ({ request: { url }, bodyText }) => ({ value: url === MODEL_PATH ? emptyPage('model') : emptyPage('base-model') }) }, async (fixture) => {
    const base = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search', '--query', 'watercolor', '--page', '2', '--page_size', '3']);
    assert.equal(base.status, 0, base.stderr);
    assert.equal(base.stderr, '');
    assert.equal(base.stdout, JSON.stringify(emptyPage('base-model')));
    assert.deepEqual(JSON.parse(fixture.requests[1].bodyText), { mode: 'search', query: 'watercolor', page: 2, page_size: 3 });

    const generation = await runCli(['--port', String(fixture.port), '--path', MODEL_PATH, '--mode', 'search', '--base_model_id', '12345678901234567890']);
    assert.equal(generation.status, 0, generation.stderr);
    assert.equal(generation.stdout, JSON.stringify(emptyPage('model')));
    assert.deepEqual(JSON.parse(fixture.requests[3].bodyText), { mode: 'search', base_model_id: '12345678901234567890' });

    const resolved = await runCli(['--port', String(fixture.port), '--path', MODEL_PATH, '--mode', 'resolve', '--id', '12345678901234567890']);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.deepEqual(JSON.parse(fixture.requests[5].bodyText), { mode: 'resolve', id: '12345678901234567890' });
  });
});

test('Issue 278 Catalog CLI rejects invalid mode branches, unknown or duplicate flags, and manifest-disallowed filters', async () => {
  await withServer({}, async (fixture) => {
    for (const args of [
      [],
      ['--mode', 'resolve', '--query', 'x'],
      ['--mode', 'search', '--id', '1'],
      ['--mode', 'search', '--work_id', '1'],
      ['--mode', 'resolve', '--id', '1', '--id', '2'],
      ['--mode', 'search', '--query', 'a', '--query', 'b'],
      ['--mode', 'other'],
      ['--mode', 'resolve', '--id', '1', '--page', '2'],
      ['--mode', 'resolve', '--id', '123456789012345678901']
    ]) {
      const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, ...args]);
      assertFixedError(result, 'INVALID_ARGUMENT', 2, 'CLI arguments are invalid.');
    }
    const unknown = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search', '--queries', 'old']);
    assertFixedError(unknown, 'INVALID_ARGUMENT', 2, 'CLI arguments are invalid.');
  });
});

test('Issue 286 Catalog CLI keeps empty and multiple JSON responses nonzero, and accepts arbitrary 2xx JSON', async () => {
  for (const response of [
    { status: 200, body: '' },
    { status: 200, body: '{} {}' }
  ]) {
    await withServer({ post: response }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search']);
      assertFixedError(result, 'CONTRACT_PROTOCOL_ERROR', 6, 'Source contract response is invalid.');
    });
  }
  for (const response of [
    { status: 200, value: { ...emptyPage('wrong-kind'), unexpected: true } },
    { status: 200, value: { ...emptyPage('base-model'), arbitrary_server_field: 2 } },
    { status: 201, value: emptyPage('base-model') }
  ]) {
    await withServer({ post: response }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(response.value));
    });
  }
});

test('Issue 286 Catalog CLI does not apply live success response uniqueItems or string format constraints', async () => {
  const item = {
    id: '1',
    title: 'Base',
    subtitle: null,
    cover_url: null,
    name: 'Base'
  };
  const duplicateDiscovery = structuredClone(liveDiscovery());
  duplicateDiscovery.components.schemas.CatalogSourceSuccess.properties.results.uniqueItems = true;
  await withServer({ discovery: duplicateDiscovery, post: { value: { ...emptyPage('base-model'), items: [item, item] } } }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({ ...emptyPage('base-model'), items: [item, item] }));
  });

  const formatDiscovery = structuredClone(liveDiscovery());
  formatDiscovery.components.schemas.CatalogSourceResultRecord.format = 'uri';
  await withServer({ discovery: formatDiscovery, post: { value: { ...emptyPage('base-model'), items: [item] } } }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({ ...emptyPage('base-model'), items: [item] }));
  });

  const dateTimeDiscovery = structuredClone(liveDiscovery());
  dateTimeDiscovery.components.schemas.CatalogSourceResultRecord.pattern = '^never-match$';
  await withServer({ discovery: dateTimeDiscovery, post: { value: { ...emptyPage('base-model'), items: [item] } } }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({ ...emptyPage('base-model'), items: [item] }));
  });
});

test('Issue 286 Catalog CLI forwards recognized and arbitrary non-2xx JSON bodies without schema validation', async () => {
  const recognized = [
    [404, { error: { code: 'CATALOG_REF_NOT_FOUND', message: 'Catalog record was not found.' } }],
    [422, { error: { code: 'CATALOG_REQUEST_INVALID', message: 'Catalog request is invalid.' } }],
    [500, { error: { code: 'CATALOG_INTERNAL_ERROR', message: 'Catalog query failed.' } }],
    [503, { error: { code: 'CATALOG_DATABASE_BUSY', message: 'Catalog database is busy.' } }]
  ];
  for (const [status, body] of recognized) {
    await withServer({ post: { status, value: body } }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'resolve', '--id', '1']);
      assertServiceError(result, body, `${status}/${body.error.code}`);
    });
  }
  for (const response of [
    { status: 404, value: { error: { code: 'UNKNOWN', message: 'unknown' } } },
    { status: 404, value: { error: { code: 'CATALOG_REF_NOT_FOUND', message: 'wrong message' } } },
    { status: 404, value: { error: { code: 'CATALOG_REF_NOT_FOUND', message: 'Catalog record was not found.', extra: true } } },
    { status: 418, value: { error: { code: 'CATALOG_REF_NOT_FOUND', message: 'Catalog record was not found.' } } },
    { status: 500, body: 'not-json' }
  ]) {
    await withServer({ post: response }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'resolve', '--id', '1']);
      if (response.body === undefined) assertServiceError(result, response.value, `${response.status}/${response.value.error.code}`);
      else assertFixedError(result, 'CONTRACT_PROTOCOL_ERROR', 6, 'Source contract response is invalid.');
    });
  }
});

test('Issue 286 Catalog CLI forwards work 503 JSON bodies without oneOf validation', async () => {
  for (const body of [
    { error: { code: 'CATALOG_INDEX_NOT_READY', message: 'Catalog semantic index is not ready.' } },
    { error: { code: 'CATALOG_DATABASE_BUSY', message: 'Catalog database is busy.' } }
  ]) {
    await withServer({ post: { status: 503, value: body } }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), '--path', WORK_PATH, '--mode', 'search']);
      assertServiceError(result, body, body.error.code);
    });
  }
  for (const body of [
    { error: { code: 'CATALOG_INDEX_NOT_READY', message: 'Catalog database is busy.' } },
    { error: { code: 'CATALOG_DATABASE_BUSY', message: 'Catalog semantic index is not ready.' } }
  ]) {
    await withServer({ post: { status: 503, value: body } }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), '--path', WORK_PATH, '--mode', 'search']);
      assertServiceError(result, body, body.error.code);
    });
  }
});

test('Issue 278 Catalog CLI maps discovery HTTP errors and closed-port failures to fixed errors', async () => {
  await withServer({ discoveryStatus: 503, discoveryBody: JSON.stringify({ secret: 'not exposed' }), post: { value: emptyPage('base-model') } }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search']);
    assertFixedError(result, 'DISCOVERY_HTTP_ERROR', 3, 'Source discovery returned an error.');
  });
  const failedServer = await startServer({});
  const port = failedServer.port;
  await failedServer.close();
  const result = await runCli(['--port', String(port), '--path', BASE_PATH, '--mode', 'search']);
  assertFixedError(result, 'SOURCE_CONNECTION_FAILED', 4, 'Source service is unavailable.');
});

test('Issue 278 Catalog CLI shares one total deadline across discovery and POST', async () => {
  await withServer({ discoveryDelayMs: 100, postDelayMs: 300, post: { value: emptyPage('base-model') } }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--timeout-ms', '250', '--path', BASE_PATH, '--mode', 'search']);
    assertFixedError(result, 'TOTAL_TIMEOUT', 5, 'Source request timed out.');
    assert.equal(fixture.requests.filter(({ method }) => method === 'POST').length, 1);
  });
});

test('Issue 278 Catalog CLI turns SIGINT and SIGTERM into fixed cancellation errors without success output', async () => {
  for (const [signal, code, message] of [
    ['SIGINT', 'PROCESS_CANCELLED', 'Source request was cancelled by SIGINT.'],
    ['SIGTERM', 'PROCESS_CANCELLED', 'Source request was cancelled by SIGTERM.']
  ]) {
    await withServer({ post: { hang: true } }, async (fixture) => {
      const resultPromise = runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search'], {
        onChild: async (child) => {
          await fixture.postStarted;
          child.kill(signal);
        }
      });
      const result = await resultPromise;
      assertFixedError(result, code, signal === 'SIGINT' ? 130 : 143, message);
    });
  }
});

test('Issue 278 Catalog CLI reports uncaught internal failures using the fixed internal error', async () => {
  const originalWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  process.exitCode = 0;
  try {
    await main([], { injectInternalError: true }).catch(writeError);
    assert.equal(stderr, JSON.stringify({ error: { code: 'INTERNAL_CLI_ERROR', message: 'Source CLI failed.' } }) + '\n');
    assert.equal(process.exitCode, 6);
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = originalExitCode;
  }
});

test('Issue 286 Catalog CLI preserves server JSON and database fields', async () => {
  const page = { ...emptyPage('base-model'), total_count: 1, results: [{ id: 1, name: 'Base', cover_url: null }] };
  await withServer({ post: { value: page } }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--path', BASE_PATH, '--mode', 'search']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(page));
  });
});

test('Issue 286 Catalog CLI accepts successful items with arbitrary database values and cover URLs', async () => {
  const discovery = liveDiscovery();
  const mediaOrigin = discovery['x-imagegen-media-origin'];
  const validCoverUrl = `${mediaOrigin}/assets/media/covers/model%20one.png`;
  const valid = generationItem({ coverUrl: validCoverUrl });
  const cases = [
    {
      label: 'single item with an arbitrary database value',
      items: [{ ...generationItem({ coverUrl: validCoverUrl }), file_format: 'arbitrary' }]
    },
    {
      label: 'later item with arbitrary numeric and string values',
      items: [valid, { ...generationItem({ id: 2, coverUrl: validCoverUrl }), precision_or_quantization: 'custom' }]
    },
    {
      label: 'external cover origin',
      items: [generationItem({ coverUrl: 'https://example.com/assets/model.png' })]
    },
    {
      label: 'different loopback port',
      items: [generationItem({ coverUrl: 'http://127.0.0.1:19083/assets/model.png' })]
    },
    {
      label: 'pseudo-prefix host',
      items: [generationItem({ coverUrl: `http://127.0.0.1:19082@127.0.0.2/assets/model.png` })]
    }
  ];
  for (const { label, items } of cases) {
    await withServer({ post: { value: { ...emptyPage('model'), total_count: items.length, items } } }, async (fixture) => {
      const result = await runCli(['--port', String(fixture.port), '--path', MODEL_PATH, '--mode', 'search']);
      const page = { ...emptyPage('model'), total_count: items.length, items };
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(page), label);
      assert.equal(fixture.requests.filter(({ method }) => method === 'POST').length, 1, label);
    });
  }
});

test('Issue 286 Catalog CLI preserves exact media origin and encoded cover paths without validation', async () => {
  const discovery = liveDiscovery();
  const page = {
    ...emptyPage('model'),
    total_count: 1,
    items: [generationItem({ coverUrl: `${discovery['x-imagegen-media-origin']}/assets/media/covers/model%20one.png` })]
  };
  await withServer({ discovery, post: { value: page } }, async (fixture) => {
    const result = await runCli(['--port', String(fixture.port), '--path', MODEL_PATH, '--mode', 'search']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(page));
  });
});
