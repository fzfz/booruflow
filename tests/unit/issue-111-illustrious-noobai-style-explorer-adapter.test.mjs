import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { assertCrawlerCrossObjectConsistency, loadAuthoritativeContracts, validateJsonSample } from '../../app/contracts/authoritative-contracts.mjs';
import { openCatalogDatabase as openRawCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogImporter, createManualIngestRunner } from '../../app/ingest/manual-ingest.mjs';
import {
  createIllustriousNoobaiStyleExplorerAdapter as createRawIllustriousNoobaiStyleExplorerAdapter,
  parseIllustriousNoobaiStyleExplorerSource
} from '../../app/ingest/sources/illustrious-noobai-style-explorer.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const CONTRACTS = loadAuthoritativeContracts(ROOT);
const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/issue-111/illustrious-noobai-style-explorer');
const SOURCE_TEXT = readFileSync(join(FIXTURE_DIR, 'data.js'), 'utf8');
const IMAGE_BYTES = readFileSync(join(FIXTURE_DIR, 'preview.png'));
const SOURCE_BASE_URL = 'https://styles.example.test/';
const SOURCE_URL = 'https://styles.example.test/data.js';
const NOW = () => new Date('2026-08-03T00:00:00.000Z');
const CRAWL_CONFIG = { crawler: { allowed_source_origins: ['https://styles.example.test'] } };
const VECTOR_CONFIGURATION = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });
const MODEL_CLIENT = Object.freeze({ async embed(inputs) { return inputs.map(() => createFixtureVector()); } });
const BASE_MODEL_ID = 21001;
const PROMPT_LINES = [
  'Exact Source Name\tfull original prompt line 0: preserve commas, weights:1.25, and trailing source text.',
  'Alias Source Name (Source Alias) (New Alias)\tfull original prompt line 1: preserve every token, punctuation, and spacing.',
  'Normalized Name Source\tfull original prompt line 2: preserve normalized name source exactly as provided.',
  'Normalized Alias Source (Normalized Alias Only) (Fresh Normalized Alias)\tfull original prompt line 3: preserve normalized alias source exactly as provided.'
];

function createIllustriousNoobaiStyleExplorerAdapter(options = {}) {
  const forwarded = {};
  for (const key of Object.keys(options)) {
    if (key !== 'artist_prompt_strings') forwarded[key] = options[key];
  }
  forwarded.baseModelId ??= BASE_MODEL_ID;
  return createRawIllustriousNoobaiStyleExplorerAdapter(forwarded);
}

function openCatalogDatabase() {
  const database = openRawCatalogDatabase();
  database.prepare(`INSERT INTO generation_base_models(id, name, created_at, updated_at)
    VALUES (?, 'wai', ?, ?)`)
    .run(BASE_MODEL_ID, NOW().toISOString(), NOW().toISOString());
  return database;
}

