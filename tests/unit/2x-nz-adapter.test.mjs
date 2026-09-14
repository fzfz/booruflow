import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

import { loadAuthoritativeContracts, validateJsonSample } from '../../app/contracts/authoritative-contracts.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { assertManualStart, createManualIngestRunner as createManualIngestRunnerBase } from '../../app/ingest/manual-ingest.mjs';
import { create2xNzCrawleeAdapter as create2xNzCrawleeAdapterBase, TWO_X_NZ_API_ORIGIN, TWO_X_NZ_DRAW_URL, TwoXNzSourceError } from '../../app/ingest/sources/2x-nz-crawlee.mjs';

const root = resolve(import.meta.dirname, '../..');
const contracts = loadAuthoritativeContracts(root);
const IMAGE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
const IMAGE_HASH = createHash('sha256').update(IMAGE).digest('hex');
const VECTOR_CONFIGURATION = Object.freeze({ embedding_model: 'fake' });
const MODEL_CLIENT = Object.freeze({ async embed(inputs) { return inputs.map(() => createFixtureVector()); } });
const BASE_MODEL_IDS = Object.freeze({ WAI: 9101, ANIMA: 9102 });

function create2xNzCrawleeAdapter(options = {}) {
  return create2xNzCrawleeAdapterBase({ baseModelIds: BASE_MODEL_IDS, ...options });
}

function createManualIngestRunner(options) {
  return createManualIngestRunnerBase({ modelClient: MODEL_CLIENT, vectorConfiguration: VECTOR_CONFIGURATION, ...options });
}

function openPersistentCatalogDatabase(databasePath) {
  runMediaCutover({ databasePath, mediaRoot: join(dirname(databasePath), 'media') });
  const database = openCatalogDatabase({ databasePath });
  database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
  return database;
}

function response(url, { status = 200, body = null, contentType = 'application/json; charset=utf-8', cachedLocalPath = null, cachedOwnerSourceId = null } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const result = {
    status,
    url,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    async text() { return text; },
    async arrayBuffer() { return IMAGE.buffer.slice(IMAGE.byteOffset, IMAGE.byteOffset + IMAGE.byteLength); }
  };
  if (cachedLocalPath !== null) result.cachedLocalPath = cachedLocalPath;
  if (cachedOwnerSourceId !== null) result.cachedOwnerSourceId = cachedOwnerSourceId;
  return result;
}

function record({ id, type, mode = 'WAI', category, thumbnail = undefined, tags = 'prompt text', kind = 'builtin' }) {
  return { id, kind, type, mode, name: `${type}-${id}`, tags, ...(category === undefined ? {} : { category }), ...(thumbnail === undefined ? {} : { thumbnail }) };
}

function createRequest({ categories, pages, onUrl = () => {}, thumbnailResponse = null } = {}) {
  return async (url) => {
    onUrl(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/library/categories') return response(url, { body: categories[parsed.searchParams.get('mode')] });
    if (parsed.pathname === '/api/library') {
      const key = [parsed.searchParams.get('mode'), parsed.searchParams.get('category'), parsed.searchParams.get('offset')].join('|');
      return response(url, { body: pages[key] });
    }
    if (parsed.pathname === '/api/library/tag_thumb' || parsed.pathname === '/api/library/thumb' || parsed.pathname === '/api/style_thumbnail') return thumbnailResponse?.(url) ?? response(url, { body: '', contentType: 'image/png' });
    throw new Error(`unexpected URL ${url}`);
  };
}

function fixture() {
  const characters = Array.from({ length: 201 }, (_, index) => record({ id: `character-${index}`, type: 'character', category: '作品甲', thumbnail: index === 0 ? '/api/library/tag_thumb?cat=x&name=y.jpg' : undefined }));
  const styles = [record({ id: 'style-1', type: 'style', category: '画风甲' })];
  return {
    categories: {
      WAI: { characters: [{ name: '作品甲', count: 201 }], styles: [{ name: '画风甲', count: 1 }], total: { characters: 1, styles: 1 } },
      ANIMA: { characters: [], styles: [], total: { characters: 0, styles: 0 } }
    },
    pages: {
      'WAI|作品甲|0': { characters: characters.slice(0, 200), styles: [], mode: 'WAI', total: { characters: 201, styles: 0 } },
      'WAI|作品甲|200': { characters: characters.slice(200), styles: [], mode: 'WAI', total: { characters: 201, styles: 0 } },
      'WAI|画风甲|0': { characters: [], styles, mode: 'WAI', total: { characters: 0, styles: 1 } }
    }
  };
}

function emptyFixture() {
  return {
    categories: {
      WAI: { characters: [], styles: [], total: { characters: 0, styles: 0 } },
      ANIMA: { characters: [], styles: [], total: { characters: 0, styles: 0 } }
    },
    pages: {}
  };
}

function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-adapter-'));
  const mediaRoot = join(directory, 'media');
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fixture();
  const urls = [];
  const adapter = create2xNzCrawleeAdapter({ mediaRoot, request: createRequest({ ...source, onUrl: (url) => urls.push(url), ...overrides }), baseModelIds: { WAI: 9101, ANIMA: 9102 }, minDelayMilliseconds: 0, now: () => new Date('2026-07-28T08:00:00Z') });
  return { adapter, mediaRoot, source, urls };
}

