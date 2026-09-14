import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogImporter } from '../../app/ingest/manual-ingest.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-08-05T00:00:00.000Z';
const configuration = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });

function styleDetail(baseModelId, name, extra = {}) {
  return {
    identity: { kind: 'style', base_model_id: baseModelId, parent_identity: 'root', normalized_name: name },
    base_model_id: baseModelId,
    source_url: null,
    name,
    aliases: [],
    prompt_text: `${name} prompt`,
    style_description: `${name} description`,
    image_results: [],
    ...extra
  };
}

function seedBaseModels(database) {
  database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (7, 'anima', ?, ?), (42, 'wai', ?, ?)").run(NOW, NOW, NOW, NOW);
  database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
}

test('Issue #210 Style writes keep same-name WAI and Anima rows independent and synchronize one vector each', async (t) => {
  const mediaRoot = mkdtempSync(join(tmpdir(), 'issue-210-style-sync-'));
  t.after(() => rmSync(mediaRoot, { recursive: true, force: true }));
  const database = openCatalogDatabase();
  try {
    seedBaseModels(database);
    const modelClient = { async embed(inputs) { return inputs.map((input) => input.includes('updated') ? createFixtureVector(0, 1) : createFixtureVector()); } };
    const importer = createCatalogImporter({ database, mediaRoot, modelClient, configuration, now: () => new Date(NOW) });
    const wai = await importer.importDetail(styleDetail(42, 'SushiSpin', { prompt_text: 'S0sh1Sknsfw' }));
    const anima = await importer.importDetail(styleDetail(7, 'SushiSpin', { prompt_text: 'sushispin' }));
    assert.notEqual(wai.id, anima.id);
    assert.deepEqual(database.prepare('SELECT id, base_model_id, name, prompt_text FROM styles ORDER BY base_model_id').all().map((row) => ({ ...row })), [
      { id: anima.id, base_model_id: 7, name: 'SushiSpin', prompt_text: 'sushispin' },
      { id: wai.id, base_model_id: 42, name: 'SushiSpin', prompt_text: 'S0sh1Sknsfw' }
    ]);
    assert.deepEqual(database.prepare("SELECT object_kind, object_id FROM vector_entries WHERE object_kind = 'style' ORDER BY object_id").all().map((row) => ({ ...row })), [
      { object_kind: 'style', object_id: Math.min(wai.id, anima.id) },
      { object_kind: 'style', object_id: Math.max(wai.id, anima.id) }
    ]);
    const beforeId = wai.id;
    await importer.importDetail(styleDetail(42, 'SushiSpin', { aliases: ['updated'], style_description: 'updated description', prompt_text: 'S0sh1Sknsfw' }));
    assert.equal(database.prepare('SELECT id FROM styles WHERE base_model_id = 42 AND name = ?').get('SushiSpin').id, beforeId);
    assert.equal(database.prepare('SELECT style_description FROM styles WHERE id = ?').get(beforeId).style_description, 'updated description');
  } finally {
    database.close();
  }
});

test('Issue #210 Style Embedding or vector SQL failure leaves the style business row and vector unchanged', async (t) => {
  const mediaRoot = mkdtempSync(join(tmpdir(), 'issue-210-style-failure-'));
  t.after(() => rmSync(mediaRoot, { recursive: true, force: true }));
  const database = openCatalogDatabase();
  try {
    seedBaseModels(database);
    let failEmbedding = false;
    const modelClient = { async embed(inputs) { if (failEmbedding) throw new Error('style embedding failed'); return inputs.map(() => createFixtureVector()); } };
    const importer = createCatalogImporter({ database, mediaRoot, modelClient, configuration, now: () => new Date(NOW) });
    const created = await importer.importDetail(styleDetail(42, 'StableStyle'));
    const before = database.prepare('SELECT base_model_id, name, aliases_json, prompt_text, style_description FROM styles WHERE id = ?').get(created.id);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'style' AND object_id = ?").get(created.id).embedding_f32);
    failEmbedding = true;
    await assert.rejects(() => importer.importDetail(styleDetail(42, 'StableStyle', { aliases: ['changed'] })), /style embedding failed|embedding service failed|MODEL_PROTOCOL_ERROR/u);
    assert.deepEqual({ ...database.prepare('SELECT base_model_id, name, aliases_json, prompt_text, style_description FROM styles WHERE id = ?').get(created.id) }, { ...before });
    assert.deepEqual(Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'style' AND object_id = ?").get(created.id).embedding_f32), beforeVector);
    failEmbedding = false;
    database.exec("CREATE TRIGGER issue_210_style_vector_failure BEFORE INSERT ON vector_entries WHEN NEW.object_kind = 'style' BEGIN SELECT RAISE(ABORT, 'style vector write failed'); END;");
    await assert.rejects(() => importer.importDetail(styleDetail(42, 'SQLFailureStyle')), /style vector write failed/u);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM styles WHERE name = 'SQLFailureStyle'").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style' AND object_id NOT IN (?)").get(created.id).count, 0);
  } finally {
    database.close();
  }
});
