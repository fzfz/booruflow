import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createLoraRepository } from '../../app/generation-resources/lora-repository.mjs';

const TIMESTAMP = '2026-08-12T00:00:00.000Z';

function createFixture() {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)')
    .run('repository-base', TIMESTAMP, TIMESTAMP);
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (2, 1, 'repository-model.safetensors', 'safetensors', 'none', 'model description', 'model usage', ?, ?)`).run(TIMESTAMP, TIMESTAMP);
  return { database, repository: createLoraRepository(database) };
}

function write(fileName, triggerWords, weight) {
  return Object.freeze({
    base_model_id: 1,
    model_id: 2,
    file_name: fileName,
    file_format: 'safetensors',
    precision_or_quantization: 'none',
    author: null,
    version: null,
    release_url: null,
    description: 'repository description',
    usage: 'repository usage',
    trigger_words: triggerWords,
    weight,
    timestamp: TIMESTAMP
  });
}

function assertProjection(record, triggerWords, weight) {
  assert.deepEqual(record.trigger_words, triggerWords);
  assert.equal(record.weight, weight);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.trigger_words), true);
  assert.equal(Object.hasOwn(record, 'trigger_words_json'), false);
}

test('LoRA repository serializes once and projects frozen arrays across create, get, list and update', () => {
  const { database, repository } = createFixture();
  try {
    const created = repository.create(write('repository-lora.safetensors', Object.freeze(['first', 'second']), -0.25));
    assertProjection(created, ['first', 'second'], -0.25);
    assert.deepEqual({ ...database.prepare('SELECT trigger_words_json, weight FROM generation_loras WHERE id = ?').get(created.id) }, {
      trigger_words_json: '["first","second"]',
      weight: -0.25
    });

    assertProjection(repository.get(created.id), ['first', 'second'], -0.25);
    const listed = repository.list({ page: 1, page_size: 20, q: '', base_model_id: 1, model_id: 2 });
    assert.equal(Object.isFrozen(listed.items), true);
    assert.equal(listed.total_count, 1);
    assertProjection(listed.items[0], ['first', 'second'], -0.25);

    const updated = repository.update({ id: created.id, ...write('repository-lora.safetensors', Object.freeze([]), 1.25) });
    assertProjection(updated, [], 1.25);
    assert.deepEqual({ ...database.prepare('SELECT trigger_words_json, weight FROM generation_loras WHERE id = ?').get(created.id) }, {
      trigger_words_json: '[]',
      weight: 1.25
    });
  } finally {
    database.close();
  }
});

test('LoRA repository surfaces invalid persisted JSON instead of silently returning an empty array', () => {
  const { database, repository } = createFixture();
  try {
    database.exec('PRAGMA ignore_check_constraints = ON;');
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (3, 1, 2, 'broken-json.safetensors', 'safetensors', 'none', 'description', 'usage', 'not-json', 1, ?, ?)`).run(TIMESTAMP, TIMESTAMP);
    assert.throws(() => repository.get(3), SyntaxError);
  } finally {
    database.close();
  }
});
