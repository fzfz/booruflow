import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { loadAuthoritativeContracts, validateJsonSample } from '../../app/contracts/authoritative-contracts.mjs';
import { createDownloadmostAdapter, DOWNLOADMOST_CATALOG_URL, DOWNLOADMOST_ORIGIN, DOWNLOADMOST_PAGE_COUNT } from '../../app/ingest/sources/downloadmost.mjs';
import { main as runDownloadmost, resolveDownloadmostBaseModelId } from '../../ingest/manual/run-downloadmost.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const contracts = loadAuthoritativeContracts(repositoryRoot);
const SOURCE_ORIGIN = DOWNLOADMOST_ORIGIN;
const IMAGE_BYTES = Buffer.from('downloadmost-local-image');
const IMAGE_HASH = createHash('sha256').update(IMAGE_BYTES).digest('hex');

function response(url, { status = 200, body = '', contentType = 'text/html; charset=utf-8', bytes = IMAGE_BYTES } = {}) {
  return {
    status,
    url,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    async text() { return body; },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  };
}

function catalogCard({
  id = 'model-alpha',
  name = 'Alpha Model'
} = {}) {
  return `
    <div class="card">
      <a href="/NoobAI-XL/danbooru-artist/searchartist.asp?artistname=${id}">
        <span class="user-select-all fw-bold text-warning">${name}</span>
      </a>
    </div>`;
}

function pageHtml(cards) {
  return `<main class="model-grid">${cards.join('\n')}</main>`;
}

function detailHtml({ name = 'Alpha Model', prompt = 'alpha trigger, portrait', preview1 = '/NoobAI-XL/danbooru-artist/preview1/alpha-1.jpg', preview2 = '/NoobAI-XL/danbooru-artist/preview2/alpha-2.jpg', unknown = '' } = {}) {
  return `<main>
    <h1>${name}</h1>
    <p>Prompt trigger: ${prompt}</p>
    <img src="${preview1}" alt="Preview 1">
    <img src="${preview2}" alt="Preview 2">
    ${unknown}
  </main>`;
}

function sourceConfig() {
  return {
    schema_version: 1,
    source_name: 'downloadmost HTML library',
    source_base_url: DOWNLOADMOST_CATALOG_URL,
    request: {
      concurrency: 1,
      min_delay_seconds: 3,
      max_delay_seconds: 3,
      timeout_seconds: 20,
      max_retries: 0,
      retry_wait_seconds: [30, 120],
      max_run_minutes: 60
    }
  };
}

function setup(t, { pages = new Map([[1, pageHtml([catalogCard()])]]), details = new Map([[`${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/searchartist.asp?artistname=model-alpha`, detailHtml()]]), imageStatuses = new Map(), adapterOptions = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'downloadmost-adapter-'));
  const mediaRoot = join(directory, 'media');
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requested = [];
  const request = async (url) => {
    requested.push(url);
    const parsed = new URL(url);
    const page = parsed.pathname === new URL(DOWNLOADMOST_CATALOG_URL).pathname ? Number(parsed.searchParams.get('page') ?? 1) : null;
    if (page !== null) {
      if (!pages.has(page)) throw new Error(`unexpected page ${url}`);
      const body = pages.get(page);
      if (body instanceof Error) throw body;
      return response(url, { body });
    }
    if (details.has(url)) return response(url, { body: details.get(url) });
    if (parsed.pathname.startsWith('/NoobAI-XL/danbooru-artist/preview')) {
      const status = imageStatuses.get(parsed.pathname) ?? 200;
      return response(url, { status, body: '', contentType: 'image/webp' });
    }
    throw new Error(`unexpected DownloadMost URL ${url}`);
  };
  const adapter = createDownloadmostAdapter({
    mediaRoot,
    request,
    minDelayMilliseconds: 0,
    now: () => new Date('2026-07-28T08:00:00Z'),
    baseModelId: 9917,
    ...adapterOptions
  });
  return { adapter, mediaRoot, requested };
}

function allOfficialPages(firstPage) {
  const pages = new Map();
  for (let page = 1; page <= DOWNLOADMOST_PAGE_COUNT; page += 1) pages.set(page, firstPage);
  return pages;
}

function schemaErrors(value, name) {
  return validateJsonSample(value, resolve(repositoryRoot, `schema/crawler/${name}`), contracts.schemas);
}

