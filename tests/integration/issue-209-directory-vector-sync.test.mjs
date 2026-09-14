import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase as openRawCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogImporter, createStyleDescriptionBatchImporter } from '../../app/ingest/manual-ingest.mjs';
import { createMaintenanceService } from '../../app/maintenance/maintenance-service.mjs';
import { createMediaStorage } from '../../app/media/media-storage.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-08-05T00:00:00.000Z';
const configuration = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });
const STYLE_BASE_MODEL_ID = 20901;

function openCatalogDatabase() {
  const database = openRawCatalogDatabase();
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(STYLE_BASE_MODEL_ID, 'issue-209-wai', NOW, NOW);
  return database;
}

function detail(kind, name, extra = {}) {
  return {
    identity: { kind, source_id: null, parent_identity: 'root', ...(kind === 'style' ? { base_model_id: STYLE_BASE_MODEL_ID } : {}), ...(kind === 'character' ? { parent_work_identity: { kind: 'work', source_id: null, parent_identity: 'root', normalized_name: 'work one' } } : {}), normalized_name: name },
    source_url: null,
    source_version: null,
    source_updated_at: null,
    name,
    aliases: [],
    category_name: 'test',
    prompt_text: kind === 'work' ? null : `${name} prompt`,
    ...(kind === 'style' ? { base_model_id: STYLE_BASE_MODEL_ID } : {}),
    ...(kind === 'style' ? { style_description: `${name} description` } : {}),
    image_results: [],
    ...extra
  };
}

