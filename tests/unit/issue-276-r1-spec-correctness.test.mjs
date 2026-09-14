import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { inTransaction, openCatalogDatabase } from '../../app/catalog/database.mjs';
import { main as runSemanticCli, parseArguments } from '../../scripts/imagegen-semantic-query.mjs';
import { createArtistPromptStringSemanticService } from '../../app/vector/artist-prompt-string-semantic.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';
import { createGenerationLoraSemanticService } from '../../app/vector/generation-lora-semantic.mjs';
import { upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createLoraRepository } from '../../app/generation-resources/lora-repository.mjs';
import { createLoraService } from '../../app/generation-resources/lora-service.mjs';
import { validateCatalogRequest } from '../../app/security/input-validation.mjs';

test('Issue #276 R1.1 refuses every later SQLite access after an uncertain transaction', () => {
  const rawDatabase = openCatalogDatabase({
    databasePath: ':memory:',
    includeBuiltinComfyuiCatalog: false
  });
  let failCommit = false;
  let failRollback = false;
  const database = new Proxy(rawDatabase, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (failCommit && sql === 'COMMIT;') throw new Error('forced commit result unavailable');
          if (failRollback && sql === 'ROLLBACK;') throw new Error('forced rollback result unavailable');
          return target.exec(sql);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const preparedBeforeUncertain = database.prepare('SELECT 1 AS value');
  const iteratorBeforeUncertain = database.prepare('SELECT 1 AS value').iterate();
  try {
    failCommit = true;
    failRollback = true;
    assert.throws(() => inTransaction(database, () => {}), /ROLLBACK failed/u);

    assert.throws(() => database.prepare('SELECT 1'), /not serviceable/u);
    assert.throws(() => database.exec('SELECT 1'), /not serviceable/u);
    assert.throws(() => preparedBeforeUncertain.get(), /not serviceable/u);
    assert.throws(() => iteratorBeforeUncertain[Symbol.iterator]().next(), /not serviceable/u);
  } finally {
    database.close();
  }
});

test('Issue #276 R1.1 rejects an already constructed management service after uncertainty while still allowing close', () => {
  const rawDatabase = openCatalogDatabase({
    databasePath: ':memory:',
    includeBuiltinComfyuiCatalog: false
  });
  let failCommit = false;
  let failRollback = false;
  const database = new Proxy(rawDatabase, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (failCommit && sql === 'COMMIT;') throw new Error('forced commit result unavailable');
          if (failRollback && sql === 'ROLLBACK;') throw new Error('forced rollback result unavailable');
          return target.exec(sql);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const repository = createLoraRepository(database);
  const service = createLoraService({
    database,
    repository,
    mediaStorage: { remove() {} },
    cleanupQueue: { enqueue() {}, recordFailure() {} },
    vectorMaintenance: { prepare() {} }
  });
  try {
    failCommit = true;
    failRollback = true;
    assert.throws(() => inTransaction(database, () => {}), /ROLLBACK failed/u);
    assert.throws(() => service.list({}), /not serviceable/u);
    assert.throws(() => database.exec('INSERT INTO generation_base_models(name, created_at, updated_at) VALUES (\'later\', \'now\', \'now\')'), /not serviceable/u);
  } finally {
    database.close();
  }
});

test('Issue #276 R1.2 requires an explicit internal port before CLI network access', async () => {
  assert.equal(parseArguments([]).port, null);
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  let fetchCalls = 0;
  let helpOutput = '';
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected network access');
  };
  process.stdout.write = (chunk) => {
    helpOutput += String(chunk);
    return true;
  };
  try {
    await assert.rejects(
      runSemanticCli(['--path', '/internal/semantic/generation-loras']),
      (error) => error?.code === 'INVALID_ARGUMENT' && /--port/u.test(error.message)
    );
    await runSemanticCli(['--help']);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
  assert.equal(fetchCalls, 0);
  assert.match(helpOutput, /Live discovery requires an explicit --port value/u);
  assert.doesNotMatch(helpOutput, /default: 18093/u);
});

test('Issue #278 Catalog request branches use closed stable positive-integer string schemas', () => {
  const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
  const openapi = parseDocument(readFileSync(resolve(repositoryRoot, 'schema/api/openapi.yaml'), 'utf8'), { strict: true }).toJS();
  const stableIdSchema = (schema, label) => {
    assert.equal(schema.type, 'string', label);
    assert.equal(schema.minLength, 1, label);
    assert.equal(schema.maxLength, 20, label);
    assert.equal(schema.pattern, '^[1-9][0-9]{0,19}$', label);
  };
  const requestContracts = [
    {
      request: 'CatalogBaseModelRequest',
      search: 'CatalogBaseModelSearchRequest',
      resolve: 'CatalogBaseModelResolveRequest',
      searchFields: ['mode', 'query', 'page', 'page_size']
    },
    {
      request: 'CatalogGenerationModelRequest',
      search: 'CatalogGenerationModelSearchRequest',
      resolve: 'CatalogGenerationModelResolveRequest',
      searchFields: ['mode', 'query', 'page', 'page_size', 'base_model_id']
    }
  ];
  for (const contract of requestContracts) {
    const request = openapi.components.schemas[contract.request];
    const search = openapi.components.schemas[contract.search];
    const resolve = openapi.components.schemas[contract.resolve];
    assert.equal(request.type, 'object', contract.request);
    assert.equal(request.additionalProperties, undefined, contract.request);
    assert.equal(search.additionalProperties, false, contract.search);
    assert.equal(resolve.additionalProperties, false, contract.resolve);
    assert.deepEqual(Object.keys(search.properties), contract.searchFields, contract.search);
    assert.deepEqual(search.required, ['mode'], contract.search);
    assert.equal(search.properties.mode.const, 'search', contract.search);
    assert.equal(resolve.properties.mode.const, 'resolve', contract.resolve);
    assert.deepEqual(Object.keys(resolve.properties), ['mode', 'id'], contract.resolve);
    assert.deepEqual(resolve.required, ['mode', 'id'], contract.resolve);
    stableIdSchema(resolve.properties.id, `${contract.resolve}.id`);
    if (contract.searchFields.includes('base_model_id')) stableIdSchema(search.properties.base_model_id, `${contract.search}.base_model_id`);
  }

  for (const id of ['1', '12345678901234567890']) {
    assert.doesNotThrow(() => validateCatalogRequest({ mode: 'resolve', id }), id);
    assert.doesNotThrow(() => validateCatalogRequest({ mode: 'search', base_model_id: id }, { allowedSearchFields: ['base_model_id'] }), id);
  }
  for (const id of ['0', '01', '123456789012345678901', '-1', '1.0', 1]) {
    assert.throws(() => validateCatalogRequest({ mode: 'resolve', id }), /stable positive integer string/u, String(id));
    assert.throws(() => validateCatalogRequest({ mode: 'search', base_model_id: id }, { allowedSearchFields: ['base_model_id'] }), /stable positive integer string/u, String(id));
  }
  assert.throws(() => validateCatalogRequest({ mode: 'search', id: '1' }), /unknown field/u);
  assert.throws(() => validateCatalogRequest({ mode: 'resolve', id: '1', query: '' }), /unknown field/u);
});

test('Issue #276 R1.4 resource groups preserve each original query string while retrieval normalizes it', async () => {
  const database = openCatalogDatabase({ databasePath: ':memory:', includeBuiltinComfyuiCatalog: false });
  const now = '2026-08-22T00:00:00.000Z';
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (801, 'WAI', '${now}', '${now}');
    INSERT INTO generation_models(id, base_model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
      VALUES (811, 801, 'wai.safetensors', 'safetensors', 'fp16', 'wai model', 'wai model', '${now}', '${now}');
    INSERT INTO generation_loras(id, base_model_id, model_id, file_name, file_format, precision_or_quantization, description, usage, trigger_words_json, weight, created_at, updated_at)
      VALUES (821, 801, 811, 'wai-lora.safetensors', 'safetensors', 'fp16', 'wai lora', 'wai lora', '["wai"]', 1.0, '${now}', '${now}');
    INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id, created_at, updated_at)
      VALUES (831, 'WAI artist', 'wai artist', 'wai_artist:1.0', 801, '${now}', '${now}');
  `);
  const configuration = { embedding_model: 'r1', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 };
  for (const objectKind of ['generation_lora', 'artist_prompt_string']) {
    writeVectorSpaceConfiguration(database, objectKind, { embeddingModel: configuration.embedding_model, dimension: 1024 });
    upsertVectorEntry(database, objectKind, objectKind === 'generation_lora' ? 821 : 831, createFixtureVector(), { expectedModel: configuration.embedding_model });
  }
  const modelClient = {
    async embed(inputs) { return inputs.map(() => createFixtureVector()); },
    async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 })); }
  };
  try {
    const queries = ['  Ｂｌｕｅ Eyes  ', 'Second QUERY'];
    const lora = createGenerationLoraSemanticService({ database, modelClient, configuration });
    const artist = createArtistPromptStringSemanticService({ database, modelClient, configuration });
    assert.deepEqual((await lora.searchSkill({ base_model_name: 'WAI', queries })).groups.map(({ query }) => query), queries);
    assert.deepEqual((await artist.searchSkill({ base_model_name: 'WAI', queries })).groups.map(({ query }) => query), queries);
  } finally {
    database.close();
  }
});