test('discovers real API response shape with category works before their characters and validates schemas', async (t) => {
  const { adapter, mediaRoot, urls } = setup(t);
  const catalog = await adapter.discoverCatalog();
  assert.equal(catalog.length, 203);
  assert.equal(catalog[0].identity.kind, 'work');
  assert.equal(catalog[0].name, '作品甲');
  const character = catalog.find((item) => item.identity.kind === 'character');
  assert.deepEqual(character.identity.parent_work_identity, catalog[0].identity);
  assert.equal(catalog.find((item) => item.identity.kind === 'style').category_name, '画风甲');
  assert(urls.some((url) => new URL(url).searchParams.get('offset') === '200'));
  for (const item of catalog) {
    assert.deepEqual(validateJsonSample(item, resolve(root, 'schema/crawler/catalog-entry.schema.json'), contracts.schemas), []);
  }
  const workDetail = await adapter.fetchDetail({ identity: catalog[0].identity });
  const characterDetail = await adapter.fetchDetail({ identity: character.identity });
  assert.deepEqual(validateJsonSample(workDetail, resolve(root, 'schema/crawler/detail-result.schema.json'), contracts.schemas), []);
  assert.deepEqual(validateJsonSample(characterDetail, resolve(root, 'schema/crawler/detail-result.schema.json'), contracts.schemas), []);
  assert.equal(characterDetail.extensions.source_item_mode, 'WAI');
  const downloaded = await adapter.downloadImages(characterDetail);
  assert.equal(downloaded.image_results.length, 1);
  assert.equal(downloaded.image_results[0].status, 'downloaded');
  assert.match(downloaded.image_results[0].local_path, new RegExp(`^2x-nz/[a-f0-9]{32}-${IMAGE_HASH}\\.img$`, 'u'));
  assert.equal(urls.find((url) => new URL(url).pathname === '/api/library/tag_thumb'), `${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?cat=x&name=y.jpg`);
  assert(existsSync(join(mediaRoot, 'images', downloaded.image_results[0].local_path)));
  assert.deepEqual(readFileSync(join(mediaRoot, 'images', downloaded.image_results[0].local_path)), IMAGE);
});

test('resolves Style identities from the configured non-production mode mapping and rejects a missing mapping', async (t) => {
  const source = fixture();
  source.categories.ANIMA = { characters: [], styles: [{ name: '画风乙', count: 1 }], total: { characters: 0, styles: 1 } };
  source.pages['ANIMA|画风乙|0'] = { characters: [], styles: [record({ id: 'style-anima', type: 'style', mode: 'ANIMA', category: '画风乙' })], mode: 'ANIMA', total: { characters: 0, styles: 1 } };
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-style-mapping-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(directory, 'media'), request: createRequest(source), baseModelIds: { WAI: 9901, ANIMA: 9902 }, minDelayMilliseconds: 0 });
  const styles = (await adapter.discoverCatalog()).filter((entry) => entry.identity.kind === 'style');
  assert.deepEqual(styles.map((entry) => entry.identity.base_model_id).sort(), [9901, 9902]);

  const missingMapping = create2xNzCrawleeAdapter({ mediaRoot: join(directory, 'missing-media'), request: createRequest(source), baseModelIds: { WAI: 9901 }, minDelayMilliseconds: 0 });
  await assert.rejects(missingMapping.discoverCatalog(), (error) => error.code === 'STRUCTURE_CHANGED' && /ANIMA/u.test(error.message));
});

test('stores a shared thumbnail separately for each owner and reuses it for the same owner', async (t) => {
  const { adapter, mediaRoot } = setup(t);
  const catalog = await adapter.discoverCatalog();
  const character = catalog.find((item) => item.identity.kind === 'character');
  const detail = await adapter.fetchDetail({ identity: character.identity });
  const firstOwner = { ...detail, identity: { kind: 'style', base_model_id: 9101, source_id: '2x-nz:WAI:style:shared-one', parent_identity: 'root', normalized_name: '共享图一' } };
  const secondOwner = { ...detail, identity: { kind: 'style', base_model_id: 9102, source_id: '2x-nz:ANIMA:style:shared-two', parent_identity: 'root', normalized_name: '共享图二' }, base_model_id: 9102, source_version: 'ANIMA' };

  const first = await adapter.downloadImages(firstOwner);
  const second = await adapter.downloadImages(secondOwner);
  const repeatedFirst = await adapter.downloadImages(firstOwner);

  assert.equal(first.image_results[0].status, 'downloaded');
  assert.equal(second.image_results[0].status, 'downloaded');
  assert.notEqual(first.image_results[0].local_path, second.image_results[0].local_path);
  assert.match(first.image_results[0].local_path, new RegExp(`^2x-nz/[a-f0-9]{32}-${IMAGE_HASH}\\.img$`, 'u'));
  assert.match(second.image_results[0].local_path, new RegExp(`^2x-nz/[a-f0-9]{32}-${IMAGE_HASH}\\.img$`, 'u'));
  assert.equal(existsSync(join(mediaRoot, 'images', first.image_results[0].local_path)), true);
  assert.equal(existsSync(join(mediaRoot, 'images', second.image_results[0].local_path)), true);
  assert.equal(repeatedFirst.image_results[0].status, 'existing');
  assert.equal(repeatedFirst.image_results[0].local_path, first.image_results[0].local_path);
});

