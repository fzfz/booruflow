import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

import { loadAuthoritativeContracts, validateJsonSample } from '../../app/contracts/authoritative-contracts.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';
import { ManualIngestInterrupted, createManualIngestRunner as createManualIngestRunnerBase } from '../../app/ingest/manual-ingest.mjs';
import {
  create2xNzCrawleeAdapter,
  read2xNzCredentials,
  TWO_X_NZ_API_ORIGIN,
  TWO_X_NZ_CRAWLEE_SOURCE_CONFIG,
  TWO_X_NZ_DRAW_URL
} from '../../app/ingest/sources/2x-nz-crawlee.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const contracts = loadAuthoritativeContracts(repositoryRoot);
const IMAGE_BYTES = Buffer.from('offline-2x-nz-image');
const IMAGE_HASH = createHash('sha256').update(IMAGE_BYTES).digest('hex');
const VECTOR_CONFIGURATION = Object.freeze({ embedding_model: 'fake' });
const MODEL_CLIENT = Object.freeze({ async embed(inputs) { return inputs.map(() => createFixtureVector()); } });

function createManualIngestRunner(options) {
  return createManualIngestRunnerBase({ modelClient: MODEL_CLIENT, vectorConfiguration: VECTOR_CONFIGURATION, ...options });
}
const IMAGE_URL = `${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?name=raw%2Fvalue&cat=a+b`;
const WAI_CATEGORY_URL = `${TWO_X_NZ_API_ORIGIN}/api/library/categories?mode=WAI`;
const ANIMA_CATEGORY_URL = `${TWO_X_NZ_API_ORIGIN}/api/library/categories?mode=ANIMA`;
const HISTORICAL_MIGRATION_MAX_VERSION = 37;

function createHistoricalRepository(t) {
  const historicalRepositoryRoot = mkdtempSync(join(tmpdir(), '2x-nz-crawlee-037-repository-'));
  const migrationDirectory = join(historicalRepositoryRoot, 'schema', 'database');
  mkdirSync(migrationDirectory, { recursive: true });
  for (const migration of listOrderedMigrations(resolve(repositoryRoot, 'schema', 'database')).filter(({ version }) => version <= HISTORICAL_MIGRATION_MAX_VERSION)) {
    copyFileSync(migration.path, join(migrationDirectory, basename(migration.path)));
  }
  t.after(() => rmSync(historicalRepositoryRoot, { recursive: true, force: true }));
  return historicalRepositoryRoot;
}

async function startLocalApi(t, handler) {
  const server = createServer(handler);
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  t.after(async () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())));
  return `http://127.0.0.1:${server.address().port}`;
}

function localImageDetail(sourceUrl) {
  return {
    identity: { kind: 'style', base_model_id: 9101, source_id: '2x-nz:WAI:style:local', parent_identity: 'root', normalized_name: '本地画风' },
    source_version: 'WAI',
    extensions: { thumbnail_url: sourceUrl },
    image_results: []
  };
}

function defaultCrawleeAdapter(mediaRoot, apiOrigin) {
  return create2xNzCrawleeAdapter({ mediaRoot, apiOrigin, minDelayMilliseconds: 0 });
}

function headers(entries = {}) {
  const values = new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    get(name) { return values.get(name.toLowerCase()) ?? null; },
    entries() { return values.entries(); }
  };
}

function response(url, { status = 200, body = null, bytes = IMAGE_BYTES, contentType = 'application/json; charset=utf-8', finalUrl = url, responseHeaders = {} } = {}) {
  const text = typeof body === 'string' ? body : body === null ? '' : JSON.stringify(body);
  return {
    status,
    url: finalUrl,
    headers: headers({ 'content-type': contentType, ...responseHeaders }),
    async text() { return text; },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  };
}

function record({ id = 'character-1', thumbnail = IMAGE_URL } = {}) {
  return {
    id,
    kind: 'builtin',
    type: 'character',
    mode: 'WAI',
    name: '角色一',
    tags: 'prompt one',
    category: '作品甲',
    thumbnail
  };
}

function categories(mode) {
  return mode === 'WAI'
    ? { characters: [{ name: '作品甲', count: 1 }], styles: [], total: { characters: 1, styles: 0 } }
    : { characters: [], styles: [], total: { characters: 0, styles: 0 } };
}

