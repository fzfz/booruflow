import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { ApplicationError } from '../../app/security/error-mapping.mjs';
import { createArtistPromptStringSemanticService } from '../../app/vector/artist-prompt-string-semantic.mjs';
import { createGenerationLoraSemanticService } from '../../app/vector/generation-lora-semantic.mjs';
import { deleteVectorEntry, upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-08-22T00:00:00.000Z';
const CONFIGURATION = Object.freeze({
  embedding_model: 'issue-276-query-model',
  reranker_candidate_limit: 20,
  reranker_min_relevance_score: 0
});

function seed(database) {
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES
      (801, 'WAI', '${NOW}', '${NOW}'),
      (802, 'ANIMA', '${NOW}', '${NOW}');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES
      (811, 801, 'wai-model.safetensors', 'safetensors', 'fp16', 'WAI model', 'WAI usage', '${NOW}', '${NOW}'),
      (812, 802, 'anima-model.safetensors', 'safetensors', 'fp16', 'ANIMA model', 'ANIMA usage', '${NOW}', '${NOW}'),
      (813, 801, 'wai-second-model.safetensors', 'safetensors', 'fp16', 'WAI second model', 'WAI second usage', '${NOW}', '${NOW}');
    INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES
      (821, 801, 811, 'wai-lora.safetensors', 'safetensors', 'fp16', 'WAI LoRA', 'WAI LoRA usage', '["wai_token"]', 0.8, '${NOW}', '${NOW}'),
      (822, 802, 812, 'anima-lora.safetensors', 'safetensors', 'fp16', 'ANIMA LoRA', 'ANIMA LoRA usage', '["anima_token"]', 1.0, '${NOW}', '${NOW}'),
      (823, 801, 813, 'wai-second-lora.safetensors', 'safetensors', 'fp16', 'WAI second LoRA', 'WAI second usage', '["wai_second_token"]', 0.9, '${NOW}', '${NOW}');
    INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES
      (901, 801, 'WAI style', '[]', 'wai style prompt', 'WAI style description', NULL),
      (902, 802, 'ANIMA style', '[]', 'anima style prompt', 'ANIMA style description', NULL);
    INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id, created_at, updated_at) VALUES
      (831, 'Global artist', 'global description', 'global_artist:1.0', NULL, '${NOW}', '${NOW}'),
      (832, 'WAI artist', 'WAI description', 'wai_artist:1.0', 801, '${NOW}', '${NOW}'),
      (833, 'ANIMA artist', 'ANIMA description', 'anima_artist:1.0', 802, '${NOW}', '${NOW}');
    INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id) VALUES
      (831, 902),
      (832, 902),
      (833, 902);
  `);
  for (const objectKind of ['generation_lora', 'artist_prompt_string']) {
    writeVectorSpaceConfiguration(database, objectKind, { embeddingModel: CONFIGURATION.embedding_model, dimension: 1024 });
  }
  upsertVectorEntry(database, 'generation_lora', 821, createFixtureVector(), { expectedModel: CONFIGURATION.embedding_model });
  upsertVectorEntry(database, 'generation_lora', 822, createFixtureVector(), { expectedModel: CONFIGURATION.embedding_model });
  upsertVectorEntry(database, 'generation_lora', 823, createFixtureVector(), { expectedModel: CONFIGURATION.embedding_model });
  upsertVectorEntry(database, 'artist_prompt_string', 831, createFixtureVector(), { expectedModel: CONFIGURATION.embedding_model });
  upsertVectorEntry(database, 'artist_prompt_string', 832, createFixtureVector(), { expectedModel: CONFIGURATION.embedding_model });
  upsertVectorEntry(database, 'artist_prompt_string', 833, createFixtureVector(), { expectedModel: CONFIGURATION.embedding_model });
}

function modelClient(calls) {
  return Object.freeze({
    async embed(inputs) {
      calls.push({ kind: 'embed', inputs: [...inputs] });
      return inputs.map(() => createFixtureVector());
    },
    async rerank(query, documents) {
      calls.push({ kind: 'rerank', query, documents: [...documents] });
      return documents.map((_document, index) => ({ index, relevance_score: 1 - index / 100 }));
    }
  });
}

function fixture() {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seed(database);
  const calls = [];
  return { database, calls, modelClient: modelClient(calls) };
}

test('Issue 276 internal resource semantic services filter exact relations and return closed CLI projections', async () => {
  const { database, calls, modelClient: client } = fixture();
  try {
    const lora = createGenerationLoraSemanticService({ database, modelClient: client, configuration: CONFIGURATION });
    const artist = createArtistPromptStringSemanticService({ database, modelClient: client, configuration: CONFIGURATION });

    const loraResult = await lora.searchSkill({ base_model_name: 'WAI', model_id: 811, queries: ['wai'], limit: 20 });
    assert.deepEqual(loraResult, {
      groups: [{
        query: 'wai',
        items: [{
          id: 821,
          base_model_id: 801,
          model_id: 811,
          model_file_name: 'wai-model.safetensors',
          file_name: 'wai-lora.safetensors',
          description: 'WAI LoRA',
          usage: 'WAI LoRA usage',
          trigger_words: ['wai_token'],
          weight: 0.8
        }]
      }]
    });

    const artistResult = await artist.searchSkill({ base_model_name: 'WAI', style_id: 902, queries: ['artist'], limit: 20 });
    assert.deepEqual(artistResult, {
      groups: [{
        query: 'artist',
        items: [{ id: 831, title: 'Global artist', description: 'global description', artist_string: 'global_artist:1.0', base_model_id: null, style_ids: [902] },
          { id: 832, title: 'WAI artist', description: 'WAI description', artist_string: 'wai_artist:1.0', base_model_id: 801, style_ids: [902] }]
      }]
    });
    assert.deepEqual(Object.keys(loraResult.groups[0].items[0]).sort(), ['base_model_id', 'description', 'file_name', 'id', 'model_file_name', 'model_id', 'trigger_words', 'usage', 'weight']);
    assert.deepEqual(Object.keys(artistResult.groups[0].items[0]).sort(), ['artist_string', 'base_model_id', 'description', 'id', 'style_ids', 'title']);
    assert.deepEqual(calls.filter(({ kind }) => kind === 'rerank').map(({ documents }) => documents), [
      ['wai-lora.safetensors\nwai_token\nWAI LoRA\nWAI LoRA usage'],
      ['Global artist\nglobal description\nglobal_artist:1.0', 'WAI artist\nWAI description\nwai_artist:1.0']
    ]);
  } finally {
    database.close();
  }
});

test('Issue 276 resource semantic request validation is bounded and relation checks run before model calls', async () => {
  const { database, calls, modelClient: client } = fixture();
  try {
    const lora = createGenerationLoraSemanticService({ database, modelClient: client, configuration: CONFIGURATION });
    const artist = createArtistPromptStringSemanticService({ database, modelClient: client, configuration: CONFIGURATION });
    for (const request of [
      { base_model_name: 'WAI', queries: [], limit: 1 },
      { base_model_name: 'WAI', queries: ['', 'ok'], limit: 1 },
      { base_model_name: 'WAI', queries: ['one', 'two', 'three', 'four'], limit: 1 },
      { base_model_name: 'WAI', queries: ['ok'], limit: 0 },
      { base_model_name: 'WAI', queries: ['ok'], limit: 21 },
      { base_model_name: 'WAI', queries: ['ok'], unexpected: true }
    ]) {
      await assert.rejects(() => lora.searchSkill(request), (error) => error instanceof ApplicationError && error.code === 'SEMANTIC_QUERY_VALIDATION');
    }
    for (const [service, request] of [
      [lora, { base_model_name: 'missing', queries: ['ok'] }],
      [lora, { base_model_name: 'WAI', model_id: 812, queries: ['ok'] }],
      [artist, { base_model_name: 'missing', queries: ['ok'] }],
      [artist, { base_model_name: 'WAI', style_id: 999, queries: ['ok'] }]
    ]) {
      await assert.rejects(() => service.searchSkill(request), (error) => error instanceof ApplicationError && error.code === 'SEMANTIC_QUERY_VALIDATION');
    }
    assert.deepEqual(calls, []);
  } finally {
    database.close();
  }
});

test('Issue 276 LoRA model_id filtering excludes another model under the same base model before reranking', async () => {
  const { database, calls, modelClient: client } = fixture();
  try {
    const lora = createGenerationLoraSemanticService({ database, modelClient: client, configuration: CONFIGURATION });
    const result = await lora.searchSkill({ base_model_name: 'WAI', model_id: 813, queries: ['wai'] });
    assert.deepEqual(result.groups[0].items.map(({ id }) => id), [823]);
    assert.deepEqual(calls.filter(({ kind }) => kind === 'rerank').at(-1).documents, ['wai-second-lora.safetensors\nwai_second_token\nWAI second LoRA\nWAI second usage']);
  } finally {
    database.close();
  }
});

test('Issue 276 resource semantic services preserve query order, default limit, empty candidates, and fixed model errors', async (t) => {
  const { database, calls } = fixture();
  try {
    const stableClient = modelClient(calls);
    const lora = createGenerationLoraSemanticService({ database, modelClient: stableClient, configuration: CONFIGURATION });
    const groups = await lora.searchSkill({ base_model_name: 'WAI', queries: ['one', 'two', 'three'] });
    assert.deepEqual(groups.groups.map(({ query }) => query), ['one', 'two', 'three']);
    deleteVectorEntry(database, 'generation_lora', 821);
    deleteVectorEntry(database, 'generation_lora', 823);
    assert.deepEqual((await lora.searchSkill({ base_model_name: 'WAI', queries: ['empty'] })).groups, [{ query: 'empty', items: [] }]);

    for (const code of ['EMBEDDING_UNAVAILABLE', 'MODEL_RATE_LIMITED', 'EMBEDDING_TIMEOUT', 'MODEL_PROTOCOL_ERROR']) {
      await t.test(code, async () => {
        const errorClient = {
          async embed() { throw new ApplicationError(code, `${code} fixture`); },
          async rerank() { throw new Error('reranker must not run'); }
        };
        const service = createGenerationLoraSemanticService({ database, modelClient: errorClient, configuration: CONFIGURATION });
        await assert.rejects(() => service.searchSkill({ base_model_name: 'WAI', queries: ['error'] }), (error) => error instanceof ApplicationError && error.code === code);
      });
    }

    database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__', dimension = 1 WHERE object_kind = 'artist_prompt_string'").run();
    const artist = createArtistPromptStringSemanticService({ database, modelClient: stableClient, configuration: CONFIGURATION });
    const callsBefore = calls.length;
    await assert.rejects(() => artist.searchSkill({ base_model_name: 'WAI', queries: ['not ready'] }), (error) => error instanceof ApplicationError && error.code === 'VECTOR_INDEX_NOT_READY');
    assert.equal(calls.length, callsBefore);
  } finally {
    database.close();
  }
});