test('uses a new random path for a changed thumbnail URL with identical content', async (t) => {
  const { adapter } = setup(t);
  const catalog = await adapter.discoverCatalog();
  const character = catalog.find((item) => item.identity.kind === 'character');
  const detail = await adapter.fetchDetail({ identity: character.identity });
  const first = await adapter.downloadImages(detail);
  const second = await adapter.downloadImages({
    ...detail,
    extensions: { ...detail.extensions, thumbnail_url: `${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?cat=renamed&name=other.jpg` }
  });
  assert.notEqual(first.image_results[0].source_url, second.image_results[0].source_url);
  assert.notEqual(first.image_results[0].local_path, second.image_results[0].local_path);
  assert.match(second.image_results[0].local_path, new RegExp(`^2x-nz/[a-f0-9]{32}-${IMAGE_HASH}\\.img$`, 'u'));
});

test('rewrites a missing cached path for the same owner', async (t) => {
  let cachedLocalPath = null;
  let ownerSourceId = null;
  const { adapter, mediaRoot } = setup(t, {
    thumbnailResponse: (url) => response(url, { body: '', contentType: 'image/png', cachedLocalPath, cachedOwnerSourceId: ownerSourceId })
  });
  const catalog = await adapter.discoverCatalog();
  const character = catalog.find((item) => item.identity.kind === 'character');
  const detail = await adapter.fetchDetail({ identity: character.identity });
  const first = await adapter.downloadImages(detail);
  const oldPath = first.image_results[0].local_path;
  cachedLocalPath = oldPath;
  ownerSourceId = detail.identity.source_id;
  rmSync(join(mediaRoot, 'images', oldPath), { force: true });

  const rewritten = await adapter.downloadImages(detail);
  const newPath = rewritten.image_results[0].local_path;
  assert.equal(rewritten.image_results[0].status, 'downloaded');
  assert.notEqual(newPath, oldPath);
  assert.match(newPath, new RegExp(`^2x-nz/[a-f0-9]{32}-${IMAGE_HASH}\\.img$`, 'u'));
  assert.equal(existsSync(join(mediaRoot, 'images', newPath)), true);
  assert.deepEqual(readFileSync(join(mediaRoot, 'images', newPath)), IMAGE);
  assert.equal(createHash('sha256').update(readFileSync(join(mediaRoot, 'images', newPath))).digest('hex'), IMAGE_HASH);
});

test('uses global API pagination for the formal batch path and keeps both arrays isolated', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-global-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fixture();
  source.pages['WAI||0'] = { characters: source.pages['WAI|作品甲|0'].characters, styles: source.pages['WAI|画风甲|0'].styles, mode: 'WAI', total: { characters: 201, styles: 1 } };
  source.pages['WAI||200'] = { characters: source.pages['WAI|作品甲|200'].characters, styles: [], mode: 'WAI', total: { characters: 201, styles: 1 } };
  const urls = [];
  const adapter = create2xNzCrawleeAdapter({
    mediaRoot: join(directory, 'media'),
    request: createRequest({ ...source, onUrl: (url) => urls.push(url) }),
    minDelayMilliseconds: 0,
    globalPaging: true
  });
  const catalog = await adapter.discoverCatalog();
  assert.equal(catalog.filter((entry) => entry.identity.kind === 'character').length, 201);
  assert.equal(catalog.filter((entry) => entry.identity.kind === 'style').length, 1);
  assert.deepEqual(urls.filter((url) => new URL(url).pathname === '/api/library').map((url) => new URL(url).searchParams.get('category')), [null, null]);
});

test('bounds long encoded source identities without losing deterministic uniqueness', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-long-id-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = emptyFixture();
  const category = '分类'.repeat(80);
  const id = `tag_${'对象'.repeat(80)}`;
  source.categories.WAI = { characters: [{ name: category, count: 1 }], styles: [], total: { characters: 1, styles: 0 } };
  source.pages[`WAI|${category}|0`] = { characters: [{ id, kind: 'builtin', type: 'character', mode: 'WAI', name: '长 ID 对象', tags: 'prompt', category }], styles: [], mode: 'WAI', total: { characters: 1, styles: 0 } };
  const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(directory, 'media'), request: createRequest(source), minDelayMilliseconds: 0 });
  const catalog = await adapter.discoverCatalog();
  const entry = catalog.find((item) => item.identity.kind === 'character');
  assert.equal(entry.identity.source_id.length <= 256, true);
  assert.deepEqual(validateJsonSample(entry, resolve(root, 'schema/crawler/catalog-entry.schema.json'), contracts.schemas), []);
});

test('keeps ordinary source prompt text containing auth words as data', async (t) => {
  const source = fixture();
  source.pages['WAI|作品甲|0'].characters[0].tags = 'forbidden prompt';
  const { adapter } = setup(t, source);
  const catalog = await adapter.discoverCatalog();
  const character = catalog.find((item) => item.identity.kind === 'character');
  assert.equal((await adapter.fetchDetail({ identity: character.identity })).prompt_text, 'forbidden prompt');
});

test('imports external source objects and accepts their API thumbnail path', async (t) => {
  const source = fixture();
  source.pages['WAI|作品甲|0'].characters[0] = record({
    id: 'external-character-0',
    kind: 'external',
    type: 'character',
    category: '作品甲',
    thumbnail: '/api/library/thumb?path=WAI%2Fexternal.png'
  });
  source.pages['WAI|作品甲|0'].characters[0].url = '';
  source.pages['WAI|作品甲|0'].characters[0].lora_path = '';
  const { adapter } = setup(t, source);
  const catalog = await adapter.discoverCatalog();
  const character = catalog.find((item) => item.identity.kind === 'character' && item.name === 'character-external-character-0');
  const detail = await adapter.fetchDetail({ identity: character.identity });
  const downloaded = await adapter.downloadImages(detail);
  assert.equal(downloaded.image_results[0].status, 'downloaded');
});

