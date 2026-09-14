import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { inTransaction, openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createBaseModelRepository } from '../../app/generation-resources/base-model-repository.mjs';
import { createBaseModelService } from '../../app/generation-resources/base-model-service.mjs';
import { createArtistPromptStringRepository } from '../../app/generation-resources/artist-prompt-string-repository.mjs';
import { createArtistPromptStringService } from '../../app/generation-resources/artist-prompt-string-service.mjs';
import { createLoraRepository } from '../../app/generation-resources/lora-repository.mjs';
import { createLoraService } from '../../app/generation-resources/lora-service.mjs';
import { createModelRepository } from '../../app/generation-resources/model-repository.mjs';
import { createModelService } from '../../app/generation-resources/model-service.mjs';
import { createMaintenanceService } from '../../app/maintenance/maintenance-service.mjs';
import { createPromptTermVectorMaintenance } from '../../app/vector/prompt-term-semantic.mjs';
import { upsertVectorEntry } from '../../app/vector/vector-store.mjs';

const NOW = '2026-08-23T00:00:00.000Z';
const EMBEDDING_MODEL = 'issue-288-source-delete-model';
const VECTOR_DIMENSION = 1024;

function vector(seed) {
  const values = new Array(VECTOR_DIMENSION).fill(0);
  values[seed] = 1;
  return values;
}