function library() {
  return {
    characters: [record()],
    styles: [],
    mode: 'WAI',
    total: { characters: 1, styles: 0 }
  };
}

function makeFixture(t, { responseFor = () => null, adapterOptions = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-crawlee-adapter-'));
  const mediaRoot = join(directory, 'media');
  const cachePath = join(directory, 'cache', 'records.json');
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const request = async (url, options = {}) => {
    const call = { url, options: { ...options, headers: { ...(options.headers ?? {}) } } };
    requests.push(call);
    const parsed = new URL(url);
    const custom = responseFor(parsed, call);
    if (custom) return custom;
    if (parsed.pathname === '/api/library/categories') return response(url, { body: categories(parsed.searchParams.get('mode')) });
    if (parsed.pathname === '/api/library') return response(url, { body: library() });
    if (parsed.pathname === '/api/library/tag_thumb') return response(url, { contentType: 'image/png' });
    throw new Error(`unexpected offline URL: ${url}`);
  };
  const adapter = create2xNzCrawleeAdapter({
    mediaRoot,
    cachePath,
    request,
    minDelayMilliseconds: 0,
    now: () => new Date('2026-07-28T08:00:00Z'),
    ...adapterOptions
  });
  return { adapter, cachePath, directory, mediaRoot, requests };
}

async function discoverCharacter(adapter) {
  const catalog = await adapter.discoverCatalog();
  const character = catalog.find((entry) => entry.identity.kind === 'character');
  assert.ok(character, 'offline fixture must expose one character');
  return { catalog, character, detail: await adapter.fetchDetail({ identity: character.identity }) };
}

function errorCode(error) {
  return error?.code;
}

test('新版 Crawlee 采集器持续运行直到完成，不设置总运行时长上限', (t) => {
  const fixture = makeFixture(t);
  assert.deepEqual(fixture.adapter.sourceConfig, TWO_X_NZ_CRAWLEE_SOURCE_CONFIG);
  assert.equal(fixture.adapter.sourceConfig.request.max_run_minutes, undefined);
  assert.equal(fixture.adapter.sourceConfig.request.timeout_seconds, 20);
  assert.equal(fixture.adapter.sourceConfig.request.min_delay_seconds, 3);
  assert.equal(fixture.adapter.sourceConfig.request.max_delay_seconds, 5);
});

test('新版 Crawlee 采集器使用 3–5 秒随机请求间隔', async (t) => {
  const delays = [];
  const fixture = makeFixture(t, { adapterOptions: { minDelayMilliseconds: 3000, maxDelayMilliseconds: 5000, random: () => 0.999, sleep: async (milliseconds) => delays.push(milliseconds) } });
  await discoverCharacter(fixture.adapter);
  assert.ok(delays.length > 0);
  assert.ok(delays.every((milliseconds) => milliseconds > 4500 && milliseconds <= 5000));
});

test('writes the underlying record cache when create2xNzCrawleeAdapter receives cachePath', async (t) => {
  const fixture = makeFixture(t);
  const firstCatalog = await fixture.adapter.discoverCatalog();

  assert.equal(existsSync(fixture.cachePath), true, 'discoverCatalog must write the configured record cache');
  const cache = JSON.parse(readFileSync(fixture.cachePath, 'utf8'));
  assert.equal(cache.cache_version, 1);
  assert.equal(cache.records.length, 1);
  assert.deepEqual(cache.records[0].record, {
    id: 'character-1',
    name: '角色一',
    prompt_text: 'prompt one',
    category: '作品甲',
    thumbnail: IMAGE_URL,
    lora_path: null,
    item_url: null,
    item_mode: 'WAI'
  });
  const characterSourceUrl = firstCatalog.find((entry) => entry.identity.kind === 'character').source_url;
  assert.equal(typeof cache.records[0].source_url, 'string');
  assert.equal(cache.records[0].source_url, characterSourceUrl);
  assert.deepEqual(cache.deduplications, []);

  const cachedAdapter = create2xNzCrawleeAdapter({
    mediaRoot: fixture.mediaRoot,
    cachePath: fixture.cachePath,
    request: async () => { throw new Error('record cache read must not request the network'); },
    minDelayMilliseconds: 0,
    now: () => new Date('2026-07-28T08:00:00Z')
  });
  const secondCatalog = await cachedAdapter.discoverCatalog();
  assert.deepEqual(secondCatalog, firstCatalog);
  assert.equal(secondCatalog.find((entry) => entry.identity.kind === 'character').source_url, characterSourceUrl);
});

test('reads 200 JSON through one offline HTTP boundary and keeps API-returned URL text', async (t) => {
  const fixture = makeFixture(t);
  const { catalog, character } = await discoverCharacter(fixture.adapter);

  assert.equal(catalog.length, 2, 'one category work plus one character');
  assert.equal(character.source_url, `${TWO_X_NZ_API_ORIGIN}/api/library?mode=WAI&category=%E4%BD%9C%E5%93%81%E7%94%B2&limit=200&offset=0`);
  const detail = await fixture.adapter.fetchDetail({ identity: character.identity });
  assert.equal(detail.extensions.thumbnail_url, IMAGE_URL);
  assert.deepEqual(validateJsonSample(character, resolve(repositoryRoot, 'schema/crawler/catalog-entry.schema.json'), contracts.schemas), []);
  assert.deepEqual(validateJsonSample(detail, resolve(repositoryRoot, 'schema/crawler/detail-result.schema.json'), contracts.schemas), []);

  const jsonCalls = fixture.requests.filter(({ url }) => new URL(url).pathname !== '/api/library/tag_thumb');
  assert.ok(jsonCalls.length >= 3);
  for (const call of jsonCalls) {
    assert.equal(call.options.method ?? 'GET', 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.accept, 'application/json');
  }

  const localOrigin = await startLocalApi(t, (request, response) => {
    assert.equal(request.url?.startsWith('/api/library/categories?mode='), true);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ characters: [], styles: [], total: { characters: 0, styles: 0 } }));
  });
  const realAdapter = defaultCrawleeAdapter(fixture.mediaRoot, localOrigin);
  const smoke = await realAdapter.smoke();
  assert.equal(smoke.modes.WAI.character_count, 0);
  assert.equal(smoke.modes.ANIMA.style_count, 0);
});