test('stops on an early short page before the stable total', async (t) => {
  const source = fixture();
  const allCharacters = [...source.pages['WAI|作品甲|0'].characters, ...source.pages['WAI|作品甲|200'].characters];
  source.pages['WAI|作品甲|0'].characters = allCharacters.slice(0, 1);
  source.pages['WAI|作品甲|200'].characters = allCharacters.slice(1);
  const { adapter, urls } = setup(t, source);
  await assert.rejects(adapter.discoverCatalog(), (error) => error instanceof TwoXNzSourceError && error.code === 'STRUCTURE_CHANGED');
  assert.deepEqual(
    urls
      .filter((url) => new URL(url).pathname === '/api/library' && new URL(url).searchParams.get('category') === '作品甲')
      .map((url) => Number(new URL(url).searchParams.get('offset'))),
    [0]
  );
});

test('permits the explicit 2x.nz manual gate and requires both source origins', (t) => {
  const { adapter } = setup(t);
  assert.doesNotThrow(() => assertManualStart({
    sourceConfig: adapter.sourceConfig,
    adapter,
    config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } },
    contracts
  }));
  assert.throws(() => assertManualStart({
    sourceConfig: adapter.sourceConfig,
    adapter,
    config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin] } },
    contracts
  }), /acofork/u);
});

test('reopens the formal catalog database after a stopped collection', (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'app.sqlite');
  const first = openPersistentCatalogDatabase(databasePath);
  first.close();
  const second = openPersistentCatalogDatabase(databasePath);
  assert.equal(second.prepare('SELECT version FROM schema_migrations WHERE name = ?').get('001-initial').version, 1);
  assert.equal(second.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'works'").get().name, 'works');
  second.close();
});

test('stops on API access controls, unsafe content, missing prompt, and missing character category', async (t) => {
  const cases = [
    {
      name: '403',
      request: async (url) => response(url, { status: 403, body: {} }),
      code: 'HTTP_403'
    },
    {
      name: 'script',
      source: (() => { const value = fixture(); value.pages['WAI|作品甲|0'].characters[0].tags = '<script>unsafe</script>'; return value; })(),
      code: 'SCRIPT_CONTENT'
    },
    {
      name: 'empty prompt',
      source: (() => { const value = fixture(); value.pages['WAI|作品甲|0'].characters[0].tags = ''; return value; })(),
      code: 'STRUCTURE_CHANGED'
    },
    {
      name: 'missing category',
      source: (() => { const value = fixture(); delete value.pages['WAI|作品甲|0'].characters[0].category; return value; })(),
      code: 'STRUCTURE_CHANGED'
    },
    {
      name: 'invalid thumbnail URL',
      source: (() => { const value = fixture(); value.pages['WAI|作品甲|0'].characters[0].thumbnail = 'http://[invalid'; return value; })(),
      code: 'STRUCTURE_CHANGED'
    },
    {
      name: 'missing categories total',
      source: (() => { const value = fixture(); delete value.categories.WAI.total; return value; })(),
      code: 'STRUCTURE_CHANGED'
    },
    {
      name: 'missing categories total characters',
      source: (() => { const value = fixture(); delete value.categories.WAI.total.characters; return value; })(),
      code: 'STRUCTURE_CHANGED'
    },
    {
      name: 'missing categories total styles',
      source: (() => { const value = fixture(); delete value.categories.WAI.total.styles; return value; })(),
      code: 'STRUCTURE_CHANGED'
    },
    {
      name: 'category totals do not match category list',
      source: (() => { const value = fixture(); value.categories.WAI.total.characters = 2; return value; })(),
      code: 'STRUCTURE_CHANGED'
    },
    {
      name: 'API body timeout',
      request: async (url) => ({ ...response(url), async text() { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } }),
      code: 'TIMEOUT'
    },
    {
      name: 'explicitly unavailable',
      source: (() => { const value = fixture(); value.pages['WAI|作品甲|0'].characters[0].available = false; return value; })(),
      code: 'SOURCE_MAPPING_MISMATCH'
    }
  ];
  for (const item of cases) {
    const directory = mkdtempSync(join(tmpdir(), '2x-nz-stop-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = item.source ?? fixture();
    const adapter = create2xNzCrawleeAdapter({ mediaRoot: directory, request: item.request ?? createRequest(source), minDelayMilliseconds: 0 });
    await assert.rejects(adapter.discoverCatalog(), (error) => error instanceof TwoXNzSourceError && error.code === item.code, item.name);
  }
});

test('records an explicit source takedown and preserves the database without creating an unavailable row', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-takedown-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fixture();
  source.pages['WAI|作品甲|0'].characters[0].deleted = true;
  const dataRoot = join(directory, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
  try {
    const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(dataRoot, 'media'), request: createRequest(source), minDelayMilliseconds: 0 });
    const runner = createManualIngestRunner({
      dataRoot,
      mediaRoot: join(dataRoot, 'media'),
      sourceConfig: adapter.sourceConfig,
      adapter,
      database,
      config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }
    });
    const result = await runner.run();
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.errors[0].code, 'SOURCE_MAPPING_MISMATCH');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM characters').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, 0);
  } finally {
    database.close();
  }
});