test('parses a normal static card and maps artist, prompt trigger, and both previews', async (t) => {
  const { adapter, mediaRoot, requested } = setup(t, {
    pages: allOfficialPages(pageHtml([catalogCard({
      id: 'alpha-42',
      name: 'Alpha 42'
    })])),
    details: new Map([[`${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/searchartist.asp?artistname=alpha-42`, detailHtml({
      name: 'Alpha 42',
      prompt: 'alpha42, cinematic portrait',
      preview1: '/NoobAI-XL/danbooru-artist/preview1/alpha-42-1.jpg',
      preview2: '/NoobAI-XL/danbooru-artist/preview2/alpha-42-2.jpg'
    })]])
  });

  const catalog = await adapter.discoverCatalog();
  assert.equal(catalog.length, 1);
  assert.deepEqual(schemaErrors(catalog[0], 'catalog-entry.schema.json'), []);
  assert.equal(catalog[0].identity.kind, 'style');
  assert.equal(catalog[0].name, 'Alpha 42');
  assert.equal(catalog[0].source_url, `${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/searchartist.asp?artistname=alpha-42`);

  const detail = await adapter.fetchDetail({ identity: catalog[0].identity, detail_url: catalog[0].source_url });
  assert.equal(detail.base_model_id, 9917);
  assert.equal(Object.hasOwn(detail, 'source_version'), false);
  assert.equal(Object.hasOwn(detail, 'source_updated_at'), false);
  assert.equal(detail.prompt_text, 'alpha42, cinematic portrait');
  assert.deepEqual(schemaErrors(detail, 'detail-result.schema.json'), []);

  const downloaded = await adapter.downloadImages(detail);
  assert.deepEqual(downloaded.image_results.map((image) => image.source_url), [
    `${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/preview1/alpha-42-1.jpg`,
    `${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/preview2/alpha-42-2.jpg`
  ]);
  assert.deepEqual(downloaded.image_results.map((image) => image.sort_order), [0, 1]);
  assert.deepEqual(downloaded.image_results.map((image) => image.status), ['downloaded', 'downloaded']);
  for (const image of downloaded.image_results) {
    assert.deepEqual(schemaErrors(image, 'image-result.schema.json'), []);
    assert.deepEqual(image.owner_identity, detail.identity);
    const localPath = join(mediaRoot, 'images', image.local_path);
    assert.equal(existsSync(localPath), true);
    assert.equal(createHash('sha256').update(readFileSync(localPath)).digest('hex'), IMAGE_HASH);
  }
  assert.equal(requested.filter((url) => new URL(url).pathname.includes('/preview')).length, 2);
});

test('keeps stable identities and deduplicates cards repeated across pages 1 through 250', async (t) => {
  const pages = new Map();
  for (let page = 1; page <= DOWNLOADMOST_PAGE_COUNT; page += 1) {
    const entries = [catalogCard({ id: `model-${page}`, name: `Model ${page}` })];
    if (page === 2) entries.push(catalogCard({ id: 'model-1', name: 'Model 1' }));
    pages.set(page, pageHtml(entries));
  }
  const first = setup(t, { pages });
  const firstCatalog = await first.adapter.discoverCatalog();
  assert.equal(firstCatalog.length, 250);
  assert.equal(first.requested.filter((url) => new URL(url).pathname.includes('/NoobAI-XL/danbooru-artist/')).length, DOWNLOADMOST_PAGE_COUNT);
  assert.deepEqual(firstCatalog.map((entry) => entry.name), Array.from({ length: 250 }, (_, index) => `Model ${index + 1}`));
  assert.equal(firstCatalog.deduplications.length, 1);
  assert.equal(firstCatalog.deduplications[0].reason, 'source_id');

  const second = setup(t, { pages: allOfficialPages(pageHtml([catalogCard({ id: 'model-1', name: 'Model 1' })])) });
  const secondCatalog = await second.adapter.discoverCatalog();
  assert.deepEqual(firstCatalog[0].identity, secondCatalog[0].identity);
  assert.deepEqual(firstCatalog[0].identity, {
    kind: 'style',
    base_model_id: 9917,
    source_id: firstCatalog[0].identity.source_id,
    parent_identity: 'root',
    normalized_name: 'Model 1'
  });
});

