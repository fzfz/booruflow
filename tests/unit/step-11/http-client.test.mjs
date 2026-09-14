import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../../app/web/assets/http-client.js', import.meta.url), 'utf8');

function loadClient() {
  const sandbox = {
    __NOOBAI_URLS__: { config: { http_request_timeout_ms: 3210 } },
    AbortController, Error, Object, Number, Promise, setTimeout, clearTimeout
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'app/web/assets/http-client.js' });
  return sandbox.__NOOBAI_HTTP__;
}

function response(body, { status = 200, ok = status >= 200 && status < 300, contentType = 'application/json; charset=utf-8' } = {}) {
  return { status, ok, headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null }, json: async () => body };
}

test('HTTP client separates API business errors, non-JSON responses, and malformed JSON envelopes', async () => {
  const client = loadClient();
  const cases = [
    {
      name: 'business HTTP error',
      response: response({ ok: false, request_id: 'request-1', error: { code: 'RELATION_CONFLICT', message: 'snapshot changed', details: { changed_fields: ['cover_media_path'] } } }, { status: 409 }),
      code: 'RELATION_CONFLICT',
      category: 'HTTP_ERROR'
    },
    {
      name: 'non-JSON response',
      response: response({ ok: false, request_id: 'request-1', error: { code: 'INTERNAL_ERROR', message: 'masked HTML' } }, { status: 502, contentType: 'text/html' }),
      code: 'RESPONSE_JSON_INVALID',
      category: 'NON_JSON_RESPONSE'
    },
    {
      name: 'malformed JSON envelope',
      response: response({ ok: true, request_id: 'request-1' }),
      code: 'RESPONSE_INVALID',
      category: 'JSON_STRUCTURE_INVALID'
    }
  ];

  for (const expected of cases) {
    await assert.rejects(
      () => client.requestJson({ fetchImpl: async () => expected.response, path: '/api/manage/items', requestId: 'request-1' }),
      (error) => error.code === expected.code
        && error.category === expected.category
        && (expected.name !== 'business HTTP error' || error.details?.changed_fields?.[0] === 'cover_media_path')
    );
  }
});

test('HTTP client accepts JSON content types with parameters', async () => {
  const client = loadClient();
  const data = await client.requestJson({
    fetchImpl: async () => response({ ok: true, request_id: 'request-1', data: { accepted: true } }, { contentType: 'application/json; charset=utf-8' }),
    path: '/api/manage/items',
    requestId: 'request-1'
  });
  assert.deepEqual(data, { accepted: true });
});

test('HTTP client does not require or compare request_id for any API response', async () => {
  const client = loadClient();
  for (const [path, body] of [
    ['/api/manage/comfyui-templates?page=1&page_size=20&q=', { ok: true, request_id: 'response-request-id', data: { accepted: 'mismatched' } }],
    ['/api/manage/base-models/7', { ok: true, data: { accepted: 'missing' } }]
  ]) {
    const data = await client.requestJson({
      fetchImpl: async () => response(body),
      path
    });
    assert.deepEqual(data, body.data);
  }
});

test('HTTP client bypasses cached JSON envelopes that contain a request-specific request_id', async () => {
  const client = loadClient();
  const responseCache = new Map();
  let networkRequests = 0;
  const fetchWithHttpCache = async (path, options) => {
    if (options.cache !== 'no-store' && responseCache.has(path)) return responseCache.get(path);
    networkRequests += 1;
    const requestId = options.headers.get('x-request-id');
    const result = response({ ok: true, request_id: requestId, data: { network_request: networkRequests } });
    if (options.cache !== 'no-store') responseCache.set(path, result);
    return result;
  };
  const request = (requestId) => client.requestJson({
    fetchImpl: fetchWithHttpCache,
    path: '/api/manage/comfyui-templates?page=1&page_size=20&q=',
    options: { cache: 'force-cache', headers: new Headers({ 'x-request-id': requestId }) },
    requestId
  });

  assert.deepEqual(await request('template-list-before-navigation'), { network_request: 1 });
  assert.deepEqual(await request('template-list-after-back-navigation'), { network_request: 2 });
  assert.equal(networkRequests, 2);
});

test('HTTP client does not treat a transport code as an API error', async () => {
  const client = loadClient();
  await assert.rejects(
    () => client.requestJson({ fetchImpl: async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }, path: '/api/works', requestId: 'request-1' }),
    (error) => error.code === 'NETWORK_ERROR' && error.category === 'NETWORK_ERROR'
  );
});

test('HTTP client distinguishes its timeout from caller cancellation', async () => {
  const client = loadClient();
  const abortingFetch = (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });

  await assert.rejects(
    () => client.requestJson({ fetchImpl: abortingFetch, path: '/api/works', requestId: 'timeout', timeoutMs: 5 }),
    (error) => error.code === 'TIMEOUT' && error.category === 'TIMEOUT'
  );

  const callerController = new AbortController();
  const canceled = client.requestJson({ fetchImpl: abortingFetch, path: '/api/works', requestId: 'canceled', signal: callerController.signal });
  callerController.abort();
  await assert.rejects(canceled, (error) => error.code === 'CANCELED' && error.category === 'CANCELED');
});
