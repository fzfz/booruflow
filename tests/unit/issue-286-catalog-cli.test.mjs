import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = resolve(repositoryRoot, 'scripts/catalog/imagegen-semantic-query.mjs');
const baseModelPath = '/internal/semantic/base-models';

function catalogDiscovery() {
  const field = (schema, example) => ({ description: `Fixture ${schema.type} field.`, example, ...schema });
  const searchSchema = {
    type: 'object',
    description: 'Catalog base-model search request.',
    additionalProperties: false,
    required: ['mode'],
    properties: {
      mode: field({ type: 'string', const: 'search' }, 'search'),
      query: field({ type: 'string', minLength: 0, maxLength: 200, default: '' }, ''),
      page: field({ type: 'integer', minimum: 1, maximum: 100000, default: 1 }, 1),
      page_size: field({ type: 'integer', minimum: 1, maximum: 100, default: 20 }, 20)
    }
  };
  const resolveSchema = {
    type: 'object',
    description: 'Catalog base-model resolve request.',
    additionalProperties: false,
    required: ['mode', 'id'],
    properties: {
      mode: field({ type: 'string', const: 'resolve' }, 'resolve'),
      id: field({ type: 'string', minLength: 1, maxLength: 20, pattern: '^[1-9][0-9]{0,19}$' }, '1')
    }
  };
  return {
    openapi: '3.1.0',
    paths: {
      [baseModelPath]: {
        post: {
          operationId: 'querySemanticBaseModelsForSkill',
          'x-harness-tool-name': 'query_semantic_base_models',
          summary: 'Query base-model records.',
          description: 'Query base-model records for a Catalog caller.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CatalogBaseModelRequest' },
                examples: {
                  search: { value: { mode: 'search', query: '', page: 1, page_size: 20 } },
                  resolve: { value: { mode: 'resolve', id: '1' } }
                }
              }
            }
          },
          responses: {
            200: { $ref: '#/components/responses/CatalogBaseModelPage' }
          }
        }
      }
    },
    components: {
      schemas: {
        CatalogBaseModelRequest: {
          type: 'object',
          description: 'Catalog base-model request.',
          oneOf: [
            { $ref: '#/components/schemas/CatalogBaseModelSearchRequest' },
            { $ref: '#/components/schemas/CatalogBaseModelResolveRequest' }
          ]
        },
        CatalogBaseModelSearchRequest: searchSchema,
        CatalogBaseModelResolveRequest: resolveSchema,
        CatalogBaseModelPage: {
          type: 'object',
          description: 'Catalog base-model response.',
          additionalProperties: false,
          properties: {}
        }
      },
      responses: {
        CatalogBaseModelPage: {
          description: 'Catalog base-model response.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CatalogBaseModelPage' },
              examples: { empty: { value: {} } }
            }
          }
        }
      }
    }
  };
}

function runCli(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
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

function runCliBuffers(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: '/',
      env: process.env,
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
  });
}

async function withResponse({ status, body, discovery = catalogDiscovery() }, callback) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/internal/semantic') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(discovery));
      return;
    }
    if (request.method === 'POST' && request.url === baseModelPath) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    return await callback(server.address().port);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  }
}