test('requires an explicit Downloadmost base-model mapping', async (t) => {
  const missing = setup(t, { adapterOptions: { baseModelId: null } });
  await assert.rejects(() => missing.adapter.discoverCatalog(), /generation_base_models|base_model_id/u);
  await assert.rejects(() => missing.adapter.fetchDetail({ identity: { kind: 'style' } }), /generation_base_models|base_model_id/u);
});

test('production Downloadmost entry resolves the unique WAI model without fixed IDs', () => {
  const makeDatabase = (rows) => ({ prepare() { return { all() { return rows; } }; } });
  assert.equal(resolveDownloadmostBaseModelId(makeDatabase([{ id: 9917, name: 'wai' }])), 9917);
  assert.throws(() => resolveDownloadmostBaseModelId(makeDatabase([])), /exactly one.*wai/u);
  assert.throws(() => resolveDownloadmostBaseModelId(makeDatabase([{ id: 9917, name: 'wai' }, { id: 9918, name: 'WAI' }])), /exactly one.*wai/u);
});

function entryDatabase(rows) {
  return {
    prepare() {
      return { all() { return rows; } };
    },
    close() {}
  };
}

test('Downloadmost smoke entry does not open a database or resolve a WAI mapping', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'downloadmost-entry-smoke-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  let openCalls = 0;
  const adapterOptions = [];
  const result = await runDownloadmost(['--data-root', dataRoot, '--smoke'], {
    openDatabase() {
      openCalls += 1;
      throw new Error('smoke must not open app.sqlite');
    },
    createAdapter(options) {
      adapterOptions.push(options);
      return { async smoke() { return { page_1_entries: 0 }; } };
    }
  });
  assert.equal(openCalls, 0);
  assert.deepEqual(result, { status: 'source_state_recorded', source_state: { page_1_entries: 0 } });
  assert.equal(adapterOptions.length, 1);
  assert.equal(Object.hasOwn(adapterOptions[0], 'baseModelId'), false);
});

test('Downloadmost non-smoke entry resolves a dynamic WAI ID before creating its adapter', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'downloadmost-entry-mapped-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  let capturedOptions = null;
  const expected = new Error('stop after adapter construction');
  await assert.rejects(() => runDownloadmost(['--data-root', dataRoot], {
    openDatabase: () => entryDatabase([{ id: 47001, name: 'wai' }]),
    createAdapter(options) {
      capturedOptions = options;
      throw expected;
    }
  }), (error) => error === expected);
  assert.deepEqual(capturedOptions, { mediaRoot: join(dataRoot, 'media'), baseModelId: 47001 });
});

test('Downloadmost non-smoke entry fails explicitly on missing or duplicate WAI mappings', async (t) => {
  for (const rows of [[], [{ id: 47001, name: 'wai' }, { id: 47002, name: 'WAI' }]]) {
    await t.test(rows.length === 0 ? 'missing mapping' : 'duplicate mapping', async (subtest) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'downloadmost-entry-invalid-map-'));
      subtest.after(() => rmSync(dataRoot, { recursive: true, force: true }));
      let createCalls = 0;
      await assert.rejects(() => runDownloadmost(['--data-root', dataRoot], {
        openDatabase: () => entryDatabase(rows),
        createAdapter() {
          createCalls += 1;
          return null;
        }
      }), /exactly one.*wai/u);
      assert.equal(createCalls, 0);
    });
  }
});

test('rejects a conflicting duplicate identity instead of silently merging it', async (t) => {
  const pages = new Map([[1, pageHtml([catalogCard({ id: 'same-id', name: 'First Name' })])], [2, pageHtml([catalogCard({ id: 'same-id', name: 'Second Name' })])]]);
  for (let page = 3; page <= DOWNLOADMOST_PAGE_COUNT; page += 1) pages.set(page, pageHtml([catalogCard({ id: `other-${page}`, name: `Other ${page}` })]));
  const { adapter } = setup(t, { pages });
  await assert.rejects(() => adapter.discoverCatalog(), (error) => error?.code === 'SOURCE_MAPPING_MISMATCH');
});

