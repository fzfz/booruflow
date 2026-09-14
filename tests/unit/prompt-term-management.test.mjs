import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createPromptTermManagementRepository } from '../../app/prompt-terms/prompt-term-management-repository.mjs';
import { createPromptTermManagementService } from '../../app/prompt-terms/prompt-term-management-service.mjs';
import { createPromptTermVectorMaintenance } from '../../app/vector/prompt-term-semantic.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-08-31T10:00:00.000Z';
const CONFIGURATION = Object.freeze({ embedding_model: 'prompt-term-management-test' });

function fixture({ embed = async (inputs) => inputs.map(() => createFixtureVector()) } = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  const calls = [];
  const modelClient = Object.freeze({
    async embed(inputs) {
      calls.push(...inputs);
      return embed(inputs);
    }
  });
  const repository = createPromptTermManagementRepository(database);
  const vectorMaintenance = createPromptTermVectorMaintenance({ database, modelClient, configuration: CONFIGURATION, now: () => new Date(NOW) });
  const service = createPromptTermManagementService({
    database,
    repository,
    vectorMaintenance,
    now: () => new Date(NOW)
  });
  return { database, calls, service };
}

test('Prompt Tag management creates, updates, filters and deletes the row and vector as one business operation', async () => {
  const { database, calls, service } = fixture();
  try {
    const created = await service.create({ canonical_tag: 'blue_eyes', category: 0, aliases_json: ['blue eyes', '蓝眼睛'], post_count: 1752918 });
    assert.equal(created.canonical_tag, 'blue_eyes');
    assert.deepEqual(created.aliases_json, ['blue eyes', '蓝眼睛']);
    assert.deepEqual(calls, ['blue_eyes\nblue eyes\n蓝眼睛']);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'prompt_term' AND object_id = ?").get(created.id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_knn_index WHERE object_kind = 'prompt_term' AND object_id = ?").get(BigInt(created.id)).count, 1);

    const byAlias = service.list({ q: '蓝眼', category: 0, post_count_min: 100, post_count_max: 2000000, page: 1, page_size: 16 });
    assert.equal(byAlias.total_count, 1);
    assert.equal(byAlias.items[0].id, created.id);

    const updated = await service.update(created.id, { canonical_tag: 'azure_eyes', category: 5, aliases_json: ['azure eyes'], post_count: 42 });
    assert.equal(updated.category, 5);
    assert.deepEqual(calls, ['blue_eyes\nblue eyes\n蓝眼睛', 'azure_eyes\nazure eyes']);
    assert.equal(service.list({ q: 'blue_eyes' }).total_count, 0);
    assert.equal(service.list({ q: 'azure', category: 5, post_count_min: 42, post_count_max: 42 }).total_count, 1);

    assert.deepEqual(service.delete(created.id), { target: { id: created.id, canonical_tag: 'azure_eyes' } });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prompt_terms WHERE id = ?').get(created.id).count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'prompt_term' AND object_id = ?").get(created.id).count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_knn_index WHERE object_kind = 'prompt_term' AND object_id = ?").get(BigInt(created.id)).count, 0);
  } finally {
    database.close();
  }
});

test('Prompt Tag management validates writes and leaves no row when embedding fails', async () => {
  const failure = fixture({ embed: async () => { throw new Error('offline'); } });
  try {
    await assert.rejects(
      () => failure.service.create({ canonical_tag: 'no_vector', category: 0, aliases_json: [], post_count: 0 }),
      (error) => error?.code === 'MODEL_PROTOCOL_ERROR'
    );
    assert.equal(failure.database.prepare('SELECT COUNT(*) AS count FROM prompt_terms').get().count, 0);
  } finally {
    failure.database.close();
  }

  const valid = fixture();
  try {
    for (const input of [
      { canonical_tag: '', category: 0, aliases_json: [], post_count: 0 },
      { canonical_tag: 'x', category: 2, aliases_json: [], post_count: 0 },
      { canonical_tag: 'x', category: 0, aliases_json: ['same', ' same '], post_count: 0 },
      { canonical_tag: 'x', category: 0, aliases_json: [], post_count: -1 }
    ]) {
      await assert.rejects(() => valid.service.create(input), (error) => error?.name === 'InputValidationError');
    }
    const first = await valid.service.create({ canonical_tag: 'unique_tag', category: 0, aliases_json: [], post_count: 0 });
    assert.ok(first.id > 0);
    await assert.rejects(
      () => valid.service.create({ canonical_tag: 'unique_tag', category: 1, aliases_json: [], post_count: 1 }),
      (error) => error?.code === 'DUPLICATE_RESOURCE'
    );
  } finally {
    valid.database.close();
  }
});
