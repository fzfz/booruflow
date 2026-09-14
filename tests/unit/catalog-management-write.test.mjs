import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogManagementService } from '../../app/catalog/catalog-management-service.mjs';
import { createCatalogManagementVectorPreparation } from '../../app/catalog/catalog-management-vector.mjs';
import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-08-31T12:00:00.000Z';
const CONFIGURATION = Object.freeze({ embedding_model: 'catalog-management-test' });

function fixture({ embed = async (inputs) => inputs.map(() => createFixtureVector()) } = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('anima', NOW, NOW);
  const projections = [];
  const vectorPreparation = createCatalogManagementVectorPreparation({
    configuration: CONFIGURATION,
    modelClient: Object.freeze({
      async embed(inputs) {
        projections.push(...inputs);
        return embed(inputs);
      }
    })
  });
  const repository = createCatalogRepository(database);
  const service = createCatalogManagementService({ database, repository, vectorPreparation, now: () => new Date(NOW) });
  return { database, projections, service };
}

test('catalog management creates and updates work, character and style fields with synchronized vectors', async () => {
  const { database, projections, service } = fixture();
  try {
    const work = await service.create('work', { name: '星海旅人', category_name: '作品', aliases_json: ['星海'], is_available: true });
    const character = await service.create('character', { work_id: work.id, name: '白夜侦探', aliases_json: ['白夜'], prompt_text: 'white hair detective', is_available: true });
    const style = await service.create('style', { base_model_id: 1, name: '东方幻想', aliases_json: ['东方'], prompt_text: 'eastern fantasy', style_description: '清晰轮廓与东方装饰。' });
    assert.equal(style.base_model_name, 'anima');

    assert.deepEqual(projections, [
      '星海旅人\n星海\n作品',
      '星海旅人\n白夜侦探\n白夜\nwhite hair detective',
      '东方幻想\n东方\n清晰轮廓与东方装饰。\neastern fantasy'
    ]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind IN ('work', 'character', 'style')").get().count, 3);

    const updated = await service.update('character', character.id, { work_id: work.id, name: '白夜侦探改', aliases_json: [], prompt_text: 'updated prompt', is_available: false });
    assert.equal(updated.is_available, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'character' AND object_id = ?").get(character.id).count, 0);
    assert.equal(service.get('style', style.id).style_description, '清晰轮廓与东方装饰。');
  } finally {
    database.close();
  }
});

test('catalog management validates relation fields and does not persist a row when vector preparation fails', async () => {
  const failure = fixture({ embed: async () => { throw new Error('offline'); } });
  try {
    await assert.rejects(
      () => failure.service.create('work', { name: '失败作品', category_name: null, aliases_json: [], is_available: true }),
      (error) => error?.code === 'MODEL_PROTOCOL_ERROR'
    );
    assert.equal(failure.database.prepare('SELECT COUNT(*) AS count FROM works').get().count, 0);
  } finally {
    failure.database.close();
  }

  const valid = fixture();
  try {
    await assert.rejects(
      () => valid.service.create('character', { work_id: 999, name: '无作品角色', aliases_json: [], prompt_text: 'prompt', is_available: true }),
      (error) => error?.code === 'RELATION_CONFLICT'
    );
    await assert.rejects(
      () => valid.service.create('style', { base_model_id: 999, name: '无底模画风', aliases_json: [], prompt_text: 'prompt', style_description: null }),
      (error) => error?.code === 'RELATION_CONFLICT'
    );
    await assert.rejects(
      () => valid.service.create('work', { name: '', category_name: null, aliases_json: [], is_available: true }),
      (error) => error?.name === 'InputValidationError'
    );
  } finally {
    valid.database.close();
  }
});
