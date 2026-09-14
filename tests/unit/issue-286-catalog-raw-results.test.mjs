import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogService } from '../../app/catalog/catalog-service.mjs';

const repository = {
  getCatalogBaseModel: () => ({ id: 1, name: 'base' }),
  getCatalogGenerationModel: () => ({ id: 2, base_model_id: 1, file_name: 'model.safetensors', file_format: 'safetensors', precision_or_quantization: 'fp16', author: null, version: 'v1', release_url: null, published_at: null, description: 'model', usage: 'use', skill_name: null, cover_media_path: null }),
  getCatalogLora: () => ({ id: 3, base_model_id: 1, model_id: 2, file_name: 'lora.safetensors', file_format: 'safetensors', precision_or_quantization: 'fp16', author: null, version: 'v1', description: 'lora', usage: 'use', trigger_words_json: '["one"]', weight: 0.8, cover_media_path: null }),
  getCatalogWork: () => ({ id: 4, name: 'work', aliases_json: '["alias"]', category_name: 'category', cover_media_path: null, is_available: 1 }),
  getCatalogCharacter: () => ({ id: 5, work_id: 4, work_name: 'work', name: 'character', aliases_json: '[]', prompt_text: 'prompt', cover_media_path: null, is_available: 1, work_is_available: 1 }),
  getCatalogStyle: () => ({ id: 6, base_model_id: 1, name: 'style', aliases_json: '[]', prompt_text: 'prompt', style_description: 'description', cover_media_path: null }),
  getCatalogPromptTerm: () => ({ id: 7, canonical_tag: 'tag', aliases_json: '[]', category: 0, post_count: 1 }),
  getCatalogArtistPromptString: () => ({ id: 8, title: 'artist string', description: 'description', artist_string: 'artist', base_model_id: 1, cover_media_path: null, style_ids: [6] }),
  getCatalogComfyuiInstance: () => ({ id: 9, title: 'instance', is_enabled: 1, is_valid: 1 }),
  getCatalogComfyuiTemplate: () => ({ id: 10, base_model_id: 1, model_id: 2, lora_id: null, template_type: 'text_to_image', title: 'template', cover_media_path: null, workflow_json: '{"version":0.4}' }),
  listCatalogImagesByOwners: () => []
};

const database = { prepare: () => ({ all: () => [{ name: 'character' }] }) };
const service = createCatalogService({ database, repository, mediaOrigin: 'http://127.0.0.1:18082', mediaPublicPrefix: '/media' });

test('Issue 286 all Catalog resolve results keep database names and types without protocol or duplicate fields', async () => {
  const operations = [
    'querySemanticBaseModelsForSkill', 'querySemanticGenerationModelsForSkill', 'querySemanticLorasForSkill',
    'querySemanticWorksForSkill', 'querySemanticCharactersForSkill', 'querySemanticStylesForSkill',
    'querySemanticPromptTermsForSkill', 'querySemanticArtistPromptStringsForSkill',
    'querySemanticComfyuiInstancesForSkill', 'querySemanticComfyuiTemplatesForSkill'
  ];
  for (const operation of operations) {
    const response = await service[operation]({ mode: 'resolve', id: '1' });
    assert.deepEqual(Object.keys(response), ['status', 'message', 'results', 'page', 'page_size', 'total_count'], operation);
    assert.equal(response.status, 'ok', operation);
    assert.equal(response.results.length, 1, operation);
    const result = response.results[0];
    assert.equal(typeof result.id, 'number', operation);
    assert.equal(Object.values(result).some((value) => value !== null && typeof value === 'object' && !Array.isArray(value)), operation === 'querySemanticComfyuiTemplatesForSkill', operation);
  }
});