test('Issue #286 Catalog CLI accepts any non-empty JSON value from every 2xx response and writes its raw body', async () => {
  const discoveryWithoutSuccessResponseSchema = catalogDiscovery();
  delete discoveryWithoutSuccessResponseSchema.components.responses.CatalogBaseModelPage;
  for (const response of [
    {
      status: 200,
      body: '{\n  "results": [{"id":"opaque","cover_url":"not-a-url"}],\n  "not_a_catalog_field": true\n}'
    },
    { status: 201, body: ' ["free-form",42] ' },
    { status: 200, body: 'null\n', discovery: discoveryWithoutSuccessResponseSchema },
    { status: 200, body: '  \n{"opaque":true}\t ' }
  ]) {
    await withResponse(response, async (port) => {
      const result = await runCli([
        '--port', String(port),
        '--path', baseModelPath,
        '--mode', 'search'
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, response.body);
    });
  }
});

test('Issue #286 Catalog CLI does not require extra discovery metadata', async () => {
  const discovery = catalogDiscovery();
  discovery.legacy_metadata = { identity: 'legacy', release: 'not-semver', media_origin: 'https://external.example.test/media' };
  const response = '{"opaque":true}';
  await withResponse({ status: 200, body: response, discovery }, async (port) => {
    const result = await runCli([
      '--port', String(port),
      '--path', baseModelPath,
      '--mode', 'search'
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, response);
  });
});

test('Issue #286 Catalog CLI forwards arbitrary non-2xx JSON body unchanged with exit 7', async () => {
  for (const response of [
    { status: 418, body: '{"unexpected":"teapot"}' },
    { status: 599, body: ' \n{"error":{"code":"not-a-catalog-code"}}\t' }
  ]) {
    await withResponse(response, async (port) => {
      const result = await runCli([
        '--port', String(port),
        '--path', baseModelPath,
        '--mode', 'search'
      ]);
      assert.equal(result.status, 7, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, response.body);
      assert.doesNotMatch(result.stderr, /CONTRACT_PROTOCOL_ERROR/u);
    });
  }
});

test('Issue #286 Catalog CLI preserves response Buffer bytes and rejects invalid response bodies', async () => {
  const invoke = (status, body) => withResponse({ status, body }, async (port) => runCliBuffers([
    '--port', String(port),
    '--path', baseModelPath,
    '--mode', 'search'
  ]));
  const protocolError = Buffer.from('{"error":{"code":"CONTRACT_PROTOCOL_ERROR","message":"Source contract response is invalid."}}\n');

  const successBody = Buffer.from(' \t{"message":"多字节猫"} \n', 'utf8');
  const success = await invoke(200, successBody);
  assert.equal(success.status, 0);
  assert.equal(success.signal, null);
  assert.deepEqual(success.stdout, successBody);
  assert.deepEqual(success.stderr, Buffer.alloc(0));

  const serviceErrorBody = Buffer.from('\n{"任意错误":"猫"}\t', 'utf8');
  const serviceError = await invoke(418, serviceErrorBody);
  assert.equal(serviceError.status, 7);
  assert.equal(serviceError.signal, null);
  assert.deepEqual(serviceError.stdout, Buffer.alloc(0));
  assert.deepEqual(serviceError.stderr, serviceErrorBody);

  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  for (const body of [
    invalidUtf8,
    Buffer.alloc(0),
    Buffer.from('{"first":1}{"second":2}', 'utf8'),
    Buffer.from('not-json', 'utf8')
  ]) {
    const invalid = await invoke(200, body);
    assert.equal(invalid.status, 6);
    assert.equal(invalid.signal, null);
    assert.deepEqual(invalid.stdout, Buffer.alloc(0));
    assert.deepEqual(invalid.stderr, protocolError);
  }
});

test('Issue #286 Catalog path help describes raw non-2xx output and fixed local errors', async () => {
  await withResponse({ status: 200, body: Buffer.from('{}', 'utf8') }, async (port) => {
    const result = await runCli([
      '--port', String(port),
      '--path', baseModelPath,
      '--help'
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /The CLI requires the target service's 2xx response body to be non-empty, strictly UTF-8, and exactly one JSON value\./u);
    assert.match(result.stdout, /The CLI does not validate the 2xx response body against a response Schema or validate its fields\./u);
    assert.match(result.stdout, /The CLI writes the original 2xx response body Buffer to stdout without adding or removing bytes, writes nothing to stderr, and exits with code 0\./u);
    assert.match(result.stdout, /For any non-2xx response with a non-empty, strictly UTF-8 body containing exactly one JSON value, the CLI writes the original response body Buffer to stderr without adding or removing bytes, writes nothing to stdout, and exits with code 7\./u);
    assert.match(result.stdout, /The CLI does not validate the non-2xx HTTP status declaration, response Schema, response fields, or error code\./u);
    assert.match(result.stdout, /For an empty body, invalid UTF-8 body, invalid JSON body, or body containing multiple JSON values, the CLI writes a fixed CONTRACT_PROTOCOL_ERROR object to stderr, writes nothing to stdout, and exits with code 6\./u);
    assert.match(result.stdout, /The CLI reports argument failures with its fixed CLI error object and exit code 2, connection failures with exit code 4, timeout failures with exit code 5, and SIGINT or SIGTERM cancellation with exit code 130 or 143; each failure writes only the fixed CLI error object to stderr and writes nothing to stdout\./u);
  });
});
