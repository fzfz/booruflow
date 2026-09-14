import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import {
  createCatalogImporter,
  createStyleDescriptionBatchImporter
} from '../../app/ingest/manual-ingest.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-08-03T00:00:00.000Z';
const STYLE_BASE_MODEL_ID = 11101;
const configuration = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });
const modelClient = Object.freeze({ async embed(inputs) { return inputs.map(() => createFixtureVector()); } });

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'noobai-issue-111-style-description-'));
  const mediaRoot = join(root, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  const database = openCatalogDatabase();
  database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, 'wai', ?, ?)").run(STYLE_BASE_MODEL_ID, NOW, NOW);
  database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
  const catalogImporter = createCatalogImporter({ database, mediaRoot, now: () => new Date(NOW), modelClient, configuration });
  const calls = [];
  const tracedCatalogImporter = Object.freeze({
    async importDetail(detail, downloadedFiles, options) {
      calls.push(structuredClone(detail));
      return catalogImporter.importDetail(detail, downloadedFiles, options);
    },
    async prepareStyleVector(detail) {
      return catalogImporter.prepareStyleVector(detail);
    }
  });
  const importer = createStyleDescriptionBatchImporter({
    database,
    catalogImporter: tracedCatalogImporter,
    baseModelId: STYLE_BASE_MODEL_ID,
    now: () => new Date(NOW)
  });
  return { root, database, importer, calls };
}

function closeFixture(value) {
  value.database.close();
  rmSync(value.root, { recursive: true, force: true });
}

