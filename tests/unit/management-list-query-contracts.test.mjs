import assert from 'node:assert/strict';
import test from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createModelRepository } from '../../app/generation-resources/model-repository.mjs';
import { createLoraRepository } from '../../app/generation-resources/lora-repository.mjs';
import { createArtistPromptStringRepository } from '../../app/generation-resources/artist-prompt-string-repository.mjs';
import { createComfyuiInstanceRepository } from '../../app/generation-resources/comfyui-instance-repository.mjs';
import { createComfyuiTemplateRepository } from '../../app/generation-resources/comfyui-template-repository.mjs';

const NOW = '2026-08-31T00:00:00.000Z';

function fixture() {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('anima', NOW, NOW);
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (2, ?, ?, ?)').run('wai', NOW, NOW);
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization, author, version,
    description, usage, skill_name, created_at, updated_at
  ) VALUES (10, 1, 'portrait.safetensors', 'safetensors', 'fp16', 'Studio Aurora', 'v2',
    'soft window portrait', 'character rendering', 'portrait-anima', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization, author, version,
    description, usage, skill_name, created_at, updated_at
  ) VALUES (11, 2, 'illustration.gguf', 'gguf', 'int8', 'Studio B', 'v1',
    'flat illustration', 'general rendering', 'illustration-wai', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO generation_loras(
    id, base_model_id, model_id, file_name, file_format, precision_or_quantization, author, version,
    description, usage, trigger_words_json, weight, created_at, updated_at
  ) VALUES (20, 1, 10, 'rim-light.safetensors', 'safetensors', 'fp16', 'Creator A', 'v3',
    'cinematic rim lighting', 'portrait enhancement', '["edge glow","night portrait"]', 0.7, ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description)
    VALUES (30, 1, 'Watercolor', '[]', 'watercolor', 'transparent pigment')`).run();
  database.prepare(`INSERT INTO artist_prompt_strings(
    id, title, description, artist_string, base_model_id, created_at, updated_at
  ) VALUES (40, 'Azure group', 'stable color relationships', 'artist:blue archive', 1, ?, ?)`).run(NOW, NOW);
  database.prepare('INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id) VALUES (40, 30)').run();
  database.prepare(`INSERT INTO comfyui_instances(
    id, title, url, credential_type, credential_ciphertext, is_enabled, is_valid, created_at, updated_at
  ) VALUES (50, 'Local workstation', 'http://192.168.1.50:8188', 'bearer', 'encrypted', 1, 1, ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO comfyui_templates(
    id, base_model_id, model_id, lora_id, template_type, title, template_json, created_at, updated_at
  ) VALUES (60, 1, 10, 20, 'text_to_image_lora', 'Portrait workflow',
    '{"nodes":[{"type":"KSampler","inputs":{"marker":"workflow needle"}}]}', ?, ?)`).run(NOW, NOW);
  return database;
}

test('model and LoRA lists search every product field and combine ecosystem file filters', () => {
  const database = fixture();
  try {
    const models = createModelRepository(database);
    const modelPage = models.list({ page: 1, page_size: 16, q: 'Aurora', base_model_id: 1, file_format: 'safetensors', precision_or_quantization: 'fp16' });
    assert.equal(modelPage.total_count, 1);
    assert.equal(modelPage.items[0].base_model_name, 'anima');
    assert.equal(models.list({ page: 1, page_size: 16, q: 'portrait-anima', base_model_id: 2, file_format: 'safetensors', precision_or_quantization: 'fp16' }).total_count, 0);

    const loras = createLoraRepository(database);
    const loraPage = loras.list({ page: 1, page_size: 16, q: 'night portrait', base_model_id: 1, model_id: 10, file_format: 'safetensors', precision_or_quantization: 'fp16' });
    assert.equal(loraPage.total_count, 1);
    assert.equal(loraPage.items[0].base_model_name, 'anima');
    assert.equal(loraPage.items[0].model_name, 'portrait.safetensors');
    assert.equal(loras.list({ page: 1, page_size: 16, q: 'night portrait', base_model_id: 1, model_id: 11, file_format: 'safetensors', precision_or_quantization: 'fp16' }).total_count, 0);
  } finally {
    database.close();
  }
});

test('artist, ComfyUI instance and template lists search product fields and apply their filters', () => {
  const database = fixture();
  try {
    const artists = createArtistPromptStringRepository(database);
    const artistPage = artists.list({ page: 1, page_size: 16, q: 'blue archive', base_model_id: 1, style_id: 30 });
    assert.equal(artistPage.total_count, 1);
    assert.equal(artistPage.items[0].base_model_name, 'anima');

    const instances = createComfyuiInstanceRepository(database);
    assert.equal(instances.list({ page: 1, page_size: 16, q: '192.168.1.50', credential_type: 'bearer', is_valid: true, is_enabled: true }).total_count, 1);
    assert.equal(instances.list({ page: 1, page_size: 16, q: '192.168.1.50', credential_type: 'none', is_valid: true, is_enabled: true }).total_count, 0);

    const templates = createComfyuiTemplateRepository(database);
    const templatePage = templates.list({ page: 1, page_size: 16, q: 'workflow needle', base_model_id: 1, model_id: 10, lora_id: 20, template_type: 'text_to_image_lora' });
    assert.equal(templatePage.total_count, 1);
    assert.equal(templatePage.items[0].base_model_name, 'anima');
    assert.equal(templatePage.items[0].model_name, 'portrait.safetensors');
    assert.equal(templatePage.items[0].lora_name, 'rim-light.safetensors');
    assert.equal(templates.list({ page: 1, page_size: 16, q: 'workflow needle', base_model_id: 1, model_id: 10, lora_id: 20, template_type: 'text_to_image' }).total_count, 0);
  } finally {
    database.close();
  }
});