test('downloads a 200 image and persists its hash under the controlled media root', async (t) => {
  const fixture = makeFixture(t);
  const { detail } = await discoverCharacter(fixture.adapter);
  const downloaded = await fixture.adapter.downloadImages(detail);
  const image = downloaded.image_results[0];

  assert.equal(image.status, 'downloaded');
  assert.equal(image.source_url, IMAGE_URL);
  assert.equal(image.content_hash, IMAGE_HASH);
  assert.equal(existsSync(join(fixture.mediaRoot, 'images', image.local_path)), true);
  assert.deepEqual(readFileSync(join(fixture.mediaRoot, 'images', image.local_path)), IMAGE_BYTES);
  assert.equal(fixture.requests.at(-1).url, IMAGE_URL);
  assert.equal(fixture.requests.at(-1).options.headers.accept, 'image/*');

  const contentTypes = {
    png: 'image/png', jpeg: 'image/jpeg', avif: 'image/avif', svg: 'image/svg+xml'
  };
  const localOrigin = await startLocalApi(t, (request, response) => {
    const kind = new URL(request.url, 'http://localhost').searchParams.get('kind');
    response.writeHead(200, { 'content-type': contentTypes[kind] });
    response.end(kind === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : `image-${kind}`);
  });
  const realAdapter = defaultCrawleeAdapter(fixture.mediaRoot, localOrigin);
  for (const kind of Object.keys(contentTypes)) {
    const result = await realAdapter.downloadImages(localImageDetail(`${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?kind=${kind}`));
    assert.equal(result.image_results[0].status, 'downloaded');
  }
});