test('smoke records both modes without loading every category page', async (t) => {
  const { adapter, urls } = setup(t);
  const state = await adapter.smoke();
  assert.equal(state.modes.WAI.character_count, 201);
  assert.equal(state.modes.WAI.style_count, 1);
  assert.equal(state.modes.ANIMA.character_count, 0);
  assert.equal(urls.filter((url) => new URL(url).pathname === '/api/library').length, 0);
});

test('accepts valid empty categories and rejects a nonzero category with zero page total', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-empty-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = emptyFixture();
  const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(directory, 'media'), request: createRequest(source), minDelayMilliseconds: 0 });
  assert.deepEqual(await adapter.discoverCatalog(), []);
  assert.deepEqual((await adapter.smoke()).modes, {
    WAI: { character_categories: 0, style_categories: 0, character_count: 0, style_count: 0 },
    ANIMA: { character_categories: 0, style_categories: 0, character_count: 0, style_count: 0 }
  });

  const emptyPageSource = emptyFixture();
  emptyPageSource.categories.WAI = { characters: [{ name: '空作品', count: 1 }], styles: [], total: { characters: 1, styles: 0 } };
  emptyPageSource.pages['WAI|空作品|0'] = { characters: [], styles: [], mode: 'WAI', total: { characters: 0, styles: 0 } };
  const emptyPageAdapter = create2xNzCrawleeAdapter({ mediaRoot: join(directory, 'empty-page-media'), request: createRequest(emptyPageSource), minDelayMilliseconds: 0 });
  await assert.rejects(emptyPageAdapter.discoverCatalog(), (error) => error instanceof TwoXNzSourceError && error.code === 'STRUCTURE_CHANGED');

  const dataRoot = join(directory, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
  try {
    const runner = createManualIngestRunner({
      dataRoot,
      mediaRoot: join(dataRoot, 'media'),
      sourceConfig: adapter.sourceConfig,
      adapter,
      database,
      config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }
    });
    const result = await runner.run();
    assert.equal(result.state.status, 'completed');
    assert.equal(result.report.errors.length, 0);
    assert.deepEqual(result.report.counts, {
      discovered: 0, fetched: 0, created: 0, updated: 0, duplicates: 0,
      skipped: 0, skipped_existing: 0, failed: 0, pending: 0,
      images_downloaded: 0, images_skipped: 0, images_failed: 0
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM characters').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, 0);
  } finally {
    database.close();
  }
});

test('uses requested mode for collection while preserving item mode mismatch', async (t) => {
  const source = fixture();
  source.categories.ANIMA = { characters: [{ name: '作品乙', count: 1 }], styles: [], total: { characters: 1, styles: 0 } };
  source.pages['ANIMA|作品乙|0'] = {
    characters: [record({ id: 'character-anima', type: 'character', category: '作品乙', mode: 'WAI' })],
    styles: [record({ id: 'style-anima-mixed', type: 'style', category: '画风乙', mode: 'WAI' })],
    mode: 'ANIMA',
    total: { characters: 1, styles: 1 }
  };
  const { adapter } = setup(t, source);
  const catalog = await adapter.discoverCatalog();
  const animaItems = catalog.filter((item) => item.source_version === 'ANIMA');
  assert.deepEqual(animaItems.map((item) => item.identity.kind), ['work', 'character']);
  assert.equal(catalog.some((item) => item.identity.source_id === '2x-nz:ANIMA:style:style-anima-mixed'), false);
  const character = catalog.find((item) => item.identity.kind === 'character' && item.name === 'character-character-anima');
  assert(character);
  assert.equal(character.identity.source_id, '2x-nz:ANIMA:character:character-anima');
  const detail = await adapter.fetchDetail({ identity: character.identity });
  assert.equal(detail.identity.parent_work_identity.source_id, '2x-nz:ANIMA:category:%E4%BD%9C%E5%93%81%E4%B9%99');
  assert.equal(detail.extensions.source_item_mode, 'WAI');
});

test('reports cross-page duplicates while preserving first-seen order', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-duplicate-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = emptyFixture();
  source.categories.WAI = { characters: [{ name: '作品甲', count: 204 }], styles: [], total: { characters: 1, styles: 0 } };
  const filler = Array.from({ length: 198 }, (_, index) => record({ id: `filler-${index}`, type: 'character', category: '作品甲' }));
  source.pages['WAI|作品甲|0'] = {
    characters: [record({ id: 'a', type: 'character', category: '作品甲' }), record({ id: 'b', type: 'character', category: '作品甲' }), ...filler],
    styles: [], mode: 'WAI', total: { characters: 204, styles: 0 }
  };
  source.pages['WAI|作品甲|200'] = {
    characters: [record({ id: 'b', type: 'character', category: '作品甲' }), record({ id: 'c', type: 'character', category: '作品甲' }), record({ id: 'd', type: 'character', category: '作品甲' }), record({ id: 'e', type: 'character', category: '作品甲' })],
    styles: [], mode: 'WAI', total: { characters: 204, styles: 0 }
  };
  const urls = [];
  const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(directory, 'media'), request: createRequest({ ...source, onUrl: (url) => urls.push(url) }), minDelayMilliseconds: 0 });
  const catalog = await adapter.discoverCatalog();
  assert.deepEqual(catalog.filter((entry) => entry.identity.kind === 'character').slice(0, 5).map((entry) => entry.identity.source_id), [
    '2x-nz:WAI:character:a', '2x-nz:WAI:character:b', '2x-nz:WAI:character:filler-0', '2x-nz:WAI:character:filler-1', '2x-nz:WAI:character:filler-2'
  ]);
  assert.equal(catalog.filter((entry) => entry.identity.kind === 'character').length, 203);
  assert.equal(catalog.deduplications.length, 1);
  assert.equal(catalog.deduplications[0].reason, 'source_id');
  assert.equal(catalog.deduplications[0].incoming_identity.source_id, '2x-nz:WAI:character:b');
  assert.deepEqual(
    urls.filter((url) => new URL(url).pathname === '/api/library').map((url) => Number(new URL(url).searchParams.get('offset'))),
    [0, 200]
  );

  const dataRoot = join(directory, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
  try {
    const runner = createManualIngestRunner({
      dataRoot,
      mediaRoot: join(dataRoot, 'media'),
      sourceConfig: adapter.sourceConfig,
      adapter,
      database,
      config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }
    });
    const result = await runner.run();
    assert.equal(result.report.status, 'completed');
    assert.equal(result.report.deduplications.filter((item) => item.incoming_identity?.source_id === '2x-nz:WAI:character:b').length, 1);
    assert.deepEqual(validateJsonSample(result.report, resolve(root, 'schema/crawler/crawl-report.schema.json'), contracts.schemas), []);
  } finally {
    database.close();
  }
});

