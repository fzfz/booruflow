import { upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createFixtureVector, FIXTURE_VECTOR_DIMENSION } from './vector/fake-semantic-model-client.mjs';

const now = '2026-08-05T00:00:00.000Z';
const fixtureEmbeddingModel = 'vector-schema-fixture-embedding';

export function seedDatabase(database) {
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES
      (2201, 'Vector schema fixture base', '${now}', '${now}');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, skill_name, created_at, updated_at
    ) VALUES
      (22011, 2201, 'vector-schema-fixture.safetensors', 'safetensors', 'fp16', 'vector schema fixture', 'vector schema fixture', 'wai-sdxl-prompt-builder', '${now}', '${now}');
    INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
      VALUES (22011, 'Vector schema fixture work', 'vector schema fixture work', '["vector schema fixture work"]', 1, '${now}', '${now}');
    INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
      VALUES (22012, 22011, 'amber', 'amber', '["amber"]', 'amber_character', 1, '${now}', '${now}');
    INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
      VALUES (22013, 2201, 'Vector schema fixture style', '["vector schema fixture style"]', 'vector_schema_fixture_style', NULL, NULL);
  `);
  for (const objectKind of ['work', 'character', 'style', 'prompt_term']) {
    writeVectorSpaceConfiguration(database, objectKind, { embeddingModel: fixtureEmbeddingModel, dimension: FIXTURE_VECTOR_DIMENSION });
  }
  for (const [objectKind, objectId] of [['work', 22011], ['character', 22012], ['style', 22013]]) {
    upsertVectorEntry(database, objectKind, objectId, createFixtureVector(), { expectedModel: fixtureEmbeddingModel });
  }
}