test('reuses local JSON and image cache on HTTP 304 without requiring a body', async (t) => {
  const first = makeFixture(t, {
    responseFor: (parsed) => parsed.pathname === '/api/library/tag_thumb'
      ? response(parsed.href, { contentType: 'image/png', responseHeaders: { etag: '"image-v1"' } })
      : null
  });
  const firstResult = await discoverCharacter(first.adapter);
  const firstDetail = await first.adapter.downloadImages(firstResult.detail);
  assert.equal(firstDetail.image_results[0].status, 'downloaded');
  assert.equal(existsSync(`${first.cachePath}.http.json`), true);
  const cachedHttp = JSON.parse(readFileSync(`${first.cachePath}.http.json`, 'utf8'));
  assert.equal(cachedHttp.entries[IMAGE_URL].content_hash, IMAGE_HASH);
  assert.equal(cachedHttp.entries[IMAGE_URL].local_path, firstDetail.image_results[0].local_path);

  const second = makeFixture(t, {
    responseFor: (parsed) => parsed.pathname === '/api/library/tag_thumb'
      ? response(parsed.href, { status: 304, body: null, contentType: 'image/png', responseHeaders: { etag: '"image-v1"' } })
      : null,
    adapterOptions: { cachePath: first.cachePath, mediaRoot: first.mediaRoot }
  });
  const cachedResult = await discoverCharacter(second.adapter);
  const cachedDetail = await second.adapter.downloadImages(cachedResult.detail);

  assert.equal(cachedResult.catalog.length, firstResult.catalog.length);
  assert.deepEqual(cachedResult.catalog, firstResult.catalog);
  assert.equal(cachedDetail.image_results[0].status, 'existing');
  assert.equal(cachedDetail.image_results[0].content_hash, IMAGE_HASH);
  assert.equal(cachedDetail.image_results[0].local_path, firstDetail.image_results[0].local_path);
  assert.ok(second.requests.filter((call) => new URL(call.url).pathname === '/api/library/tag_thumb').every((call) => call.options.headers['if-none-match']));
});

test('copies a shared 304 thumbnail into the requesting owner path', async (t) => {
  const first = makeFixture(t, {
    responseFor: (parsed) => parsed.pathname === '/api/library/tag_thumb'
      ? response(parsed.href, { contentType: 'image/png', responseHeaders: { etag: '"image-v1"' } })
      : null
  });
  const discovered = await discoverCharacter(first.adapter);
  const firstDetail = await first.adapter.downloadImages(discovered.detail);

  const second = makeFixture(t, {
    responseFor: (parsed) => parsed.pathname === '/api/library/tag_thumb'
      ? response(parsed.href, { status: 304, body: null, contentType: 'image/png', responseHeaders: { etag: '"image-v1"' } })
      : null,
    adapterOptions: { cachePath: first.cachePath, mediaRoot: first.mediaRoot }
  });
  const secondOwner = {
    ...discovered.detail,
    identity: { kind: 'style', base_model_id: 9102, source_id: '2x-nz:ANIMA:style:shared-304', parent_identity: 'root', normalized_name: '304 共享图' },
    source_version: 'ANIMA'
  };
  const secondDetail = await second.adapter.downloadImages(secondOwner);
  const repeatedSecond = await second.adapter.downloadImages(secondOwner);

  assert.equal(firstDetail.image_results[0].status, 'downloaded');
  assert.equal(secondDetail.image_results[0].status, 'downloaded');
  assert.notEqual(firstDetail.image_results[0].local_path, secondDetail.image_results[0].local_path);
  assert.equal(existsSync(join(first.mediaRoot, 'images', secondDetail.image_results[0].local_path)), true);
  assert.equal(repeatedSecond.image_results[0].status, 'existing');
});

test('reuses the same JSON catalog across two consecutive 304 refreshes', async (t) => {
  const jsonRequestCounts = new Map();
  const fixture = makeFixture(t, {
    adapterOptions: { cachePath: null },
    responseFor: (parsed, call) => {
      if (!['/api/library/categories', '/api/library'].includes(parsed.pathname)) return null;
      const count = (jsonRequestCounts.get(parsed.href) ?? 0) + 1;
      jsonRequestCounts.set(parsed.href, count);
      const responseOptions = parsed.pathname === '/api/library/categories'
        ? { body: categories(parsed.searchParams.get('mode')) }
        : { body: library() };
      return count === 1
        ? response(parsed.href, { ...responseOptions, responseHeaders: { etag: '"json-v1"' } })
        : (() => {
          assert.equal(call.options.headers['if-none-match'], '"json-v1"');
          return response(parsed.href, { status: 304, body: null, responseHeaders: { etag: '"json-v1"' } });
        })();
    }
  });

  const firstCatalog = await fixture.adapter.discoverCatalog();
  assert.equal(firstCatalog.length, 2);
  fixture.adapter.resetRequestStop();
  const secondCatalog = await fixture.adapter.discoverCatalog();
  fixture.adapter.resetRequestStop();
  const thirdCatalog = await fixture.adapter.discoverCatalog();

  assert.deepEqual(secondCatalog, firstCatalog);
  assert.deepEqual(thirdCatalog, firstCatalog);
  const jsonCalls = fixture.requests.filter(({ url }) => new URL(url).pathname !== '/api/library/tag_thumb');
  const urls = [...new Set(jsonCalls.map(({ url }) => url))];
  assert.ok(urls.length > 0);
  for (const url of urls) {
    const calls = jsonCalls.filter((call) => call.url === url);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.headers['if-none-match'], undefined);
    assert.equal(calls[1].options.headers['if-none-match'], '"json-v1"');
    assert.equal(calls[2].options.headers['if-none-match'], '"json-v1"');
  }
});