function insertStyle(database, {
  id,
  name,
  aliases = [],
  styleDescription = null,
  promptText
}) {
  assert.equal(typeof promptText, 'string');
  assert.notEqual(promptText, '');
  database.prepare(`INSERT INTO styles(
    id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
  ) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
    .run(id, STYLE_BASE_MODEL_ID, name, JSON.stringify(aliases), promptText, styleDescription);
}

function makeCatalogStyleDetail({ name, aliases = [], promptText, styleDescription, omitStyleDescription = false }) {
  const detail = {
    identity: { kind: 'style', base_model_id: STYLE_BASE_MODEL_ID, parent_identity: 'root', normalized_name: name },
    base_model_id: STYLE_BASE_MODEL_ID,
    source_url: null,
    name,
    aliases,
    prompt_text: promptText,
    style_description: styleDescription,
    image_results: []
  };
  if (omitStyleDescription) delete detail.style_description;
  return detail;
}


test('createStyleDescriptionBatchImporter.importRecords fills an existing empty style_description and writes exactly one Style vector', async () => {
  const fixture = makeFixture();
  try {
    insertStyle(fixture.database, {
      id: 22002,
      name: 'empty description style',
      aliases: [],
      styleDescription: null,
      promptText: 'manual-empty-description-prompt'
    });
    const incoming = {
      name: 'empty description style',
      aliases: ['empty-description-alias'],
      prompt_text: 'manual-empty-description-prompt',
      style_description: '这是一条人工确认的非空画风描述。'
    };

    await fixture.importer.importRecords([incoming]);

    assert.deepEqual({ ...fixture.database.prepare('SELECT id, aliases_json, style_description, prompt_text FROM styles').get() }, {
      id: 22002,
      aliases_json: '["empty-description-alias"]',
      style_description: incoming.style_description,
      prompt_text: incoming.prompt_text
    });
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style' AND object_id = 22002").get().count, 1);
  } finally {
    closeFixture(fixture);
  }
});

test('createStyleDescriptionBatchImporter.importRecords treats a whitespace-only existing description as empty', async () => {
  const fixture = makeFixture();
  try {
    insertStyle(fixture.database, {
      id: 22004,
      name: 'whitespace description style',
      aliases: [],
      styleDescription: ' \t ',
      promptText: 'manual-whitespace-description-prompt'
    });

    await fixture.importer.importRecords([{
      name: 'whitespace description style',
      aliases: [],
      prompt_text: 'manual-whitespace-description-prompt',
      style_description: '空白描述被人工确认文本替换。'
    }]);

    assert.equal(
      fixture.database.prepare('SELECT style_description FROM styles WHERE id = 22004').get().style_description,
      '空白描述被人工确认文本替换。'
    );
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style' AND object_id = 22004").get().count, 1);
  } finally {
    closeFixture(fixture);
  }
});

test('createStyleDescriptionBatchImporter.importRecords rolls back an existing empty-description update when vector insertion fails', async () => {
  const fixture = makeFixture();
  try {
    insertStyle(fixture.database, {
      id: 22003,
      name: 'rollback empty description style',
      aliases: ['original-alias'],
      styleDescription: null,
      promptText: 'manual-rollback-empty-prompt'
    });
    const styleRowBefore = fixture.database.prepare('SELECT * FROM styles WHERE id = ?').get(22003);
    fixture.database.exec(`CREATE TRIGGER issue111_fail_existing_style_after_description
      BEFORE INSERT ON vector_entries
      WHEN NEW.object_kind = 'style'
       AND NEW.object_id = 22003
       AND EXISTS (SELECT 1 FROM styles
         WHERE id = 22003
           AND style_description = 'rollback description must not persist'
           AND EXISTS (SELECT 1 FROM json_each(styles.aliases_json) WHERE value = 'rollback-alias'))
      BEGIN
        SELECT RAISE(ABORT, 'issue-111 forced existing-style vector failure');
      END`);
    await assert.rejects(() => fixture.importer.importRecords([{
      name: 'rollback empty description style',
      aliases: ['rollback-alias'],
      prompt_text: 'manual-rollback-empty-prompt',
      style_description: 'rollback description must not persist'
    }]), /issue-111 forced existing-style vector failure/u);

    assert.deepEqual(fixture.database.prepare('SELECT * FROM styles WHERE id = ?').get(22003), styleRowBefore);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style' AND object_id = 22003").get().count, 0);
  } finally {
    closeFixture(fixture);
  }
});

test('createStyleDescriptionBatchImporter.resolveRecords rejects distinct raw description concatenation and illegal confirmations before import', () => {
  const fixture = makeFixture();
  try {
    const [rawA, rawB, rawC] = [
      '极致逆光、丁达尔空气感、通透、细碎光斑、高明度高纯度、粉嫩肤色、大景深广角透视、纤细少女、治愈梦幻。',
      '果冻通透肉感、汗水油脂湿润光泽、糖果色、柔焦、肢体挤压勒痕、粉色关节、红晕水光瞳、软糯弹性。',
      '冷暖对比、环境色阴影、强逆光Bokeh、几何高光瞳、渐变发梢、水体丝绸金属质感、碎片化装饰、漂浮动态、华丽商业感。'
    ];
    const rawRecords = [
      { name: 'direct concat sample', aliases: [], prompt_text: 'manual-direct-concat-prompt', style_description: rawA },
      { name: 'direct concat sample', aliases: [], prompt_text: 'manual-direct-concat-prompt', style_description: rawB },
      { name: 'direct concat sample', aliases: [], prompt_text: 'manual-direct-concat-prompt', style_description: rawC }
    ];
    const illegalConfirmations = [
      `${rawA}${rawB}`,
      `${rawA}\n${rawB}`,
      `${rawB}${rawA}`,
      `${rawB}\n${rawA}`,
      `${rawA}；${rawB}；${rawC}`,
      `${rawC}；${rawB}；${rawA}`,
      `${rawA}、${rawB}、${rawC}`,
      `${rawC}、${rawB}、${rawA}`,
      `${rawA}。${rawB}。${rawC}`,
      `${rawC}。${rawB}。${rawA}`,
      rawA
    ];
    for (const merged_style_description of illegalConfirmations) {
      assert.throws(
        () => fixture.importer.resolveRecords(rawRecords, { confirmationsByName: { 'direct concat sample': { merged_style_description } } }),
        /confirmation|merged_style_description|duplicate/u,
        `非法 confirmation ${JSON.stringify(merged_style_description)} 必须快速失败`
      );
    }
    const resolved = fixture.importer.resolveRecords(rawRecords, {
      confirmationsByName: {
        'direct concat sample': { merged_style_description: '人工合并确认：逆光空气感、湿润果冻质感与冷暖几何光影互补保留。' }
      }
    });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].style_description, '人工合并确认：逆光空气感、湿润果冻质感与冷暖几何光影互补保留。');
  } finally {
    closeFixture(fixture);
  }
});

test('createStyleDescriptionBatchImporter resolves name-to-alias and alias-to-alias cross-duplicates in either order only with explicit confirmation, without writes on missing confirmation', async () => {
  const scenarios = [
    {
      label: 'name-to-alias',
      records: [
        { name: 'name anchor', aliases: ['name-side-extra'], prompt_text: 'manual-cross-name-prompt', style_description: 'name-side raw A' },
        { name: 'other name', aliases: ['name anchor'], prompt_text: 'manual-cross-name-prompt', style_description: 'name-side raw B' }
      ],
      confirmation: '人工合并确认：name-to-alias 记录保留冷色、玻璃质感与柔和边缘。',
      existing: { id: 23001, name: 'existing alias target', aliases: ['name anchor'], promptText: 'manual-cross-name-prompt' },
      expectedAliases: ['name anchor', 'name-side-extra']
    },
    {
      label: 'alias-to-alias',
      records: [
        { name: 'alias source A', aliases: ['shared cross alias'], prompt_text: 'manual-cross-alias-prompt', style_description: 'alias-side raw A' },
        { name: 'alias source B', aliases: ['shared cross alias'], prompt_text: 'manual-cross-alias-prompt', style_description: 'alias-side raw B' }
      ],
      confirmation: '人工合并确认：alias-to-alias 记录保留冷色、玻璃质感与柔和边缘。',
      existing: { id: 23002, name: 'existing shared alias target', aliases: ['shared cross alias'], promptText: 'manual-cross-alias-prompt' },
      expectedAliases: ['shared cross alias']
    }
  ];

  for (const scenario of scenarios) {
    for (const orderedRecords of [scenario.records, [...scenario.records].reverse()]) {
      const fixture = makeFixture();
      try {
        if (scenario.existing) insertStyle(fixture.database, { ...scenario.existing, styleDescription: null });
        const expectedStyleCount = scenario.existing ? 1 : 0;
        const existingRowBefore = fixture.database.prepare('SELECT * FROM styles WHERE id = ?').get(scenario.existing.id);
        assert.throws(
          () => fixture.importer.resolveRecords(orderedRecords, { confirmationsByName: {} }),
          /merged_style_description/u,
          `${scenario.label} ${orderedRecords[0].name} 正序/反序缺 confirmation 必须快速失败`
        );
        assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, expectedStyleCount);
        assert.deepEqual(fixture.database.prepare('SELECT * FROM styles WHERE id = ?').get(scenario.existing.id), existingRowBefore);
        assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style'").get().count, 0);

        const confirmationsByName = Object.fromEntries(scenario.records.map(({ name }) => [name, { merged_style_description: scenario.confirmation }]));
        const resolved = fixture.importer.resolveRecords(orderedRecords, { confirmationsByName });
        assert.equal(resolved.length, 1, `${scenario.label} 提供 confirmation 后必须折叠为一个 canonical record`);
        assert.equal(resolved[0].style_description, scenario.confirmation);
        await fixture.importer.importRecords(resolved);
        assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, 1);
        assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style'").get().count, 1);
        const row = fixture.database.prepare('SELECT id, aliases_json, style_description FROM styles').get();
        if (scenario.existing) {
          assert.equal(row.id, scenario.existing.id);
          assert.equal(row.style_description, scenario.confirmation);
          assert.deepEqual(JSON.parse(row.aliases_json), scenario.expectedAliases);
        } else {
          assert.equal(row.style_description, scenario.confirmation);
        }
      } finally {
        closeFixture(fixture);
      }
    }
  }
});

test('createCatalogImporter accepts null and undefined style_description as nullable, writes non-empty descriptions, rejects empty strings, and protects existing non-empty descriptions', async () => {
  const fixture = makeFixture();
  try {
    const catalogImporter = createCatalogImporter({ database: fixture.database, mediaRoot: join(fixture.root, 'media'), now: () => new Date(NOW), modelClient, configuration });
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared omitted description', promptText: 'manual-nullable-omitted-prompt', omitStyleDescription: true }));
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared undefined description', promptText: 'manual-nullable-undefined-prompt', styleDescription: undefined }));
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared null description', promptText: 'manual-nullable-null-prompt', styleDescription: null }));
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared non-empty description', promptText: 'manual-non-empty-description-prompt', styleDescription: '人工确认的非空描述。' }));
    assert.deepEqual(fixture.database.prepare(`SELECT name, style_description, prompt_text FROM styles
      WHERE lower(name) IN ('shared omitted description', 'shared undefined description', 'shared null description', 'shared non-empty description') ORDER BY lower(name)`).all().map((row) => ({ ...row })), [
      { name: 'shared non-empty description', style_description: '人工确认的非空描述。', prompt_text: 'manual-non-empty-description-prompt' },
      { name: 'shared null description', style_description: null, prompt_text: 'manual-nullable-null-prompt' },
      { name: 'shared omitted description', style_description: null, prompt_text: 'manual-nullable-omitted-prompt' },
      { name: 'shared undefined description', style_description: null, prompt_text: 'manual-nullable-undefined-prompt' }
    ]);

    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared omitted description', promptText: 'manual-nullable-omitted-prompt', styleDescription: '省略字段更新后的人工确认文本。' }));
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared undefined description', promptText: 'manual-nullable-undefined-prompt', styleDescription: undefined }));
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared null description', promptText: 'manual-nullable-null-prompt', styleDescription: null }));
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared null description', promptText: 'manual-nullable-null-prompt', styleDescription: '空描述更新后的人工确认文本。' }));
    const protectedRowBefore = fixture.database.prepare("SELECT * FROM styles WHERE lower(name) = 'shared non-empty description'").get();
    const vectorBeforeProtection = fixture.database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style'").get().count;
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared non-empty description', promptText: 'manual-non-empty-description-prompt', styleDescription: null }));
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared non-empty description', promptText: 'manual-non-empty-description-prompt', styleDescription: undefined }));
    await catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared non-empty description', promptText: 'manual-non-empty-description-prompt', omitStyleDescription: true }));
    assert.equal(fixture.database.prepare("SELECT style_description FROM styles WHERE lower(name) = 'shared null description'").get().style_description, '空描述更新后的人工确认文本。');
    assert.equal(fixture.database.prepare("SELECT style_description FROM styles WHERE lower(name) = 'shared omitted description'").get().style_description, '省略字段更新后的人工确认文本。');
    assert.equal(fixture.database.prepare("SELECT style_description FROM styles WHERE lower(name) = 'shared undefined description'").get().style_description, null);
    assert.equal(fixture.database.prepare("SELECT style_description FROM styles WHERE lower(name) = 'shared non-empty description'").get().style_description, '人工确认的非空描述。');
    assert.deepEqual(fixture.database.prepare("SELECT * FROM styles WHERE lower(name) = 'shared non-empty description'").get(), protectedRowBefore);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style'").get().count, vectorBeforeProtection);
    await assert.rejects(() => catalogImporter.importDetail(makeCatalogStyleDetail({ name: 'shared non-empty description', promptText: 'manual-non-empty-description-prompt', styleDescription: '' })), /style_description/u);
    assert.deepEqual(fixture.database.prepare("SELECT * FROM styles WHERE lower(name) = 'shared non-empty description'").get(), protectedRowBefore);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style'").get().count, vectorBeforeProtection);
  } finally {
    closeFixture(fixture);
  }
});

test('createStyleDescriptionBatchImporter.importRecords writes human-confirmed style_description verbatim, updates non-empty descriptions, fills empty descriptions, and preserves prompt_text', async () => {
  const fixture = makeFixture();
  try {
    insertStyle(fixture.database, { id: 11111, name: 'kantoku', styleDescription: '既有人工确认描述', promptText: 'kantoku original prompt' });
    insertStyle(fixture.database, { id: 11112, name: 'anmi', styleDescription: null, promptText: 'anmi original prompt' });
    const semanticRecord = {
      name: 'semantic sample',
      aliases: [],
      prompt_text: 'semantic sample',
      source_descriptions: ['细线稿、冷色、逆光。', '细线稿、冷色、玻璃质感。', '低饱和基调、高饱和强调色。'],
      style_description: '细线稿、冷色、逆光、玻璃质感、低饱和基调与高饱和强调色并存。'
    };

    await fixture.importer.importRecords([
      { name: 'kantoku', aliases: [], prompt_text: 'kantoku original prompt', source_descriptions: ['新批次描述、会被保护。'], style_description: '新批次描述、会被保护。' },
      { name: 'anmi', aliases: [], prompt_text: 'anmi original prompt', source_descriptions: ['逆光、软糯肉感。'], style_description: '逆光、软糯肉感。' },
      semanticRecord
    ]);

    assert.deepEqual(fixture.database.prepare(`SELECT name, style_description, prompt_text FROM styles
      WHERE lower(name) IN ('kantoku', 'anmi', 'semantic sample') ORDER BY lower(name)`).all().map((row) => ({ ...row })), [
      { name: 'anmi', style_description: '逆光、软糯肉感。', prompt_text: 'anmi original prompt' },
      { name: 'kantoku', style_description: '新批次描述、会被保护。', prompt_text: 'kantoku original prompt' },
      { name: 'semantic sample', style_description: semanticRecord.style_description, prompt_text: 'semantic sample' }
    ]);
  } finally {
    closeFixture(fixture);
  }
});

test('createStyleDescriptionBatchImporter.importRecords leaves name, alias, description, and vector absent when one record fails inside the catalog importer transaction', async () => {
  const fixture = makeFixture();
  try {
    const stylesBefore = fixture.database.prepare('SELECT * FROM styles ORDER BY id ASC').all().map((row) => ({ ...row }));
    const vectorsBefore = fixture.database.prepare('SELECT * FROM vector_entries ORDER BY object_kind, object_id').all().map((row) => ({ ...row }));
    fixture.database.exec(`CREATE TRIGGER issue111_fail_after_style_write
      BEFORE INSERT ON vector_entries
      WHEN NEW.object_kind = 'style'
       AND EXISTS (SELECT 1 FROM styles
         WHERE id = NEW.object_id
           AND lower(name) = 'transaction failure'
           AND style_description = 'must not persist'
           AND EXISTS (SELECT 1 FROM json_each(styles.aliases_json) WHERE value = 'failure-alias'))
      BEGIN
        SELECT RAISE(ABORT, 'issue-111 forced vector failure after style write');
      END`);
    await assert.rejects(() => fixture.importer.importRecords([
      { name: 'transaction failure', aliases: ['failure-alias'], prompt_text: 'transaction failure', style_description: 'must not persist' }
    ]), /issue-111 forced vector failure after style write/u);
    assert.deepEqual(fixture.database.prepare('SELECT * FROM styles ORDER BY id ASC').all().map((row) => ({ ...row })), stylesBefore);
    assert.deepEqual(fixture.database.prepare('SELECT * FROM vector_entries ORDER BY object_kind, object_id').all().map((row) => ({ ...row })), vectorsBefore);
    assert.equal(fixture.calls.length, 1, '失败记录必须先进入现有 catalog importer');
  } finally {
    closeFixture(fixture);
  }
});