test('parses actual preview URL forms and rejects a preview outside the configured source', async (t) => {
  const { adapter } = setup(t, {
    pages: allOfficialPages(pageHtml([catalogCard({
      id: 'url-forms',
      name: 'URL Forms'
    })])),
    details: new Map([[`${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/searchartist.asp?artistname=url-forms`, detailHtml({ name: 'URL Forms', preview1: `${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/preview1/encoded%20name.jpg`, preview2: '/NoobAI-XL/danbooru-artist/preview2/relative-name.jpg' })]])
  });
  const catalog = await adapter.discoverCatalog();
  const detail = await adapter.fetchDetail({ identity: catalog[0].identity });
  const result = await adapter.downloadImages(detail);
  assert.deepEqual(result.image_results.map((image) => image.source_url), [
    `${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/preview1/encoded%20name.jpg`,
    `${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/preview2/relative-name.jpg`
  ]);

  const outside = setup(t, {
    pages: allOfficialPages(pageHtml([catalogCard({ id: 'outside', name: 'Outside' })])),
    details: new Map([[`${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/searchartist.asp?artistname=outside`, detailHtml({ name: 'Outside', preview1: 'https://cdn.example.invalid/image.webp' })]])
  });
  const outsideCatalog = await outside.adapter.discoverCatalog();
  await assert.rejects(() => outside.adapter.fetchDetail({ identity: outsideCatalog[0].identity }), (error) => error?.code === 'STRUCTURE_CHANGED');
});

test('records HTTP 404 preview responses as skipped without writing an image', async (t) => {
  const { adapter, mediaRoot } = setup(t, {
    pages: allOfficialPages(pageHtml([catalogCard({ id: 'missing-preview', name: 'Missing Preview' })])),
    details: new Map([[`${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/searchartist.asp?artistname=missing-preview`, detailHtml({ name: 'Missing Preview', preview1: '/NoobAI-XL/danbooru-artist/preview1/missing.jpg', preview2: '/NoobAI-XL/danbooru-artist/preview2/kept.jpg' })]]),
    imageStatuses: new Map([['/NoobAI-XL/danbooru-artist/preview1/missing.jpg', 404]])
  });
  const catalog = await adapter.discoverCatalog();
  const detail = await adapter.fetchDetail({ identity: catalog[0].identity });
  const result = await adapter.downloadImages(detail);
  assert.equal(result.image_results[0].status, 'skipped');
  assert.match(result.image_results[0].reason, /404/u);
  assert.equal(result.image_results[1].status, 'downloaded');
  assert.equal(existsSync(join(mediaRoot, result.image_results[0].local_path ?? 'images/missing.webp')), false);
});

test('stops immediately on 403, 429, CAPTCHA, structure changes, and unknown card fields', async (t) => {
  const cases = [
    { name: '403', status: 403, code: 'HTTP_403' },
    { name: '429', status: 429, code: 'HTTP_429' },
    { name: 'captcha', body: '<html><body>captcha: verify you are human</body></html>', code: 'CAPTCHA_DETECTED' },
    { name: 'structure', body: '<main><article class="model-card"><h2>Missing required fields</h2></article></main>', code: 'STRUCTURE_CHANGED' },
    { name: 'unknown field', body: '<main><div class="card"><span class="unexpected-source-field">unexpected source field</span></div></main>', code: 'STRUCTURE_CHANGED' }
  ];
  for (const item of cases) {
    const setupResult = setup(t, {
      pages: new Map([[1, item.status ? new Error(`HTTP ${item.status}`) : item.body]]),
      details: new Map([[`${SOURCE_ORIGIN}/NoobAI-XL/danbooru-artist/searchartist.asp?artistname=model-alpha`, item.status ? detailHtml() : item.body]]),
      adapterOptions: { firstPageResponse: item.status ? { status: item.status, body: '' } : undefined }
    });
    if (item.status) {
      const request = async (url) => response(url, { status: item.status, body: '' });
      const directory = mkdtempSync(join(tmpdir(), `downloadmost-${item.name}-`));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const statusAdapter = createDownloadmostAdapter({ mediaRoot: join(directory, 'media'), baseModelId: 9917, request, minDelayMilliseconds: 0 });
      await assert.rejects(() => statusAdapter.discoverCatalog(), (error) => error?.code === item.code);
    } else {
      await assert.rejects(() => setupResult.adapter.discoverCatalog(), (error) => error?.code === item.code);
    }
  }
});

test('fails closed for a malformed card response and never calls the real network', async (t) => {
  const { adapter, requested } = setup(t, { pages: allOfficialPages('<html><script>captcha</script></html>') });
  await assert.rejects(() => adapter.discoverCatalog(), (error) => error?.code === 'STRUCTURE_CHANGED' || error?.code === 'CAPTCHA_DETECTED');
  assert.equal(requested.length, 1);
});