test('does not replace cached JSON with an error response carrying the same ETag', async (t) => {
  for (const status of [403, 503]) {
    await t.test(`HTTP ${status} remains a stop and the next 304 reuses the first body`, async (t) => {
      const etag = '"json-v1"';
      const first = makeFixture(t, {
        responseFor: (parsed) => {
          if (!['/api/library/categories', '/api/library'].includes(parsed.pathname)) return null;
          const body = parsed.pathname === '/api/library/categories'
            ? categories(parsed.searchParams.get('mode'))
            : library();
          return response(parsed.href, { body, responseHeaders: { etag } });
        }
      });
      const firstCatalog = await first.adapter.discoverCatalog();
      const httpCachePath = `${first.cachePath}.http.json`;
      const firstHttpCache = JSON.parse(readFileSync(httpCachePath, 'utf8'));
      assert.equal(firstHttpCache.entries[WAI_CATEGORY_URL].body, JSON.stringify(categories('WAI')));

      // Keep the HTTP cache while forcing each new adapter to refresh the JSON endpoints.
      rmSync(first.cachePath, { force: true });
      const second = makeFixture(t, {
        responseFor: (parsed, call) => {
          if (!['/api/library/categories', '/api/library'].includes(parsed.pathname)) return null;
          assert.equal(call.options.headers['if-none-match'], etag);
          return response(parsed.href, {
            status,
            body: { error: `offline HTTP ${status}` },
            responseHeaders: { etag }
          });
        },
        adapterOptions: { cachePath: first.cachePath, mediaRoot: first.mediaRoot }
      });
      const expectedCode = status === 403 ? 'HTTP_403' : 'HTTP_5XX';
      await assert.rejects(second.adapter.discoverCatalog(), (error) => errorCode(error) === expectedCode);
      assert.equal(second.requests.filter(({ url }) => new URL(url).pathname === '/api/library/categories').length, 1);
      assert.equal(second.requests.filter(({ url }) => new URL(url).pathname === '/api/library').length, 0);
      const afterErrorHttpCache = JSON.parse(readFileSync(httpCachePath, 'utf8'));
      assert.equal(afterErrorHttpCache.entries[WAI_CATEGORY_URL].body, JSON.stringify(categories('WAI')));

      const third = makeFixture(t, {
        responseFor: (parsed, call) => {
          if (!['/api/library/categories', '/api/library'].includes(parsed.pathname)) return null;
          assert.equal(call.options.headers['if-none-match'], etag);
          return response(parsed.href, { status: 304, body: null, responseHeaders: { etag } });
        },
        adapterOptions: { cachePath: first.cachePath, mediaRoot: first.mediaRoot }
      });
      const reusedCatalog = await third.adapter.discoverCatalog();

      assert.deepEqual(reusedCatalog, firstCatalog);
      assert.equal(third.requests.filter(({ url }) => new URL(url).pathname === '/api/library/categories').length, 2);
      assert.equal(third.requests.filter(({ url }) => new URL(url).pathname === '/api/library').length, 1);
    });
  }
});