test('uses limit 200 and offsets 0, 200, 400 for a 200 plus 200 plus 37 page set', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-pagination-437-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = emptyFixture();
  const records = Array.from({ length: 437 }, (_, index) => record({ id: `character-${index}`, type: 'character', category: '作品甲' }));
  source.categories.WAI = { characters: [{ name: '作品甲', count: 437 }], styles: [], total: { characters: 1, styles: 0 } };
  source.pages['WAI|作品甲|0'] = { characters: records.slice(0, 200), styles: records.slice(0, 0), mode: 'WAI', total: { characters: 437, styles: 0 } };
  source.pages['WAI|作品甲|200'] = { characters: records.slice(200, 400), styles: records.slice(0, 0), mode: 'WAI', total: { characters: 437, styles: 0 } };
  source.pages['WAI|作品甲|400'] = { characters: records.slice(400), styles: records.slice(0, 0), mode: 'WAI', total: { characters: 437, styles: 0 } };
  const urls = [];
  const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(directory, 'media'), request: createRequest({ ...source, onUrl: (url) => urls.push(url) }), minDelayMilliseconds: 0 });
  const catalog = await adapter.discoverCatalog();
  const pages = urls.filter((url) => new URL(url).pathname === '/api/library' && new URL(url).searchParams.get('category') === '作品甲');
  assert.deepEqual(pages.map((url) => Number(new URL(url).searchParams.get('offset'))), [0, 200, 400]);
  assert.deepEqual(pages.map((url) => Number(new URL(url).searchParams.get('limit'))), [200, 200, 200]);
  assert.equal(catalog.filter((entry) => entry.identity.kind === 'character').length, 437);
});

test('stops on a changed total or an empty page before the expected total', async (t) => {
  for (const mode of ['changed total', 'empty page', 'category/page count mismatch']) {
    const directory = mkdtempSync(join(tmpdir(), '2x-nz-pagination-stop-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = emptyFixture();
    source.categories.WAI = { characters: [{ name: '作品甲', count: 201 }], styles: [], total: { characters: 1, styles: 0 } };
    source.pages['WAI|作品甲|0'] = { characters: Array.from({ length: 200 }, (_, index) => record({ id: `character-${index}`, type: 'character', category: '作品甲' })), styles: [], mode: 'WAI', total: { characters: 201, styles: 0 } };
    source.pages['WAI|作品甲|200'] = mode === 'changed total'
      ? { characters: [record({ id: 'character-200', type: 'character', category: '作品甲' })], styles: [], mode: 'WAI', total: { characters: 202, styles: 0 } }
      : { characters: [], styles: [], mode: 'WAI', total: { characters: mode === 'category/page count mismatch' ? 0 : 201, styles: 0 } };
    const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(directory, 'media'), request: createRequest(source), minDelayMilliseconds: 0 });
    await assert.rejects(adapter.discoverCatalog(), (error) => error instanceof TwoXNzSourceError && error.code === 'STRUCTURE_CHANGED', mode);
  }
});

test('stores original evidence for every explicit unavailable marker', async (t) => {
  const cases = [
    ['deleted', true], ['disabled', true], ['available', false],
    ['status', 'removed'], ['status', 'unavailable'], ['status', 'inactive']
  ];
  for (const [field, value] of cases) {
    const directory = mkdtempSync(join(tmpdir(), '2x-nz-unavailable-evidence-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = fixture();
    source.pages['WAI|作品甲|0'].characters[0][field] = value;
    const dataRoot = join(directory, 'data');
    mkdirSync(dataRoot, { recursive: true });
    const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
    try {
      const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(dataRoot, 'media'), request: createRequest(source), minDelayMilliseconds: 0 });
      const runner = createManualIngestRunner({
        dataRoot,
        mediaRoot: join(dataRoot, 'media'),
        sourceConfig: adapter.sourceConfig,
        adapter,
        database,
        config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }
      });
      const result = await runner.run();
      assert.equal(result.report.errors[0].code, 'SOURCE_MAPPING_MISMATCH', field);
      const evidenceRelativePath = result.report.errors[0].evidence.html_path.replace(/^data\//u, '');
      const evidencePath = join(dataRoot, evidenceRelativePath);
      assert.equal(evidenceRelativePath.startsWith('raw/'), true);
      assert.equal(existsSync(evidencePath), true);
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      assert.equal(evidence.page_url.startsWith(TWO_X_NZ_API_ORIGIN), true);
      assert.equal(evidence.object[field], value);
      assert.equal(evidence.sha256, createHash('sha256').update(JSON.stringify(evidence.object)).digest('hex'));
      assert.deepEqual(validateJsonSample(result.report.errors[0], resolve(root, 'schema/crawler/crawl-error.schema.json'), contracts.schemas), []);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM characters').get().count, 0);
    } finally {
      database.close();
    }
  }
});