function seedGenerationSources(database) {
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (103, 'Issue 288 Source Delete', '${NOW}', '${NOW}');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (
      104, 103, 'issue-288-source-delete.safetensors', 'safetensors', 'fp16',
      'source delete model', 'source delete usage', '${NOW}', '${NOW}'
    );
    INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (
      106, 103, 104, 'issue-288-source-delete-lora.safetensors', 'safetensors', 'fp16',
      'source delete lora', 'source delete lora usage', '[]', 1.0, '${NOW}', '${NOW}'
    );
    INSERT INTO artist_prompt_strings(
      id, title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES (
      107, 'Issue Source Delete', 'source delete artist', 'source_delete_artist', 103, '${NOW}', '${NOW}'
    );
  `);
}

function seedDirectorySources(database) {
  database.exec(`
    INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at)
      VALUES (101, 'Issue Work', 'issue work', '[]', 'source delete', 1, '${NOW}', '${NOW}'),
        (110, 'Issue Direct Character Work', 'issue direct character work', '[]', 'source delete', 1, '${NOW}', '${NOW}');
    INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
      VALUES (102, 101, 'Issue Character', 'issue character', '[]', 'character source delete', 1, '${NOW}', '${NOW}'),
        (111, 110, 'Issue Direct Character', 'issue direct character', '[]', 'direct character source delete', 1, '${NOW}', '${NOW}');
    INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description)
      VALUES (105, 103, 'Issue Style', '[]', 'style source delete', 'style description');
    INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at)
      VALUES (108, 'issue_source_delete_tag', 1, 1, '[]', '${NOW}', '${NOW}');
  `);
}

const ALL_VECTOR_SEEDS = Object.freeze([
  ['work', 101],
  ['character', 102],
  ['character', 111],
  ['style', 105],
  ['prompt_term', 108],
  ['generation_lora', 106],
  ['artist_prompt_string', 107]
]);

function seedVectors(database, entries = ALL_VECTOR_SEEDS) {
  database.prepare('UPDATE vector_spaces SET embedding_model = ?, dimension = ?').run(EMBEDDING_MODEL, VECTOR_DIMENSION);
  inTransaction(database, () => {
    for (const [objectKind, objectId] of entries) {
      upsertVectorEntry(database, objectKind, objectId, vector(objectId), { expectedModel: EMBEDDING_MODEL });
    }
  });
}

function count(database, table, where, parameters) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...parameters).count;
}

function deleteServiceDependencies() {
  return {
    mediaStorage: { remove() {} },
    cleanupQueue: { enqueue() {}, recordFailure() {} },
    vectorMaintenance: { prepare() { throw new Error('delete test must not prepare an embedding'); } }
  };
}

function modelDeleteService(database, repository = createModelRepository(database)) {
  return createModelService({
    database,
    repository,
    mediaStorage: { remove() {} },
    cleanupQueue: { enqueue() {}, recordFailure() {} },
    now: () => new Date(NOW)
  });
}

function baseModelDeleteService(database, repository = createBaseModelRepository(database)) {
  return createBaseModelService({
    database,
    repository,
    mediaStorage: { remove() {} },
    cleanupQueue: { enqueue() {}, recordFailure() {} },
    now: () => new Date(NOW)
  });
}

function assertGenerationLoraDeleted(database) {
  assert.equal(count(database, 'generation_loras', 'id = ?', [106]), 0);
  assert.equal(count(database, 'vector_entries', 'object_kind = ? AND object_id = ?', ['generation_lora', 106]), 0);
  assert.equal(count(database, 'vector_knn_index', 'object_kind = ? AND object_id = ?', ['generation_lora', 106]), 0);
}

function assertGenerationLoraPresent(database) {
  assert.equal(count(database, 'generation_loras', 'id = ?', [106]), 1);
  assert.equal(count(database, 'vector_entries', 'object_kind = ? AND object_id = ?', ['generation_lora', 106]), 1);
  assert.equal(count(database, 'vector_knn_index', 'object_kind = ? AND object_id = ?', ['generation_lora', 106]), 1);
}

test('generation model cascade deletion removes generation_lora business and KNN rows after reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'issue-288-model-cascade-delete-'));
  const databasePath = join(directory, 'app.sqlite');
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedGenerationSources(database);
    seedVectors(database, [['generation_lora', 106], ['artist_prompt_string', 107]]);
    const service = modelDeleteService(database);
    const impact = service.getDeleteImpact(104);
    assert.deepEqual(impact.cascade_deleted, [{ kind: 'lora', id: 106, name: 'issue-288-source-delete-lora.safetensors' }]);

    service.delete(104, impact.impact_token);

    assert.equal(count(database, 'generation_models', 'id = ?', [104]), 0);
    assertGenerationLoraDeleted(database);
    database.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
  try {
    const reopened = openCatalogDatabase({ databasePath, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(count(reopened, 'generation_models', 'id = ?', [104]), 0);
      assertGenerationLoraDeleted(reopened);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('base model cascade deletion removes generation_lora business and KNN rows after reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'issue-288-base-model-cascade-delete-'));
  const databasePath = join(directory, 'app.sqlite');
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedGenerationSources(database);
    seedVectors(database, [['generation_lora', 106], ['artist_prompt_string', 107]]);
    const service = baseModelDeleteService(database);
    const impact = service.getDeleteImpact(103);
    assert.deepEqual(impact.cascade_deleted.filter(({ kind }) => kind === 'lora'), [{ kind: 'lora', id: 106, name: 'issue-288-source-delete-lora.safetensors' }]);

    service.delete(103, impact.impact_token);

    assert.equal(count(database, 'generation_base_models', 'id = ?', [103]), 0);
    assert.equal(count(database, 'generation_models', 'id = ?', [104]), 0);
    assertGenerationLoraDeleted(database);
    database.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
  try {
    const reopened = openCatalogDatabase({ databasePath, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(count(reopened, 'generation_base_models', 'id = ?', [103]), 0);
      assert.equal(count(reopened, 'generation_models', 'id = ?', [104]), 0);
      assertGenerationLoraDeleted(reopened);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('generation model cascade vector deletion rolls back when repository removal fails', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedGenerationSources(database);
    seedVectors(database, [['generation_lora', 106]]);
    const repository = createModelRepository(database);
    const service = modelDeleteService(database, { ...repository, remove() { throw new Error('issue 288 model removal failed'); } });
    const impact = service.getDeleteImpact(104);

    assert.throws(() => service.delete(104, impact.impact_token), /issue 288 model removal failed/u);
    assert.equal(count(database, 'generation_models', 'id = ?', [104]), 1);
    assertGenerationLoraPresent(database);
  } finally {
    database.close();
  }
});

test('base model cascade vector deletion rolls back when repository removal fails', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedGenerationSources(database);
    seedVectors(database, [['generation_lora', 106]]);
    const repository = createBaseModelRepository(database);
    const service = baseModelDeleteService(database, { ...repository, remove() { throw new Error('issue 288 base model removal failed'); } });
    const impact = service.getDeleteImpact(103);

    assert.throws(() => service.delete(103, impact.impact_token), /issue 288 base model removal failed/u);
    assert.equal(count(database, 'generation_base_models', 'id = ?', [103]), 1);
    assert.equal(count(database, 'generation_models', 'id = ?', [104]), 1);
    assertGenerationLoraPresent(database);
  } finally {
    database.close();
  }
});

test('generation model cascade rejects a malformed lora impact id before repository removal', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  let removed = false;
  try {
    seedGenerationSources(database);
    seedVectors(database, [['generation_lora', 106]]);
    const actualRepository = createModelRepository(database);
    const repository = {
      ...actualRepository,
      getImpact(id) {
        const impact = actualRepository.getImpact(id);
        return {
          ...impact,
          cascade_deleted: impact.cascade_deleted.map((item) => item.kind === 'lora' ? { ...item, id: 0 } : item)
        };
      },
      remove(id) {
        removed = true;
        return actualRepository.remove(id);
      }
    };
    const service = modelDeleteService(database, repository);
    const impact = service.getDeleteImpact(104);

    assert.throws(() => service.delete(104, impact.impact_token), /objectId must be a positive integer/u);
    assert.equal(removed, false);
    assert.equal(count(database, 'generation_models', 'id = ?', [104]), 1);
    assertGenerationLoraPresent(database);
  } finally {
    database.close();
  }
});

test('base model cascade rejects a malformed lora impact id before repository removal', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  let removed = false;
  try {
    seedGenerationSources(database);
    seedVectors(database, [['generation_lora', 106]]);
    const actualRepository = createBaseModelRepository(database);
    const repository = {
      ...actualRepository,
      getImpact(id) {
        const impact = actualRepository.getImpact(id);
        return {
          ...impact,
          cascade_deleted: impact.cascade_deleted.map((item) => item.kind === 'lora' ? { ...item, id: 0 } : item)
        };
      },
      remove(id) {
        removed = true;
        return actualRepository.remove(id);
      }
    };
    const service = baseModelDeleteService(database, repository);
    const impact = service.getDeleteImpact(103);

    assert.throws(() => service.delete(103, impact.impact_token), /objectId must be a positive integer/u);
    assert.equal(removed, false);
    assert.equal(count(database, 'generation_base_models', 'id = ?', [103]), 1);
    assert.equal(count(database, 'generation_models', 'id = ?', [104]), 1);
    assertGenerationLoraPresent(database);
  } finally {
    database.close();
  }
});

test('LoRA and artist service deletion removes source rows and vectors from both stores', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    assert.equal(database.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
    seedGenerationSources(database);
    seedVectors(database, [['generation_lora', 106], ['artist_prompt_string', 107]]);
    const dependencies = deleteServiceDependencies();
    const loraService = createLoraService({ database, repository: createLoraRepository(database), ...dependencies });
    const artistService = createArtistPromptStringService({ database, repository: createArtistPromptStringRepository(database), ...dependencies });

    loraService.delete(106, loraService.getDeleteImpact(106).impact_token);
    artistService.delete(107, artistService.getDeleteImpact(107).impact_token);

    assert.equal(count(database, 'generation_loras', 'id = ?', [106]), 0);
    assert.equal(count(database, 'artist_prompt_strings', 'id = ?', [107]), 0);
    assert.equal(count(database, 'vector_entries', 'object_kind = ? AND object_id = ?', ['generation_lora', 106]), 0);
    assert.equal(count(database, 'vector_entries', 'object_kind = ? AND object_id = ?', ['artist_prompt_string', 107]), 0);
    assert.equal(count(database, 'vector_knn_index', 'object_kind = ? AND object_id = ?', ['generation_lora', 106]), 0);
    assert.equal(count(database, 'vector_knn_index', 'object_kind = ? AND object_id = ?', ['artist_prompt_string', 107]), 0);
  } finally {
    database.close();
  }
});

test('maintenance batch deletion removes work, cascaded character, direct character, and style vectors from both stores', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedGenerationSources(database);
    seedDirectorySources(database);
    seedVectors(database);
    const service = createMaintenanceService({ database, mediaStorage: { remove() {} } });

    service.batchDelete({ items: [{ kind: 'work', id: 101 }, { kind: 'style', id: 105 }] });
    service.batchDelete({ items: [{ kind: 'character', id: 111 }] });

    for (const [table, id] of [['works', 101], ['characters', 102], ['characters', 111], ['styles', 105]]) {
      assert.equal(count(database, table, 'id = ?', [id]), 0, `${table}:${id} source row remains`);
    }
    for (const [kind, id] of [['work', 101], ['character', 102], ['character', 111], ['style', 105]]) {
      assert.equal(count(database, 'vector_entries', 'object_kind = ? AND object_id = ?', [kind, id]), 0, `${kind}:${id} vector entry remains`);
      assert.equal(count(database, 'vector_knn_index', 'object_kind = ? AND object_id = ?', [kind, id]), 0, `${kind}:${id} KNN row remains`);
    }
  } finally {
    database.close();
  }
});

test('source deletion failure rolls back the source row and both vector stores', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedGenerationSources(database);
    seedDirectorySources(database);
    seedVectors(database);
    database.exec(`CREATE TRIGGER issue_288_source_delete_failure
      BEFORE DELETE ON works
      WHEN OLD.id = 101
      BEGIN SELECT RAISE(ABORT, 'issue 288 source delete failed'); END;`);
    const service = createMaintenanceService({ database, mediaStorage: { remove() {} } });

    assert.throws(() => service.batchDelete({ items: [{ kind: 'work', id: 101 }] }), /issue 288 source delete failed/u);
    assert.equal(count(database, 'works', 'id = ?', [101]), 1);
    assert.equal(count(database, 'vector_entries', 'object_kind = ? AND object_id = ?', ['work', 101]), 1);
    assert.equal(count(database, 'vector_knn_index', 'object_kind = ? AND object_id = ?', ['work', 101]), 1);
  } finally {
    database.close();
  }
});

test('prompt-term vector maintenance deletion removes both vector stores without deleting the source row', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    database.prepare('INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at) VALUES (108, ?, 1, 1, ?, ?, ?)')
      .run('vector_maintenance_source_delete_tag', '[]', NOW, NOW);
    seedVectors(database, [['prompt_term', 108]]);
    const maintenance = createPromptTermVectorMaintenance({
      database,
      modelClient: { async embed(inputs) { return inputs.map(() => vector(0)); } },
      configuration: { embedding_model: EMBEDDING_MODEL },
      now: () => NOW
    });

    assert.deepEqual(maintenance.delete(108), { object_kind: 'prompt_term', object_id: 108, status: 'deleted' });
    assert.equal(count(database, 'prompt_terms', 'id = ?', [108]), 1);
    assert.equal(count(database, 'vector_entries', 'object_kind = ? AND object_id = ?', ['prompt_term', 108]), 0);
    assert.equal(count(database, 'vector_knn_index', 'object_kind = ? AND object_id = ?', ['prompt_term', 108]), 0);
  } finally {
    database.close();
  }
});