test('records HTTP 5xx thumbnail failures while retaining 404 skips and 403/429 source stops', async (t) => {
  await t.test('404 is skipped without creating a file', async (t) => {
    const fixture = makeFixture(t, {
      responseFor: (parsed) => parsed.pathname === '/api/library/tag_thumb'
        ? response(parsed.href, { status: 404, body: '{"error":"not found"}', contentType: 'application/json' })
        : null
    });
    const { detail } = await discoverCharacter(fixture.adapter);
    const result = await fixture.adapter.downloadImages(detail);
    assert.equal(result.image_results[0].status, 'skipped');
    assert.match(result.image_results[0].reason, /404/u);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images', result.image_results[0].local_path ?? 'missing')), false);
  });

  for (const status of [403, 429]) {
    await t.test(`HTTP ${status} stops without a retry`, async (t) => {
      const fixture = makeFixture(t, {
        responseFor: (parsed) => parsed.pathname === '/api/library/tag_thumb'
          ? response(parsed.href, { status, contentType: 'image/png' })
          : null
      });
      const { detail } = await discoverCharacter(fixture.adapter);
      await assert.rejects(fixture.adapter.downloadImages(detail), (error) => errorCode(error) === `HTTP_${status}`);
      assert.equal(fixture.requests.filter(({ url }) => new URL(url).pathname === '/api/library/tag_thumb').length, 1);
    });
  }

  const localOrigin = await startLocalApi(t, (request, response) => {
    const status = Number(new URL(request.url, 'http://localhost').searchParams.get('status'));
    response.writeHead(status, { 'content-type': 'image/png' });
    response.end('status');
  });
  const localDirectory = mkdtempSync(join(tmpdir(), '2x-nz-real-status-'));
  t.after(() => rmSync(localDirectory, { recursive: true, force: true }));
  const realAdapter = defaultCrawleeAdapter(join(localDirectory, 'media'), localOrigin);
  const imageFor = (status) => localImageDetail(`${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?status=${status}`);
  assert.equal((await realAdapter.downloadImages(imageFor(404))).image_results[0].status, 'skipped');
  for (const status of [403, 429]) await assert.rejects(realAdapter.downloadImages(imageFor(status)), (error) => errorCode(error) === `HTTP_${status}`);
  for (const status of [505, 599]) {
    const result = await realAdapter.downloadImages(imageFor(status));
    assert.equal(result.image_results[0].status, 'failed');
    assert.equal(result.image_results[0].error.code, 'HTTP_5XX');
  }

  const downloadFailure = makeFixture(t, {
    responseFor: (parsed) => {
      if (parsed.pathname === '/api/library/tag_thumb') throw new Error('offline image connection failed');
      return null;
    }
  });
  const { detail } = await discoverCharacter(downloadFailure.adapter);
  const failed = await downloadFailure.adapter.downloadImages(detail);
  assert.equal(failed.image_results[0].status, 'failed');
  assert.equal(failed.image_results[0].error.code, 'IMAGE_DOWNLOAD_FAILED');
});

test('stops on API 403 or 429 before requesting another page', async (t) => {
  for (const status of [403, 429]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const fixture = makeFixture(t, {
        responseFor: (parsed) => parsed.pathname === '/api/library/categories'
          ? response(parsed.href, { status, body: {}, contentType: 'application/json' })
          : null
      });
      await assert.rejects(fixture.adapter.discoverCatalog(), (error) => errorCode(error) === `HTTP_${status}`);
      assert.equal(fixture.requests.filter(({ url }) => new URL(url).pathname === '/api/library/categories').length, 1);
      assert.equal(fixture.requests.filter(({ url }) => new URL(url).pathname === '/api/library').length, 0);
    });
  }
});