test('keeps explicit unavailable handling out of the source adapter', async () => {
  const sourceText = readFileSync(resolve(root, 'app/ingest/sources/2x-nz-crawlee.mjs'), 'utf8');
  assert.equal(sourceText.includes('is_available = 0'), false);
});

test('writes a structure diff when discovery stops on a source contract change', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-structure-diff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fixture();
  delete source.categories.WAI.total;
  const dataRoot = join(directory, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
  try {
    const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(dataRoot, 'media'), request: createRequest(source), minDelayMilliseconds: 0 });
    const runner = createManualIngestRunner({
      dataRoot,
      mediaRoot: join(dataRoot, 'media'),
      sourceConfig: adapter.sourceConfig,
      adapter,
      database,
      config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }
    });
    const result = await runner.run();
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.errors[0].code, 'STRUCTURE_CHANGED');
    assert.equal(result.report.structure_diffs.length, 1);
    assert.deepEqual(result.report.structure_diffs[0].evidence, result.report.errors[0].evidence);
    assert.deepEqual(validateJsonSample(result.report, resolve(root, 'schema/crawler/crawl-report.schema.json'), contracts.schemas), []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 0);
  } finally {
    database.close();
  }
});

test('pauses at the configured max run time before discovery continues', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-runtime-limit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = emptyFixture();
  source.categories.WAI = { characters: [{ name: '作品甲', count: 1 }], styles: [], total: { characters: 1, styles: 0 } };
  source.pages['WAI|作品甲|0'] = { characters: [record({ id: 'character-1', type: 'character', category: '作品甲' })], styles: [], mode: 'WAI', total: { characters: 1, styles: 0 } };
  const dataRoot = join(directory, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
  try {
    const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(dataRoot, 'media'), request: createRequest(source), minDelayMilliseconds: 0 });
    const sourceConfig = { ...adapter.sourceConfig, request: { ...adapter.sourceConfig.request, max_run_minutes: 1 } };
    const runtimeTimes = [0, 60_001];
    const runner = createManualIngestRunner({
      dataRoot,
      mediaRoot: join(dataRoot, 'media'),
      sourceConfig,
      adapter,
      database,
      runtimeNow: () => runtimeTimes.shift() ?? 60_001,
      config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }
    });
    const result = await runner.run();
    assert.equal(result.state.status, 'paused');
    assert.equal(result.state.stop_reason, 'RUN_TIME_LIMIT');
    assert.equal(result.state.resume_allowed, true);
    assert.equal(result.report.counts.pending, 0);
    assert.equal(result.state.pending_details.length, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 0);
  } finally {
    database.close();
  }
});