function insertStyleFixture(database, {
  id = null,
  base_model_id = BASE_MODEL_ID,
  name,
  aliases_json = '[]',
  prompt_text,
  style_description = null,
  cover_media_path = null
}) {
  const columns = 'base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path';
  const values = [base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path];
  if (id === null) return database.prepare(`INSERT INTO styles(${columns}) VALUES (?, ?, ?, ?, ?, ?)`).run(...values);
  return database.prepare(`INSERT INTO styles(id, ${columns}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, ...values);
}

function previewUrl(id, previewRef) {
  return `${SOURCE_BASE_URL}preview/${encodeURIComponent(id)}/${encodeURIComponent(previewRef)}.png`;
}

function createAdapter(options = {}) {
  return createIllustriousNoobaiStyleExplorerAdapter({
    sourceText: SOURCE_TEXT,
    sourceBaseUrl: SOURCE_BASE_URL,
    sourceUrl: SOURCE_URL,
    now: NOW,
    ...options
  });
}

function removeDownloadedBytes(detail) {
  return {
    ...detail,
    image_results: detail.image_results.map(({ bytes, media_type, ...image }) => image)
  };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'issue-111-style-explorer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('parses raw prompt lines for pairing while records expose only the schema-safe prompt body', () => {
  const parsed = parseIllustriousNoobaiStyleExplorerSource(SOURCE_TEXT);

  assert.deepEqual(parsed.promptLines, PROMPT_LINES);
  assert.deepEqual(parsed.records.map(({ name, aliases, prompt_text, preview_refs }) => ({ name, aliases, prompt_text, preview_refs })), [
    { name: 'Exact Source Name', aliases: [], prompt_text: 'full original prompt line 0: preserve commas, weights:1.25, and trailing source text.', preview_refs: ['exact-preview-a', 'exact-preview-b'] },
    { name: 'Alias Source Name', aliases: ['Source Alias', 'New Alias'], prompt_text: 'full original prompt line 1: preserve every token, punctuation, and spacing.', preview_refs: ['alias-preview-a'] },
    { name: 'Normalized Name Source', aliases: [], prompt_text: 'full original prompt line 2: preserve normalized name source exactly as provided.', preview_refs: ['normalized-name-preview'] },
    { name: 'Normalized Alias Source', aliases: ['Normalized Alias Only', 'Fresh Normalized Alias'], prompt_text: 'full original prompt line 3: preserve normalized alias source exactly as provided.', preview_refs: ['normalized-alias-preview'] }
  ]);
  for (const record of parsed.records) {
    assert.deepEqual(Object.keys(record).sort(), ['aliases', 'name', 'preview_refs', 'prompt_text']);
    assert.equal(record.prompt_text.includes('\t'), false);
  }
});

test('decodes escaped parenthetical aliases from the external gallery source', () => {
  const adapter = createIllustriousNoobaiStyleExplorerAdapter({
    sourceText: `const galleryData = [{ id: 'escaped-name-001', name: 'hammer \\(sunset beach\\)', p: 'preview-a' }];\nconst promptLines = ['hammer \\(sunset beach\\)\\tescaped alias prompt'];`,
    sourceBaseUrl: SOURCE_BASE_URL,
    sourceUrl: SOURCE_URL,
    now: NOW
  });
  return adapter.discoverCatalog().then(async ([entry]) => {
    const detail = await adapter.fetchDetail({ identity: entry.identity });
    assert.deepEqual({ name: detail.name, aliases: detail.aliases, prompt_text: detail.prompt_text }, {
      name: 'hammer',
      aliases: ['sunset beach'],
      prompt_text: 'escaped alias prompt'
    });
  });
});

test('rejects count/name mismatches and executable source text without executing it', () => {
  assert.throws(() => parseIllustriousNoobaiStyleExplorerSource(SOURCE_TEXT.replace('Alias Source Name (Source Alias) (New Alias)\\t', 'Wrong Source Name (Source Alias) (New Alias)\\t')), /mismatch/u);
  assert.throws(() => parseIllustriousNoobaiStyleExplorerSource(SOURCE_TEXT.replace("  'Normalized Alias Source (Normalized Alias Only) (Fresh Normalized Alias)\\tfull original prompt line 3: preserve normalized alias source exactly as provided.'\n", '')), /count mismatch/u);
  assert.throws(() => parseIllustriousNoobaiStyleExplorerSource(`${SOURCE_TEXT}\nglobalThis.sideEffect()`), /unexpected|unsupported|expression/u);
});

test('rejects repeated source names within one configured base model', () => {
  assert.throws(() => createIllustriousNoobaiStyleExplorerAdapter({
    galleryData: [
      { id: 'duplicate-name-001', name: 'goma \\(gomasamune\\)', p: 'preview-a' },
      { id: 'duplicate-name-002', name: 'goma \\(yoku yatta hou jane\\)', p: 'preview-b' }
    ],
    promptLines: [
      'goma \\(gomasamune\\)\tgoma \\(gomasamune\\)',
      'goma \\(yoku yatta hou jane\\)\tgoma \\(yoku yatta hou jane\\)'
    ],
    sourceBaseUrl: SOURCE_BASE_URL,
    sourceUrl: SOURCE_URL,
    now: NOW
  }), /same Style identity|same base model|multiple source records/u);
});

test('rejects repeated source names even when legacy source identifiers differ', () => {
  assert.throws(() => createIllustriousNoobaiStyleExplorerAdapter({
    galleryData: [
      { id: 'repeated-existing-001', name: 'kouji \\(campus life\\)', p: 'preview-a' },
      { id: 'repeated-existing-002', name: 'kouji \\(kari\\)', p: 'preview-b' },
      { id: 'duplicate-existing-003', name: 'ebifurya', p: 'preview-c' }
    ],
    promptLines: [
      'kouji \\(campus life\\)\tkouji (campus life)',
      'kouji \\(kari\\)\tkouji (kari)',
      'ebifurya\tebifurya'
    ],
    existingStyles: [
      { id: 10, source_id: 'existing-kouji', name: 'kouji', aliases_json: '["campus life"]', prompt_text: 'kouji (campus life)' },
      { id: 20, source_id: 'existing-ebifurya-a', name: 'ebifurya', aliases_json: '[]', prompt_text: 'ebifurya' },
      { id: 21, source_id: 'existing-ebifurya-b', name: 'ebifurya', aliases_json: '[]', prompt_text: 'ebifurya' }
    ],
    sourceBaseUrl: SOURCE_BASE_URL,
    sourceUrl: SOURCE_URL,
    now: NOW
  }), /same Style identity|same base model|multiple source records/u);
});

test('uses an exact prompt match to disambiguate same-name existing Styles and rejects unresolved prompt conflicts', async () => {
  const exactPromptAdapter = createIllustriousNoobaiStyleExplorerAdapter({
    galleryData: [{ id: 'prompt-discriminator-001', name: 'Prompt Discriminator', p: 'preview-a' }],
    promptLines: ['Prompt Discriminator\tpreferred prompt'],
    existingStyles: [
      { id: 30, source_id: 'prompt-discriminator-a', name: 'Prompt Discriminator', aliases_json: '[]', prompt_text: 'other prompt' },
      { id: 31, source_id: 'prompt-discriminator-b', name: 'Prompt Discriminator', aliases_json: '[]', prompt_text: 'preferred prompt' }
    ],
    sourceBaseUrl: SOURCE_BASE_URL,
    sourceUrl: SOURCE_URL,
    now: NOW
  });
  assert.equal((await exactPromptAdapter.discoverCatalog())[0].identity.normalized_name, 'Prompt Discriminator');

  assert.throws(() => createIllustriousNoobaiStyleExplorerStyleAdapterForRepeatedPrompt(), /same Style identity|multiple source records/u);

  assert.throws(() => createIllustriousNoobaiStyleExplorerStyleAdapterForTest(), /multiple existing Style rows/u);

  function createIllustriousNoobaiStyleExplorerStyleAdapterForTest() {
    return createIllustriousNoobaiStyleExplorerAdapter({
      galleryData: [{ id: 'prompt-conflict-001', name: 'Prompt Conflict', p: 'preview-a' }],
      promptLines: ['Prompt Conflict\tunmatched prompt'],
      existingStyles: [
        { id: 40, source_id: 'prompt-conflict-a', name: 'Prompt Conflict', aliases_json: '[]', prompt_text: 'first prompt' },
        { id: 41, source_id: 'prompt-conflict-b', name: 'Prompt Conflict', aliases_json: '[]', prompt_text: 'second prompt' }
      ],
      sourceBaseUrl: SOURCE_BASE_URL,
      sourceUrl: SOURCE_URL,
      now: NOW
    });
  }

  function createIllustriousNoobaiStyleExplorerStyleAdapterForRepeatedPrompt() {
    return createIllustriousNoobaiStyleExplorerAdapter({
      galleryData: [
        { id: 'repeated-prompt-001', name: 'goma \\(campus life\\)', p: 'preview-a' },
        { id: 'repeated-prompt-002', name: 'goma \\(kari\\)', p: 'preview-b' }
      ],
      promptLines: [
        'goma \\(campus life\\)\tgoma (campus life)',
        'goma \\(kari\\)\tgoma (kari)'
      ],
      existingStyles: [
        { id: 50, source_id: 'repeated-prompt-a', name: 'goma', aliases_json: '[]', prompt_text: 'goma (campus life)' },
        { id: 51, source_id: 'repeated-prompt-b', name: 'goma', aliases_json: '[]', prompt_text: 'goma (kari)' }
      ],
      sourceBaseUrl: SOURCE_BASE_URL,
      sourceUrl: SOURCE_URL,
      now: NOW
    });
  }
});

test('rejects duplicate galleryData ids before a runner can write any Style rows', (t) => {
  const root = tempRoot(t);
  const database = openCatalogDatabase();
  try {
    const duplicateIdSource = SOURCE_TEXT.replace("id: 'style-normalized-003'", "id: 'style-exact-001'");
    assert.throws(() => createIllustriousNoobaiStyleExplorerAdapter({ sourceText: duplicateIdSource, sourceBaseUrl: SOURCE_BASE_URL, sourceUrl: SOURCE_URL, now: NOW }), /galleryData.*id|duplicate.*id/u);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, 0);
    assert.equal(root.includes('issue-111-style-explorer-'), true);
  } finally {
    database.close();
  }
});

test('emits only crawler-contract catalog and Style detail fields and never uses artist prompt strings', async () => {
  const adapter = createAdapter({ request: async (url) => ({ url, status: 200, bytes: IMAGE_BYTES, media_type: 'image/png' }) });
  const catalog = await adapter.discoverCatalog();
  assert.equal(adapter.kind, 'illustrious-noobai-style-explorer');
  assert.deepEqual(adapter.sourceConfig, {
    schema_version: 1,
    source_name: 'illustrious-noobai-style-explorer',
    source_base_url: SOURCE_BASE_URL
  });
  for (const entry of catalog) {
    assert.deepEqual(validateJsonSample(entry, resolve(ROOT, 'schema/crawler/catalog-entry.schema.json'), CONTRACTS.schemas), []);
    assert.equal(Object.hasOwn(entry, 'aliases'), false);
    assert.equal(entry.identity.kind, 'style');
    assert.equal(entry.identity.parent_identity, 'root');
    assert.equal(entry.identity.base_model_id, BASE_MODEL_ID);
  }

  const detail = await adapter.fetchDetail({ identity: catalog[1].identity });
  assert.deepEqual(validateJsonSample(detail, resolve(ROOT, 'schema/crawler/detail-result.schema.json'), CONTRACTS.schemas), []);
  assert.doesNotThrow(() => assertCrawlerCrossObjectConsistency(detail));
  assert.equal(detail.prompt_text, 'full original prompt line 1: preserve every token, punctuation, and spacing.');
  assert.equal(Object.hasOwn(detail, 'preview_index'), false);
  assert.equal(detail.base_model_id, BASE_MODEL_ID);
  assert.equal(detail.style_description, null);
  assert.equal(Object.hasOwn(detail, 'category_name'), false);
  assert.equal(Object.hasOwn(adapter, 'persistStyles'), false);
  assert.equal(Object.hasOwn(adapter, 'importStyles'), false);
});

test('does not read artist prompt string inputs', () => {
  const options = new Proxy({ sourceText: SOURCE_TEXT, sourceBaseUrl: SOURCE_BASE_URL, sourceUrl: SOURCE_URL, now: NOW, artist_prompt_strings: [] }, {
    get(target, property, receiver) {
      if (property === 'artist_prompt_strings') throw new Error('artist_prompt_strings must remain untouched');
      return Reflect.get(target, property, receiver);
    }
  });
  assert.doesNotThrow(() => createIllustriousNoobaiStyleExplorerAdapter(options));
});

test('reuses existing canonical Style identity, merges normalized aliases without its canonical name, and preserves existing prompt text', async () => {
  const adapter = createAdapter({
    existingStyles: [
      { source_id: 'existing-exact', name: 'Exact Source Name', aliases_json: '["old exact alias","EXACT SOURCE NAME"]', prompt_text: 'full original prompt line 0: preserve commas, weights:1.25, and trailing source text.' },
      { source_id: 'existing-alias', name: 'Existing Alias Owner', aliases_json: '["source alias"]', prompt_text: 'full original prompt line 1: preserve every token, punctuation, and spacing.' }
    ]
  });
  const catalog = await adapter.discoverCatalog();
  const exact = await adapter.fetchDetail({ identity: catalog[0].identity });
  const alias = await adapter.fetchDetail({ identity: catalog[1].identity });
  assert.deepEqual(exact.identity, { kind: 'style', base_model_id: BASE_MODEL_ID, parent_identity: 'root', normalized_name: 'Exact Source Name' });
  assert.deepEqual(exact.aliases, ['old exact alias']);
  assert.deepEqual(alias.identity, { kind: 'style', base_model_id: BASE_MODEL_ID, parent_identity: 'root', normalized_name: 'Existing Alias Owner' });
  assert.deepEqual(alias.aliases, ['source alias', 'Alias Source Name', 'New Alias']);
  const preservedPromptAdapter = createAdapter({
    existingStyles: [{ source_id: 'existing-exact', name: 'Exact Source Name', aliases_json: '[]', prompt_text: 'different prompt' }]
  });
  const preservedPromptCatalog = await preservedPromptAdapter.discoverCatalog();
  const preservedPromptDetail = await preservedPromptAdapter.fetchDetail({ identity: preservedPromptCatalog[0].identity });
  assert.equal(preservedPromptDetail.prompt_text, 'different prompt');
  assert.throws(() => createAdapter({
    existingStyles: [
      { source_id: 'existing-alias-a', name: 'Other Existing Style A', aliases_json: '["source alias"]', prompt_text: 'different prompt A' },
      { source_id: 'existing-alias-b', name: 'Other Existing Style B', aliases_json: '["source alias"]', prompt_text: 'a different prompt' }
    ]
  }), /multiple existing Style rows/u);
});

test('preserves existing Style metadata through runner synchronization and merges only aliases', async (t) => {
  const root = tempRoot(t);
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const database = openCatalogDatabase();
  const existing = {
    id: 902,
    base_model_id: BASE_MODEL_ID,
    name: 'Existing Alias Owner',
    aliases_json: '["source alias","existing alias"]',
    style_description: '已确认的既有画风说明。',
    prompt_text: 'full original prompt line 1: preserve every token, punctuation, and spacing.',
    cover_media_path: null
  };
  insertStyleFixture(database, existing);
  try {
    const adapter = createAdapter({
      existingStyles: [existing],
      request: async (url) => ({ url, status: 200, content_type: 'image/png', bytes: IMAGE_BYTES })
    });
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const result = await createManualIngestRunner({ dataRoot, mediaRoot, sourceConfig: adapter.sourceConfig, adapter, database, config: CRAWL_CONFIG, vectorConfiguration: VECTOR_CONFIGURATION, modelClient: MODEL_CLIENT, now: NOW }).run();
    assert.equal(result.state.status, 'completed');
    assert.equal(result.report.counts.created, 3);
    const persisted = { ...database.prepare(`SELECT id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
      FROM styles WHERE id = ?`).get(existing.id) };
    assert.deepEqual(persisted, {
      ...existing,
      aliases_json: '["source alias","existing alias","Alias Source Name","New Alias"]'
    });
  } finally {
    database.close();
  }
});

test('keeps an unchanged matching Style as a duplicate without a vector write', async (t) => {
  const root = tempRoot(t);
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const database = openCatalogDatabase();
  const existing = {
    id: 904,
    base_model_id: BASE_MODEL_ID,
    name: 'Exact Source Name',
    aliases_json: '[]',
    style_description: null,
    prompt_text: 'full original prompt line 0: preserve commas, weights:1.25, and trailing source text.',
    cover_media_path: null
  };
  insertStyleFixture(database, existing);
  try {
    const adapter = createAdapter({ existingStyles: [existing] });
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const result = await createManualIngestRunner({ dataRoot, mediaRoot, sourceConfig: adapter.sourceConfig, adapter, database, config: CRAWL_CONFIG, vectorConfiguration: VECTOR_CONFIGURATION, modelClient: MODEL_CLIENT, now: NOW }).run();
    assert.equal(result.state.status, 'completed');
    assert.equal(result.report.counts.duplicates, 1);
    assert.equal(createCatalogRepository(database).listPublicCatalog({ kind: 'style', query: '', workId: null, limit: 100, cursor: null }).items.some((style) => style.id === existing.id), true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style' AND object_id = ?").get(existing.id).count, 0);
  } finally {
    database.close();
  }
});

test('merges aliases into an existing matching Style and writes its synchronized vector', async (t) => {
  const root = tempRoot(t);
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const database = openCatalogDatabase();
  const existing = {
    id: 905,
    base_model_id: BASE_MODEL_ID,
    name: 'Existing Alias Owner',
    aliases_json: '["source alias"]',
    style_description: 'existing description',
    prompt_text: 'full original prompt line 1: preserve every token, punctuation, and spacing.',
    cover_media_path: null
  };
  insertStyleFixture(database, existing);
  try {
    const adapter = createAdapter({ existingStyles: [existing] });
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const result = await createManualIngestRunner({ dataRoot, mediaRoot, sourceConfig: adapter.sourceConfig, adapter, database, config: CRAWL_CONFIG, vectorConfiguration: VECTOR_CONFIGURATION, modelClient: MODEL_CLIENT, now: NOW }).run();
    assert.equal(result.state.status, 'completed');
    assert.equal(result.report.counts.updated, 1);
    assert.deepEqual(
      { ...database.prepare('SELECT aliases_json, style_description FROM styles WHERE id = ?').get(existing.id) },
      { aliases_json: '["source alias","Alias Source Name","New Alias"]', style_description: 'existing description' }
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style' AND object_id = ?").get(existing.id).count, 1);
  } finally {
    database.close();
  }
});

test('reuses an existing Style by base-model identity and preserves its description', async (t) => {
  const root = tempRoot(t);
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const database = openCatalogDatabase();
  const existing = {
    id: 903,
    base_model_id: BASE_MODEL_ID,
    name: 'Existing Alias Owner',
    aliases_json: '["source alias"]',
    style_description: '原有说明必须保留。',
    prompt_text: 'full original prompt line 1: preserve every token, punctuation, and spacing.',
    cover_media_path: null
  };
  insertStyleFixture(database, existing);
  try {
    const adapter = createAdapter({ existingStyles: [existing] });
    const catalog = await adapter.discoverCatalog();
    const matchedCatalog = catalog.find(({ name }) => name === existing.name);
    const detail = await adapter.fetchDetail({ identity: matchedCatalog.identity });
    assert.deepEqual(detail.identity, { kind: 'style', base_model_id: BASE_MODEL_ID, parent_identity: 'root', normalized_name: existing.name });
    assert.equal(detail.source_url, SOURCE_URL);
    assert.equal(Object.hasOwn(detail, 'extensions'), false);
    assert.deepEqual(validateJsonSample(detail, resolve(ROOT, 'schema/crawler/detail-result.schema.json'), CONTRACTS.schemas), []);

    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const result = await createManualIngestRunner({ dataRoot, mediaRoot, sourceConfig: adapter.sourceConfig, adapter, database, config: CRAWL_CONFIG, vectorConfiguration: VECTOR_CONFIGURATION, modelClient: MODEL_CLIENT, now: NOW }).run();
    assert.equal(result.state.status, 'completed');
    const persisted = { ...database.prepare(`SELECT id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
      FROM styles WHERE id = ?`).get(existing.id) };
    assert.deepEqual(persisted, {
      ...existing,
      aliases_json: '["source alias","Alias Source Name","New Alias"]'
    });
  } finally {
    database.close();
  }
});

test('imports Style details without the removed source-metadata policy', async (t) => {
  const root = tempRoot(t);
  const mediaRoot = join(root, 'media');
  const existing = {
    base_model_id: BASE_MODEL_ID,
    name: 'Existing Alias Owner',
    aliases_json: '["source alias"]',
    style_description: '既有说明。',
    prompt_text: 'full original prompt line 1: preserve every token, punctuation, and spacing.',
    cover_media_path: null
  };
  const importWithoutLegacyPolicy = async () => {
    const database = openCatalogDatabase();
    try {
      insertStyleFixture(database, existing);
      const adapter = createAdapter({ existingStyles: [existing] });
      const catalog = await adapter.discoverCatalog();
      const detail = await adapter.fetchDetail({ identity: catalog.find(({ name }) => name === existing.name).identity });
      detail.extensions = {
        preserve_existing_metadata: true,
        existing_row_metadata: { adapter_kind: 'illustrious-noobai-style-explorer' }
      };
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
      await createCatalogImporter({ database, mediaRoot, now: NOW, modelClient: MODEL_CLIENT, configuration: VECTOR_CONFIGURATION }).importDetail(detail);
      return { ...database.prepare(`SELECT base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path FROM styles WHERE base_model_id = ? AND name = ?`).get(BASE_MODEL_ID, existing.name) };
    } finally {
      database.close();
    }
  };

  assert.deepEqual(await importWithoutLegacyPolicy(), {
    base_model_id: BASE_MODEL_ID,
    name: existing.name,
    aliases_json: '["source alias","Alias Source Name","New Alias"]',
    prompt_text: existing.prompt_text,
    style_description: existing.style_description,
    cover_media_path: null
  });
});

test('keeps the default Style description update policy for non-Explorer manual adapters', async (t) => {
  const root = tempRoot(t);
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const database = openCatalogDatabase();
  const identity = { kind: 'style', base_model_id: BASE_MODEL_ID, parent_identity: 'root', normalized_name: 'Fixed Runner Style' };
  const existing = {
    base_model_id: BASE_MODEL_ID,
    name: 'Fixed Runner Style',
    aliases_json: '[]',
    prompt_text: 'fixed runner prompt',
    style_description: 'existing description',
    cover_media_path: null
  };
  const detail = {
    identity,
    base_model_id: BASE_MODEL_ID,
    source_url: 'https://styles.example.test/fixed-runner-style',
    name: 'Fixed Runner Style',
    aliases: [],
    style_description: 'incoming description',
    prompt_text: 'fixed runner prompt',
    image_results: [],
    fetched_at: NOW().toISOString()
  };
  insertStyleFixture(database, existing);
  const adapter = {
    kind: 'fixed-local',
    sourceConfig: { schema_version: 1, source_name: 'fixed-runner-style', source_base_url: SOURCE_BASE_URL },
    async discoverCatalog() { return [{ identity, source_url: detail.source_url, name: detail.name, discovered_at: NOW().toISOString() }]; },
    async fetchDetail() { return { ...detail }; },
    async downloadImages(incoming) { return incoming; }
  };
  try {
      database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const result = await createManualIngestRunner({ dataRoot, mediaRoot, sourceConfig: adapter.sourceConfig, adapter, database, config: CRAWL_CONFIG, vectorConfiguration: VECTOR_CONFIGURATION, modelClient: MODEL_CLIENT, now: NOW }).run();
    assert.equal(result.state.status, 'completed');
    assert.deepEqual(
      { ...database.prepare('SELECT base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path FROM styles WHERE base_model_id = ? AND name = ?').get(BASE_MODEL_ID, detail.name) },
      {
        base_model_id: BASE_MODEL_ID,
        name: detail.name,
        aliases_json: '[]',
        prompt_text: detail.prompt_text,
        style_description: detail.style_description,
        cover_media_path: null
      }
    );
  } finally {
    database.close();
  }
});

test('imports Style details through the existing manual runner and catalog importer', async (t) => {
  const root = tempRoot(t);
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const database = openCatalogDatabase();
  const adapter = createAdapter({ request: async (url) => ({ url, status: 200, content_type: 'image/png', bytes: IMAGE_BYTES }) });
  try {
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const runner = createManualIngestRunner({ dataRoot, mediaRoot, sourceConfig: adapter.sourceConfig, adapter, database, config: CRAWL_CONFIG, vectorConfiguration: VECTOR_CONFIGURATION, modelClient: MODEL_CLIENT, now: NOW });
    const result = await runner.run();
    assert.equal(result.state.status, 'completed');
    assert.equal(result.report.counts.created, 4);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, 4);
    assert.equal(database.prepare("SELECT prompt_text FROM styles WHERE name = 'Exact Source Name'").get().prompt_text, 'full original prompt line 0: preserve commas, weights:1.25, and trailing source text.');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style'").get().count, 4);

    const selected = await adapter.fetchSelectedPreview({ identity: (await adapter.discoverCatalog())[0].identity, preview_index: 1 });
    const downloaded = await adapter.downloadImages(selected);
    const schemaDetail = removeDownloadedBytes(downloaded);
    assert.deepEqual(validateJsonSample(schemaDetail, resolve(ROOT, 'schema/crawler/detail-result.schema.json'), CONTRACTS.schemas), []);
    assert.deepEqual(validateJsonSample(schemaDetail.image_results[0], resolve(ROOT, 'schema/crawler/image-result.schema.json'), CONTRACTS.schemas), []);
    assert.doesNotThrow(() => assertCrawlerCrossObjectConsistency(schemaDetail));
    assert.equal(downloaded.image_results[0].content_hash, createHash('sha256').update(IMAGE_BYTES).digest('hex'));
    assert.equal(downloaded.image_results[0].media_type, 'image/png');
    assert.equal(downloaded.image_results[0].source_url, previewUrl('style-exact-001', 'exact-preview-b'));

    const files = downloaded.image_results.map(({ source_url, bytes, media_type }) => ({ source_url, bytes, media_type }));
    const imported = await createCatalogImporter({ database, mediaRoot, now: NOW, modelClient: MODEL_CLIENT, configuration: VECTOR_CONFIGURATION }).importDetail(schemaDetail, files);
    assert.equal(imported.action, 'duplicate');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = 'style'").get().count, 1);
  } finally {
    database.close();
  }
});

test('keeps maximum safe preview identifiers schema-valid with a bounded deterministic image source id', async () => {
  const maximumId = `a${'a'.repeat(255)}`;
  const maximumReference = `b${'b'.repeat(255)}`;
  const adapter = createAdapter({
    sourceText: undefined,
    galleryData: [{ id: maximumId, name: 'Maximum Preview Style', p: [maximumReference] }],
    promptLines: ['Maximum Preview Style\tmaximum preview prompt'],
    request: async (url) => ({ url, status: 200, content_type: 'image/png', bytes: IMAGE_BYTES })
  });
  const [catalog] = await adapter.discoverCatalog();
  const first = await adapter.downloadImages(await adapter.fetchSelectedPreview({ identity: catalog.identity, preview_index: 0 }));
  const second = await adapter.downloadImages(await adapter.fetchSelectedPreview({ identity: catalog.identity, preview_index: 0 }));
  const schemaDetail = removeDownloadedBytes(first);
  assert.equal(first.identity.base_model_id, BASE_MODEL_ID);
  assert.equal(first.identity.normalized_name, 'Maximum Preview Style');
  assert.equal(first.image_results[0].source_id.length <= 256, true);
  assert.equal(first.image_results[0].source_id, second.image_results[0].source_id);
  assert.deepEqual(validateJsonSample(schemaDetail, resolve(ROOT, 'schema/crawler/detail-result.schema.json'), CONTRACTS.schemas), []);
  assert.deepEqual(validateJsonSample(schemaDetail.image_results[0], resolve(ROOT, 'schema/crawler/image-result.schema.json'), CONTRACTS.schemas), []);
});

test('downloads at most one selected preview through the injected transport and rejects unsafe paths, redirects, text, and mismatched media', async () => {
  const calls = [];
  const adapter = createAdapter({
    request: async (url) => {
      calls.push(url);
      return { url, status: 200, content_type: 'image/png', bytes: IMAGE_BYTES };
    }
  });
  const catalog = await adapter.discoverCatalog();
  const initial = await adapter.fetchDetail({ identity: catalog[0].identity });
  assert.deepEqual((await adapter.downloadImages(initial)).image_results, []);

  const selected = await adapter.fetchSelectedPreview({ identity: catalog[0].identity, preview_index: 1 });
  const downloaded = await adapter.downloadImages(selected);
  assert.equal(downloaded.image_results.length, 1);
  assert.deepEqual(calls, [previewUrl('style-exact-001', 'exact-preview-b')]);

  for (const response of [
    { url: previewUrl('style-exact-001', 'exact-preview-a'), content_type: 'image/png', bytes: IMAGE_BYTES },
    { url: previewUrl('style-exact-001', 'exact-preview-a'), status: 200.5, content_type: 'image/png', bytes: IMAGE_BYTES },
    { url: previewUrl('style-exact-001', 'exact-preview-a'), status: 302, content_type: 'image/png', bytes: IMAGE_BYTES },
    { url: previewUrl('style-exact-001', 'exact-preview-a'), status: 200, content_type: 'text/html', bytes: Buffer.from('<html>no</html>') },
    { url: previewUrl('style-exact-001', 'exact-preview-a'), status: 200, content_type: 'image/jpeg', bytes: IMAGE_BYTES },
    { url: previewUrl('style-exact-001', 'exact-preview-a'), status: 200, content_type: 'image/webp', bytes: IMAGE_BYTES },
    { url: 'https://redirect.example.test/preview.png', status: 200, redirected: true, content_type: 'image/png', bytes: IMAGE_BYTES },
    { url: previewUrl('style-exact-001', 'exact-preview-a'), status: 200, content_type: 'image/png', bytes: new Uint8Array(IMAGE_BYTES) }
  ]) {
    const unsafe = createAdapter({ request: async () => response });
    const unsafeCatalog = await unsafe.discoverCatalog();
    const unsafeDetail = await unsafe.fetchSelectedPreview({ identity: unsafeCatalog[0].identity, preview_index: 0 });
    await assert.rejects(() => unsafe.downloadImages(unsafeDetail), /preview|image|redirect|bytes|media|status|content/u);
  }
  assert.throws(() => createIllustriousNoobaiStyleExplorerAdapter({
    sourceText: SOURCE_TEXT.replace("id: 'style-exact-001'", "id: '../style-exact-001'"),
    sourceBaseUrl: SOURCE_BASE_URL,
    sourceUrl: SOURCE_URL,
    now: NOW
  }), /id|path|safe/u);
  assert.throws(() => createIllustriousNoobaiStyleExplorerAdapter({
    sourceText: SOURCE_TEXT.replace("'exact-preview-a'", "'../exact-preview-a'"),
    sourceBaseUrl: SOURCE_BASE_URL,
    sourceUrl: SOURCE_URL,
    now: NOW
  }), /preview|path|safe/u);
  assert.equal(existsSync(join(FIXTURE_DIR, 'preview.png')), true);
});

test('attributes a rejected preview transport request to an image failure in the runner report', async (t) => {
  const root = tempRoot(t);
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const database = openCatalogDatabase();
  const adapter = createAdapter({
    sourceText: undefined,
    galleryData: [{ id: 'transport-reject-001', name: 'Transport Reject Style', p: ['preview-a'] }],
    promptLines: ['Transport Reject Style\ttransport reject prompt'],
    autoDownloadAllPreviews: true,
    request: async () => { throw new Error('offline preview transport'); }
  });
  try {
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const result = await createManualIngestRunner({
      dataRoot,
      mediaRoot,
      sourceConfig: adapter.sourceConfig,
      adapter,
      database,
      config: CRAWL_CONFIG,
      vectorConfiguration: VECTOR_CONFIGURATION,
      modelClient: MODEL_CLIENT,
      now: NOW
    }).run();
    assert.equal(result.report.counts.images_failed, 1);
    assert.equal(result.report.errors.length, 1);
    assert.equal(result.report.errors[0].scope, 'image');
    assert.equal(result.report.errors[0].code, 'IMAGE_DOWNLOAD_FAILED');
    assert.equal(result.report.errors[0].image_source_url, previewUrl('transport-reject-001', 'preview-a'));
  } finally {
    database.close();
  }
});