test('follows same-origin HTTP redirects and rejects foreign redirect targets', async (t) => {
  const sameOriginJsonFixture = makeFixture(t, {
    responseFor: (parsed) => parsed.pathname === '/api/library/categories'
      ? response(parsed.href, { finalUrl: `${TWO_X_NZ_API_ORIGIN}/api/library/categories?mode=${parsed.searchParams.get('mode')}&redirected=1`, body: categories(parsed.searchParams.get('mode')) })
      : null
  });
  await sameOriginJsonFixture.adapter.discoverCatalog();

  const apiFixture = makeFixture(t, {
    responseFor: (parsed) => parsed.pathname === '/api/library/categories'
      ? response(parsed.href, { finalUrl: 'https://foreign.example/redirected', body: categories('WAI') })
      : null
  });
  await assert.rejects(apiFixture.adapter.discoverCatalog(), (error) => ['STRUCTURE_CHANGED', 'INVALID_FIELD'].includes(errorCode(error)));

  const imageFixture = makeFixture(t, {
    responseFor: (parsed) => parsed.pathname === '/api/library/tag_thumb'
      ? response(parsed.href, { finalUrl: 'https://foreign.example/image.png', contentType: 'image/png' })
      : null
  });
  const { detail } = await discoverCharacter(imageFixture.adapter);
  await assert.rejects(imageFixture.adapter.downloadImages(detail), (error) => ['STRUCTURE_CHANGED', 'INVALID_FIELD'].includes(errorCode(error)));

  let hangingRequest = null;
  let receivedRequests = 0;
  const requestStarted = new Promise((resolvePromise) => { hangingRequest = resolvePromise; });
  const localOrigin = await startLocalApi(t, (request, response) => {
    receivedRequests += 1;
    const requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.searchParams.has('redirect')) {
      const location = requestUrl.searchParams.has('foreign') ? 'https://foreign.example/image.png' : '/elsewhere';
      response.writeHead(302, { location }); response.end(); return;
    }
    if (requestUrl.searchParams.has('hang')) { hangingRequest(); request.on('close', () => response.destroy()); return; }
    if (requestUrl.searchParams.has('timeout')) return;
    response.writeHead(200, { 'content-type': 'image/png' }); response.end('ok');
  });
  const localDirectory = mkdtempSync(join(tmpdir(), '2x-nz-real-control-'));
  t.after(() => rmSync(localDirectory, { recursive: true, force: true }));
  const realAdapter = defaultCrawleeAdapter(join(localDirectory, 'media'), localOrigin);
  const redirected = await realAdapter.downloadImages(localImageDetail(`${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?redirect=1`));
  assert.equal(redirected.image_results[0].status, 'downloaded');
  assert.equal(receivedRequests, 2);
  await assert.rejects(realAdapter.downloadImages(localImageDetail(`${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?redirect=1&foreign=1`)), (error) => errorCode(error) === 'STRUCTURE_CHANGED');
  const hanging = localImageDetail(`${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?hang=1`);
  const pending = realAdapter.downloadImages(hanging);
  await requestStarted;
  realAdapter.requestStop();
  await assert.rejects(pending, (error) => errorCode(error) === 'PROCESS_INTERRUPTED');
  const requestsAtStop = receivedRequests;
  await assert.rejects(realAdapter.downloadImages(localImageDetail(`${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?after-stop=1`)), (error) => errorCode(error) === 'PROCESS_INTERRUPTED');
  assert.equal(receivedRequests, requestsAtStop, '停止后不得创建新的 HTTP 请求');
  const timeoutAdapter = defaultCrawleeAdapter(join(localDirectory, 'timeout-media'), localOrigin);
  const timeoutResult = await timeoutAdapter.downloadImages(localImageDetail(`${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?timeout=1`));
  assert.equal(timeoutResult.image_results[0].status, 'failed');
  assert.equal(timeoutResult.image_results[0].error.code, 'TIMEOUT');
});

test('sends Cookie and Authorization only to the configured API origin', async (t) => {
  const fixture = makeFixture(t, { adapterOptions: { cookie: 'sid=offline', authorization: 'Bearer offline' } });
  const { detail } = await discoverCharacter(fixture.adapter);
  await fixture.adapter.downloadImages(detail);

  for (const call of fixture.requests) {
    assert.equal(new URL(call.url).origin, TWO_X_NZ_API_ORIGIN);
    assert.equal(call.options.headers.cookie, 'sid=offline');
    assert.equal(call.options.headers.authorization, 'Bearer offline');
  }

  const foreignDetail = {
    ...detail,
    extensions: { ...detail.extensions, thumbnail_url: 'https://foreign.example/private.png' }
  };
  const before = fixture.requests.length;
  await assert.rejects(fixture.adapter.downloadImages(foreignDetail), (error) => ['STRUCTURE_CHANGED', 'INVALID_FIELD'].includes(errorCode(error)));
  assert.equal(fixture.requests.length, before, 'credentials must never be sent to a foreign origin');

  const storageStatePath = join(fixture.directory, 'storage-state.json');
  writeFileSync(storageStatePath, JSON.stringify({
    cookies: [
      { name: 'sid', value: 'state', domain: 'api-ai.acofork.com' },
      { name: 'foreign', value: 'keep-out', domain: 'foreign.example' }
    ],
    origins: [{ origin: TWO_X_NZ_API_ORIGIN, localStorage: [{ name: 'authorization', value: 'Bearer storage' }] }]
  }));
  assert.deepEqual(read2xNzCredentials(storageStatePath), { cookie: 'sid=state', authorization: 'Bearer storage' });
  const jsonPath = join(fixture.directory, 'credentials.json');
  writeFileSync(jsonPath, JSON.stringify({ cookie: 'one=1; two=2', authorization: 'Bearer json' }));
  assert.deepEqual(read2xNzCredentials(jsonPath), { cookie: 'one=1; two=2', authorization: 'Bearer json' });
  const netscapePath = join(fixture.directory, 'cookies.txt');
  writeFileSync(netscapePath, '# Netscape HTTP Cookie File\napi-ai.acofork.com\tTRUE\t/\tTRUE\t0\tsid\tnetscape\nforeign.example\tTRUE\t/\tTRUE\t0\tforeign\tkeep-out\n');
  assert.deepEqual(read2xNzCredentials(netscapePath), { cookie: 'sid=netscape', authorization: null });
  writeFileSync(storageStatePath, JSON.stringify({ cookies: [{ name: '', value: 'x', domain: 'api-ai.acofork.com' }] }));
  assert.throws(() => read2xNzCredentials(storageStatePath), (error) => errorCode(error) === 'CREDENTIALS_INVALID');
});

