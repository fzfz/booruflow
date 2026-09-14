import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import {
  createCatalogImporter,
  createStyleDescriptionBatchImporter,
  scanUntrustedStrings,
  scanUntrustedText
} from '../../app/ingest/manual-ingest.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = () => new Date('2026-08-04T00:00:00.000Z');
const STYLE_BASE_MODEL_ID = 12901;
const configuration = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });
const modelClient = Object.freeze({ async embed(inputs) { return inputs.map(() => createFixtureVector()); } });

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'issue-129-style-description-importer-'));
  const database = openCatalogDatabase();
  const mediaRoot = join(root, 'media');
  database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
  database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, 'wai', ?, ?)").run(STYLE_BASE_MODEL_ID, NOW().toISOString(), NOW().toISOString());
  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const catalogImporter = createCatalogImporter({ database, mediaRoot, now: NOW, modelClient, configuration });
  return {
    database,
    importer: createStyleDescriptionBatchImporter({ database, catalogImporter, baseModelId: STYLE_BASE_MODEL_ID, now: NOW })
  };
}

function styleRecord(name, promptText = `${name} prompt`, styleDescription = `${name} description`) {
  return { name, aliases: [], prompt_text: promptText, style_description: styleDescription };
}

test('style-description rows commit independently and a later failure does not roll back earlier rows', async (t) => {
  const { database, importer } = createFixture(t);
  database.exec(`CREATE TRIGGER issue129_fail_second_style_insert
    BEFORE INSERT ON styles
      WHEN lower(NEW.name) = 'second style'
    BEGIN
      SELECT RAISE(ABORT, 'issue-129 forced second style insert failure');
    END;`);

  const first = await importer.importRecords([styleRecord('First Style')]);
  assert.equal(first[0].action, 'created');
  await assert.rejects(() => importer.importRecords([styleRecord('Second Style')]), /issue-129 forced second style insert failure/u);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM styles WHERE name = 'First Style'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style' AND object_id = (SELECT id FROM styles WHERE name = 'First Style')").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM styles WHERE name = 'Second Style'").get().count, 0);
});

test('existing Style identity and prompt survive import while aliases and description are updated', async (t) => {
  const { database, importer } = createFixture(t);
  database.prepare(`INSERT INTO styles(
    id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
  ) VALUES (12902, ?, ?, ?, ?, ?, NULL)`).run(
    STYLE_BASE_MODEL_ID,
    'Existing Style',
    '["legacy alias"]',
    'existing style prompt',
    '既有画风说明必须保留。'
  );

  const [result] = await importer.importRecords([{
    name: '  existing   style  ',
    aliases: ['Legacy Alias', 'New Alias'],
    prompt_text: 'existing style prompt',
    style_description: 'incoming description replaces the stored description.'
  }]);

  assert.equal(result.action, 'updated');
  const { base_model_id, name, aliases_json, style_description, prompt_text } = database.prepare(`SELECT base_model_id, name,
      aliases_json, style_description, prompt_text FROM styles`).get();
  assert.deepEqual(
    { base_model_id, name, aliases_json, style_description, prompt_text },
    {
      base_model_id: STYLE_BASE_MODEL_ID,
      name: 'Existing Style',
      aliases_json: '["legacy alias","New Alias"]',
      style_description: 'incoming description replaces the stored description.',
      prompt_text: 'existing style prompt'
    }
  );
});

test('new styles use the base-model identity while preserving the display name', async (t) => {
  const { database, importer } = createFixture(t);
  const [result] = await importer.importRecords([styleRecord('  ÉLAN   Studio  ')]);

  assert.equal(result.kind, 'style');
  const { base_model_id, name } = database.prepare('SELECT base_model_id, name FROM styles').get();
  assert.deepEqual(
    { base_model_id, name },
    { base_model_id: STYLE_BASE_MODEL_ID, name: 'ÉLAN Studio' }
  );
});

test('Style database identity keeps Foo and foo independent within one base model', async (t) => {
  const { database, importer } = createFixture(t);
  database.prepare(`INSERT INTO styles(
    id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
  ) VALUES (12903, ?, 'Foo', '[]', 'Foo prompt', 'Foo description', NULL),
    (12904, ?, 'foo', '[]', 'foo prompt', 'foo description', NULL)`).run(STYLE_BASE_MODEL_ID, STYLE_BASE_MODEL_ID);

  assert.equal(importer.inspectStyleMatch(styleRecord('Foo')).style.id, 12903);
  assert.equal(importer.inspectStyleMatch(styleRecord('foo')).style.id, 12904);
  assert.equal(importer.inspectStyleMatch(styleRecord('FOO')).matches.length, 0);

  const fooResult = await importer.importRecords([styleRecord('Foo', 'Foo prompt', 'Foo updated')]);
  const lowerFooResult = await importer.importRecords([styleRecord('foo', 'foo prompt', 'foo updated')]);
  assert.deepEqual([
    { id: fooResult[0].id, action: fooResult[0].action },
    { id: lowerFooResult[0].id, action: lowerFooResult[0].action }
  ], [
    { id: 12903, action: 'updated' },
    { id: 12904, action: 'updated' }
  ]);
  assert.deepEqual(database.prepare('SELECT id, name, style_description FROM styles WHERE id IN (12903, 12904) ORDER BY id').all().map((row) => ({ ...row })), [
    { id: 12903, name: 'Foo', style_description: 'Foo updated' },
    { id: 12904, name: 'foo', style_description: 'foo updated' }
  ]);
});

test('untrusted input scanning rejects executable and encoded markers without decoding or executing them', () => {
  const marker = '__issue129_untrusted_input_executed__';
  delete globalThis[marker];
  const executableText = `javascript:globalThis.${marker}=true`;
  const encodedText = 'data:text/javascript;base64,ZXZpbA==';
  const inputSnapshot = Object.freeze({ executableText, encodedText });

  assert.throws(() => scanUntrustedText(executableText), (error) => error.code === 'SCRIPT_CONTENT');
  assert.throws(() => scanUntrustedStrings({ payload: encodedText }), (error) => error.code === 'ENCODED_CONTENT');
  assert.equal(globalThis[marker], undefined);
  assert.deepEqual(inputSnapshot, { executableText, encodedText });
});