test('checks runtime after throttling and records thumbnail timeout as a failed image', async (t) => {
  const throttleDirectory = mkdtempSync(join(tmpdir(), '2x-nz-throttle-guard-'));
  t.after(() => rmSync(throttleDirectory, { recursive: true, force: true }));
  const throttleSource = emptyFixture();
  const throttleUrls = [];
  let guardChecks = 0;
  const throttleAdapter = create2xNzCrawleeAdapter({
    mediaRoot: join(throttleDirectory, 'media'),
    minDelayMilliseconds: 1000,
    sleep: async () => {},
    request: async (url, options) => {
      throttleUrls.push(url);
      return createRequest(throttleSource)(url, options);
    }
  });
  throttleAdapter.setRuntimeGuard(() => ++guardChecks >= 4);
  await assert.rejects(throttleAdapter.smoke(), (error) => error instanceof TwoXNzSourceError && error.code === 'RUN_TIME_LIMIT');
  assert.equal(throttleUrls.length, 1);

  const imageDirectory = mkdtempSync(join(tmpdir(), '2x-nz-image-throttle-guard-'));
  t.after(() => rmSync(imageDirectory, { recursive: true, force: true }));
  let imageRequests = 0;
  let imageGuardChecks = 0;
  const imageAdapter = create2xNzCrawleeAdapter({
    mediaRoot: join(imageDirectory, 'media'),
    minDelayMilliseconds: 1000,
    sleep: async () => {},
    request: async (url) => {
      imageRequests += 1;
      return response(url, { body: '', contentType: 'image/png' });
    }
  });
  const imageDetail = {
    identity: { kind: 'character', source_id: 'character-image-guard', parent_work_identity: { kind: 'work', source_id: 'work-image-guard', parent_identity: 'root', normalized_name: '作品甲' }, normalized_name: '角色甲' },
    source_url: `${TWO_X_NZ_API_ORIGIN}/api/library?mode=WAI&category=%E4%BD%9C%E5%93%81%E7%94%B2&limit=200&offset=0`,
    name: '角色甲',
    source_version: 'WAI',
    extensions: { thumbnail_url: `${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?cat=x&name=y.jpg` }
  };
  await imageAdapter.downloadImages(imageDetail);
  imageAdapter.setRuntimeGuard(() => ++imageGuardChecks >= 2);
  await assert.rejects(imageAdapter.downloadImages(imageDetail), (error) => error instanceof TwoXNzSourceError && error.code === 'RUN_TIME_LIMIT');
  assert.equal(imageRequests, 1);

  const directory = mkdtempSync(join(tmpdir(), '2x-nz-thumbnail-timeout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = emptyFixture();
  source.categories.WAI = { characters: [{ name: '作品甲', count: 1 }], styles: [], total: { characters: 1, styles: 0 } };
  source.pages['WAI|作品甲|0'] = { characters: [record({ id: 'character-timeout', type: 'character', category: '作品甲', thumbnail: '/api/library/tag_thumb?cat=x&name=y.jpg' })], styles: [], mode: 'WAI', total: { characters: 1, styles: 0 } };
  const dataRoot = join(directory, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
  const urls = [];
  try {
    const request = async (url, options) => {
      urls.push(url);
      if (new URL(url).pathname === '/api/library/tag_thumb') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return createRequest(source)(url, options);
    };
    const adapter = create2xNzCrawleeAdapter({ mediaRoot: join(dataRoot, 'media'), request, minDelayMilliseconds: 0 });
    const runner = createManualIngestRunner({
      dataRoot,
      mediaRoot: join(dataRoot, 'media'),
      sourceConfig: adapter.sourceConfig,
      adapter,
      database,
      config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }
    });
    const result = await runner.run();
    assert.equal(result.report.status, 'completed');
    assert.equal(result.report.errors.length, 1);
    assert.equal(result.report.errors.at(-1).code, 'TIMEOUT');
    assert.equal(result.report.errors.at(-1).image_source_url, `${TWO_X_NZ_API_ORIGIN}/api/library/tag_thumb?cat=x&name=y.jpg`);
    assert.equal(result.report.counts.images_failed, 1);
    assert.equal(result.state.stop_reason, null);
    assert.equal(urls.filter((url) => new URL(url).pathname === '/api/library/tag_thumb').length, 1);
  } finally {
    database.close();
  }
});

test('skips a missing optional thumbnail without failing the object', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-thumbnail-404-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = emptyFixture();
  source.categories.WAI = { characters: [{ name: '作品甲', count: 1 }], styles: [], total: { characters: 1, styles: 0 } };
  source.pages['WAI|作品甲|0'] = { characters: [record({ id: 'character-404', type: 'character', category: '作品甲', thumbnail: '/api/library/tag_thumb?cat=x&name=missing.jpg' })], styles: [], mode: 'WAI', total: { characters: 1, styles: 0 } };
  let thumbnailRequests = 0;
  const adapter = create2xNzCrawleeAdapter({
    mediaRoot: join(directory, 'media'),
    minDelayMilliseconds: 0,
    request: async (url) => new URL(url).pathname === '/api/library/tag_thumb'
      ? (thumbnailRequests += 1, response(url, { status: 404, body: { error: 'not found' } }))
      : createRequest(source)(url)
  });
  const catalog = await adapter.discoverCatalog();
  const detail = await adapter.fetchDetail({ identity: catalog.find((entry) => entry.identity.kind === 'character').identity });
  const result = await adapter.downloadImages(detail);
  assert.equal(result.image_results[0].status, 'skipped');
  assert.match(result.image_results[0].reason, /没有该图片资源/u);
  assert.equal(result.identity.kind, 'character');
  const second = await adapter.downloadImages(detail);
  assert.equal(second.image_results[0].status, 'skipped');
  assert.equal(thumbnailRequests, 1);
});

test('aborts an in-flight API request when the collector is interrupted', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-interrupt-request-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = create2xNzCrawleeAdapter({
    mediaRoot: join(directory, 'media'),
    minDelayMilliseconds: 0,
    request: async (_url, { signal }) => await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })
  });
  const pending = adapter.smoke();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  adapter.requestStop();
  await assert.rejects(pending, (error) => error instanceof TwoXNzSourceError && error.code === 'PROCESS_INTERRUPTED');
});

test('classifies a HTTP 200 login page as AUTH_EXPIRED with raw evidence', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), '2x-nz-login-page-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataRoot = join(directory, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
  try {
    const adapter = create2xNzCrawleeAdapter({
      mediaRoot: join(dataRoot, 'media'),
      request: async (url) => response(url, { body: '<html>Login required</html>', contentType: 'text/html; charset=utf-8' }),
      minDelayMilliseconds: 0
    });
    const runner = createManualIngestRunner({
      dataRoot,
      mediaRoot: join(dataRoot, 'media'),
      sourceConfig: adapter.sourceConfig,
      adapter,
      database,
      config: { crawler: { allowed_source_origins: [new URL(TWO_X_NZ_DRAW_URL).origin, TWO_X_NZ_API_ORIGIN] } }
    });
    const result = await runner.run();
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.errors[0].code, 'AUTH_EXPIRED');
    const evidencePath = join(dataRoot, result.report.errors[0].evidence.html_path.replace(/^data\//u, ''));
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.object.status, 200);
    assert.equal(evidence.object.final_url.startsWith(TWO_X_NZ_API_ORIGIN), true);
    assert.equal(evidence.object.headers['content-type'].startsWith('text/html'), true);
    assert.equal(evidence.object.body.includes('Login required'), true);
  } finally {
    database.close();
  }
});