test('persists a valid checkpoint, resumes, imports records, and writes a valid report', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-crawlee-checkpoint-'));
  const dataRoot = join(directory, 'data');
  mkdirSync(join(dataRoot, 'media', 'images'), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const identity = { kind: 'style', base_model_id: 9101, source_id: '2x-nz:WAI:style:one', parent_identity: 'root', normalized_name: '画风一' };
  const detail = {
    identity,
    source_url: `${TWO_X_NZ_API_ORIGIN}/api/library?mode=WAI&category=%E7%94%BB%E9%A3%8E%E4%B8%80&limit=200&offset=0`,
    name: '画风一',
    base_model_id: 9101,
    aliases: [],
    prompt_text: 'style prompt',
    style_description: null,
    image_results: [],
    fetched_at: '2026-07-28T08:00:00.000Z'
  };
  const adapter = {
    kind: '2x-nz-api',
    sourceConfig: {
      schema_version: 1,
      source_name: '2x.nz role-style library',
      source_base_url: TWO_X_NZ_DRAW_URL,
      request: { concurrency: 1, min_delay_seconds: 3, max_delay_seconds: 3, timeout_seconds: 20, max_retries: 0, retry_wait_seconds: [30, 120], max_run_minutes: 60 }
    },
    async discoverCatalog() { return [{ identity, source_url: detail.source_url, name: detail.name, source_version: 'WAI', source_updated_at: null, discovered_at: '2026-07-28T08:00:00.000Z' }]; },
    async fetchDetail() { return detail; },
    async downloadImages(value) { return value; }
  };
  const databasePath = join(dataRoot, 'app.sqlite');
  const historicalRepositoryRoot = createHistoricalRepository(t);
  runMediaCutover({ databasePath, mediaRoot: join(dataRoot, 'media'), repositoryRoot: historicalRepositoryRoot });
  const database = openCatalogDatabase({ databasePath, repositoryRoot: historicalRepositoryRoot, includeBuiltinComfyuiCatalog: false });
  database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
  database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (9101, 'wai', ?, ?)").run('2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z');
  t.after(() => database.close());
  const runner = createManualIngestRunner({ dataRoot, mediaRoot: join(dataRoot, 'media'), sourceConfig: adapter.sourceConfig, adapter, database, config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }, now: () => new Date('2026-07-28T08:00:00.000Z') });

  await assert.rejects(runner.run({ interruptAfter: 1 }), (error) => error instanceof ManualIngestInterrupted);
  const checkpoint = runner.readState();
  assert.equal(checkpoint.status, 'running');
  assert.equal(checkpoint.pending_details.length, 0);
  assert.equal(checkpoint.completed_identities.length, 1);
  assert.equal(validateJsonSample(checkpoint, resolve(repositoryRoot, 'schema/crawler/crawl-state.schema.json'), contracts.schemas).length, 0);

  const result = await runner.resume();
  assert.equal(result.state.status, 'completed');
  assert.equal(result.state.stage, 'report');
  assert.equal(result.state.report_path, 'data/reports/2x.nz-role-style-library-latest.json');
  assert.equal(result.report.counts.discovered, 1);
  assert.equal(result.report.counts.created, 1);
  assert.equal(result.report.counts.pending, 0);
  assert.equal(validateJsonSample(result.report, resolve(repositoryRoot, 'schema/crawler/crawl-report.schema.json'), contracts.schemas).length, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, 1);
});