test('catalog import writes each business object and its vector in one awaited operation', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-209-import-'));
  const database = openCatalogDatabase();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const modelClient = { async embed(inputs) { return inputs.map(() => createFixtureVector()); } };
    const importer = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
    const work = await importer.importDetail(detail('work', 'work one'));
    assert.equal(work.action, 'created');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work' AND object_id = ?").get(work.id).count, 1);
    const character = await importer.importDetail(detail('character', 'character one'));
    const style = await importer.importDetail(detail('style', 'style one'));
    assert.deepEqual(database.prepare('SELECT object_kind, object_id FROM vector_entries ORDER BY object_kind').all().map((row) => ({ ...row })), [
      { object_kind: 'character', object_id: character.id },
      { object_kind: 'style', object_id: style.id },
      { object_kind: 'work', object_id: work.id }
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('fresh databases initialize each fixed vector space on the first successful directory write', async () => {
  for (const kind of DIRECTORY_VECTOR_KINDS) {
    const root = mkdtempSync(resolve(tmpdir(), `issue-209-fresh-${kind}-`));
    const database = openCatalogDatabase();
    try {
      const modelClient = { async embed(inputs) { return inputs.map(() => kind === 'work' ? createFixtureVector() : kind === 'character' ? createFixtureVector(0, 1) : kind === 'style' ? createFixtureVector(1, 1) : createFixtureVector(2, 0)); } };
      const importer = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
      if (kind === 'character') await importer.importDetail(detail('work', 'work one'));
      const result = await importer.importDetail(detail(kind, kind === 'work' ? 'work one' : `${kind} one`));
      const id = result.id;
      const expectedConfiguredKinds = new Set(kind === 'character' ? ['work', 'character'] : [kind]);
      const expectedSpaces = [
        { object_kind: 'artist_prompt_string', embedding_model: '__unconfigured__', dimension: 1 },
        { object_kind: 'character', embedding_model: '__unconfigured__', dimension: 1 },
        { object_kind: 'generation_lora', embedding_model: '__unconfigured__', dimension: 1 },
        { object_kind: 'prompt_term', embedding_model: '__unconfigured__', dimension: 1 },
        { object_kind: 'style', embedding_model: '__unconfigured__', dimension: 1 },
        { object_kind: 'work', embedding_model: '__unconfigured__', dimension: 1 }
      ].map((row) => expectedConfiguredKinds.has(row.object_kind) ? { ...row, embedding_model: 'fake', dimension: 1024 } : row);
      assert.deepEqual(database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all().map((row) => ({ ...row })), expectedSpaces);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, id).count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('fresh first writes roll back business rows, vectors, and vector-space initialization on embedding or SQL failure', async () => {
  for (const failureKind of ['embedding', 'sql']) {
    for (const kind of DIRECTORY_VECTOR_KINDS) {
      const root = mkdtempSync(resolve(tmpdir(), `issue-209-fresh-${failureKind}-${kind}-`));
      const database = openCatalogDatabase();
      try {
        const modelClient = { async embed() { if (failureKind === 'embedding') throw new Error('fresh embedding failed'); return [createFixtureVector()]; } };
        if (failureKind === 'sql') database.exec(`CREATE TRIGGER issue_209_fresh_${kind.replace(/[^a-z]/gu, '_')}_fail BEFORE INSERT ON vector_entries WHEN NEW.object_kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'fresh vector write failed'); END;`);
        const importer = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
        if (kind === 'character') {
          const workModel = { async embed(inputs) { return inputs.map(() => createFixtureVector()); } };
          await createCatalogImporter({ database, mediaRoot: root, modelClient: workModel, configuration, now: () => new Date(NOW) }).importDetail(detail('work', 'work one'));
        }
        await assert.rejects(() => importer.importDetail(detail(kind, kind === 'work' ? 'failed work' : `${kind} failed`)), failureKind === 'embedding' ? (error) => error?.code === 'MODEL_PROTOCOL_ERROR' : /fresh vector write failed/u);
        const table = `${kind}s`;
        assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ?').get(kind).count, 0);
        assert.deepEqual({ ...database.prepare('SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = ?').get(kind) }, { embedding_model: '__unconfigured__', dimension: 1 });
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test('directory writes do not silently switch an already configured real embedding model', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-209-model-switch-'));
  const database = openCatalogDatabase();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = 'existing-model', dimension = 1024 WHERE object_kind = 'work'").run();
    const importer = createCatalogImporter({ database, mediaRoot: root, modelClient: { async embed(inputs) { return inputs.map(() => createFixtureVector()); } }, configuration, now: () => new Date(NOW) });
    await assert.rejects(() => importer.importDetail(detail('work', 'implicit switch')), (error) => error?.code === 'INTERNAL_ERROR' && /different embedding model/u.test(error.message));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM works WHERE name = 'implicit switch'").get().count, 0);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'work'").get() }, { embedding_model: 'existing-model', dimension: 1024 });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work'").get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('embedding failure leaves the catalog row and vector unchanged', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-209-import-failure-'));
  const database = openCatalogDatabase();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    let fail = false;
    const modelClient = { async embed(inputs) { if (fail) throw new Error('embedding failed'); return inputs.map(() => createFixtureVector()); } };
    const importer = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
    const created = await importer.importDetail(detail('work', 'stable work'));
    const before = database.prepare('SELECT name, aliases_json, category_name FROM works WHERE id = ?').get(created.id);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'work' AND object_id = ?").get(created.id).embedding_f32);
    fail = true;
    await assert.rejects(() => importer.importDetail(detail('work', 'stable work', { aliases: ['changed'] })), (error) => error?.code === 'MODEL_PROTOCOL_ERROR');
    assert.deepEqual({ ...database.prepare('SELECT name, aliases_json, category_name FROM works WHERE id = ?').get(created.id) }, { ...before });
    assert.deepEqual(Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'work' AND object_id = ?").get(created.id).embedding_f32), beforeVector);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('SQL vector failure rolls back the business write and vector write together', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-209-import-sql-'));
  const database = openCatalogDatabase();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    database.exec("CREATE TRIGGER issue_209_vector_fail BEFORE INSERT ON vector_entries WHEN NEW.object_kind = 'style' BEGIN SELECT RAISE(ABORT, 'vector write failed'); END;");
    const modelClient = { async embed(inputs) { return inputs.map(() => createFixtureVector()); } };
    const importer = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
    await assert.rejects(() => importer.importDetail(detail('style', 'style SQL failure')), /vector write failed/u);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM styles WHERE name = 'style SQL failure'").get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('directory deletion removes the business row and its vector in the same transaction', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-209-delete-'));
  const database = openCatalogDatabase();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const modelClient = { async embed(inputs) { return inputs.map(() => createFixtureVector()); } };
    const importer = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
    const created = await importer.importDetail(detail('work', 'delete work'));
    const service = createMaintenanceService({ database, mediaStorage: createMediaStorage({ mediaRoot: root }), now: () => new Date(NOW) });
    service.batchDelete({ items: [{ kind: 'work', id: created.id }] });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works WHERE id = ?').get(created.id).count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work' AND object_id = ?").get(created.id).count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test('atomic style batches prepare every embedding before opening the write transaction', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-209-style-atomic-'));
  const database = openCatalogDatabase();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    const transactionStates = [];
    const modelClient = {
      async embed(inputs) {
        transactionStates.push(database.prepare('SELECT COUNT(*) AS count FROM styles').get().count);
        return inputs.map(() => createFixtureVector());
      }
    };
    database.exec("CREATE TRIGGER issue_209_atomic_vector_fail BEFORE INSERT ON vector_entries WHEN NEW.object_kind = 'style' AND NEW.object_id = 2 BEGIN SELECT RAISE(ABORT, 'vector write failed'); END;");
    const catalogImporter = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
    const batchImporter = createStyleDescriptionBatchImporter({ database, catalogImporter, baseModelId: STYLE_BASE_MODEL_ID, modelClient, configuration, now: () => new Date(NOW) });
    const records = [
      { name: 'first style', aliases: [], prompt_text: 'first', style_description: 'first description' },
      { name: 'second style', aliases: [], prompt_text: 'second', style_description: 'second description' }
    ];
    await assert.rejects(() => batchImporter.importRecords(records, { atomic: true }), /vector write failed/u);
    assert.deepEqual(transactionStates, [0, 0]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

const DIRECTORY_VECTOR_KINDS = Object.freeze(['work', 'character', 'style']);

function businessCount(database, kind) {
  const table = `${kind}s`;
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

async function createDirectoryKind({ database, root, kind, modelClient }) {
  const importer = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
  if (kind === 'character') await importer.importDetail(detail('work', 'work one'));
  const created = await importer.importDetail(detail(kind, kind === 'work' ? 'work one' : `${kind} one`));
  return { id: created.id, importer };
}

async function modifyDirectoryKind({ database, root, kind, id, importer, modelClient }) {
  const name = kind === 'work' ? 'work one' : `${kind} one`;
  const updated = detail(kind, name, { aliases: ['updated'] });
  return importer.importDetail(updated);
}

test('directory add and modify synchronize work, character and style vector spaces without changing the row set', async () => {
  for (const kind of DIRECTORY_VECTOR_KINDS) {
    const root = mkdtempSync(resolve(tmpdir(), `issue-209-matrix-${kind}-`));
    const database = openCatalogDatabase();
    try {
      database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
      const modelClient = { async embed(inputs) { return inputs.map((input) => input.includes('updated') || input.includes('更新') ? createFixtureVector(0, 1) : createFixtureVector()); } };
      const created = await createDirectoryKind({ database, root, kind, modelClient });
      assert.equal(businessCount(database, kind), 1, `${kind} add did not create its row`);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ?').get(kind).count, 1, `${kind} add did not create its vector`);
      const beforeVector = Buffer.from(database.prepare('SELECT embedding_f32 FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, created.id).embedding_f32);
      await modifyDirectoryKind({ database, root, kind, id: created.id, importer: created.importer, modelClient });
      assert.equal(businessCount(database, kind), 1, `${kind} modify changed row cardinality`);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ?').get(kind).count, 1, `${kind} modify lost its vector`);
      const afterVector = Buffer.from(database.prepare('SELECT embedding_f32 FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, created.id).embedding_f32);
      assert.notDeepEqual(afterVector, beforeVector, `${kind} modify did not change its vector blob`);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6, `${kind} operation changed fixed vector-space rows`);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('directory embedding failures leave every kind unchanged', async () => {
  for (const kind of DIRECTORY_VECTOR_KINDS) {
    const root = mkdtempSync(resolve(tmpdir(), `issue-209-matrix-fail-${kind}-`));
    const database = openCatalogDatabase();
    try {
      database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
      let fail = false;
      const modelClient = { async embed(inputs) { if (fail) throw new Error('embedding unavailable'); return inputs.map(() => createFixtureVector()); } };
      const created = await createDirectoryKind({ database, root, kind, modelClient });
      const beforeBusiness = database.prepare(`SELECT * FROM ${kind}s`).all().map((row) => ({ ...row }));
      const beforeVector = Buffer.from(database.prepare('SELECT embedding_f32 FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, created.id).embedding_f32);
      fail = true;
      await assert.rejects(() => modifyDirectoryKind({ database, root, kind, id: created.id, importer: created.importer, modelClient }), (error) => error?.code === 'MODEL_PROTOCOL_ERROR', kind);
      assert.deepEqual(database.prepare(`SELECT * FROM ${kind}s`).all().map((row) => ({ ...row })), beforeBusiness);
      assert.deepEqual(Buffer.from(database.prepare('SELECT embedding_f32 FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, created.id).embedding_f32), beforeVector);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('directory SQL vector failures roll back each kind as one operation', async () => {
  for (const kind of DIRECTORY_VECTOR_KINDS) {
    const root = mkdtempSync(resolve(tmpdir(), `issue-209-matrix-sql-${kind}-`));
    const database = openCatalogDatabase();
    try {
      database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
      const modelClient = { async embed(inputs) { return inputs.map(() => createFixtureVector()); } };
      database.exec(`CREATE TRIGGER issue_209_matrix_sql_${kind.replace(/[^a-z]/gu, '_')} BEFORE INSERT ON vector_entries WHEN NEW.object_kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'vector write failed'); END;`);
      const importer = createCatalogImporter({ database, mediaRoot: root, modelClient, configuration, now: () => new Date(NOW) });
      if (kind === 'character') await importer.importDetail(detail('work', 'work one'));
      await assert.rejects(() => importer.importDetail(detail(kind, kind === 'work' ? 'work one' : `${kind} one`)), /vector write failed/u);
      assert.equal(businessCount(database, kind), 0, `${kind} SQL failure left a business row`);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ?').get(kind).count, 0, `${kind} SQL failure left a vector`);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('directory deletion removes each kind business row and vector directly', async () => {
  for (const kind of DIRECTORY_VECTOR_KINDS) {
    const root = mkdtempSync(resolve(tmpdir(), `issue-209-matrix-delete-${kind}-`));
    const database = openCatalogDatabase();
    try {
      database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
      const modelClient = { async embed(inputs) { return inputs.map(() => createFixtureVector()); } };
      const created = await createDirectoryKind({ database, root, kind, modelClient });
      const service = createMaintenanceService({ database, mediaStorage: createMediaStorage({ mediaRoot: root }), now: () => new Date(NOW) });
      service.batchDelete({ items: [{ kind, id: created.id }] });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, created.id).count, 0, `${kind} deletion left vector`);
      assert.equal(businessCount(database, kind), 0, `${kind} deletion left wrong business rows`);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('directory deletion SQL failures roll back each kind business row and vector together', async () => {
  for (const kind of DIRECTORY_VECTOR_KINDS) {
    const root = mkdtempSync(resolve(tmpdir(), `issue-209-delete-sql-${kind}-`));
    const database = openCatalogDatabase();
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
      const modelClient = { async embed(inputs) { return inputs.map(() => createFixtureVector()); } };
      const created = await createDirectoryKind({ database, root, kind, modelClient });
      database.exec(`CREATE TRIGGER issue_209_delete_sql_${kind.replace(/[^a-z]/gu, '_')}_fail BEFORE DELETE ON vector_entries WHEN OLD.object_kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'directory vector delete failed'); END;`);
      const service = createMaintenanceService({ database, mediaStorage: createMediaStorage({ mediaRoot: root }), now: () => new Date(NOW) });
      assert.throws(() => service.batchDelete({ items: [{ kind, id: created.id }] }), /directory vector delete failed/u);
      assert.equal(businessCount(database, kind), 1, `${kind} delete failure removed its business row`);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, created.id).count, 1, `${kind} delete failure removed its vector`);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
