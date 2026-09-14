import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { createFixtureVector, FIXTURE_VECTOR_DIMENSION } from '../fixtures/vector/fake-semantic-model-client.mjs';
import { upsertVectorEntry } from '../../app/vector/vector-store.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const NOW = '2026-08-21T00:00:00.000Z';
const scripts = Object.freeze([
  Object.freeze({
    objectKind: 'generation_lora',
    script: 'scripts/maintenance/rebuild-generation-lora-vectors.mjs',
    validId: 1,
    failureId: 2,
    wrongDimensionId: 3
  }),
  Object.freeze({
    objectKind: 'artist_prompt_string',
    script: 'scripts/maintenance/rebuild-artist-prompt-string-vectors.mjs',
    validId: 11,
    failureId: 12,
    wrongDimensionId: 13
  })
]);

function modelWrapper(scriptPath, args, objectKind, { uncertain = false } = {}) {
  const databasePath = args[args.indexOf('--database') + 1];
  const mutateAfterOpen = !args.includes('--reset');
  return `
const { DatabaseSync } = await import('node:sqlite');
const databasePath = ${JSON.stringify(databasePath)};
const objectKind = ${JSON.stringify(objectKind)};
const mutateAfterOpen = ${JSON.stringify(mutateAfterOpen)};
const failureId = objectKind === 'generation_lora' ? 2 : 12;
const wrongDimensionId = objectKind === 'generation_lora' ? 3 : 13;
const uncertain = ${JSON.stringify(uncertain)};
const validEmbedding = ${JSON.stringify(createFixtureVector())};
const zeroEmbedding = new Array(${FIXTURE_VECTOR_DIMENSION}).fill(0);
const originalExec = DatabaseSync.prototype.exec;
const originalPrepare = DatabaseSync.prototype.prepare;
let migrated = false;
let uncertainSeen = false;
DatabaseSync.prototype.exec = function patchedExec(sql, ...parameters) {
  if (uncertainSeen) throw new Error('connection used after uncertain in exec');
  if (uncertain && sql === 'ROLLBACK;') {
    uncertainSeen = true;
    throw new Error('forced rollback failure');
  }
  const result = originalExec.call(this, sql, ...parameters);
  if (!migrated && mutateAfterOpen && sql.includes('PRAGMA trusted_schema = OFF')) {
    migrated = true;
    const database = new DatabaseSync(databasePath);
    database.prepare('DELETE FROM vector_entries WHERE object_kind = ? AND object_id = ?').run(objectKind, failureId);
    database.prepare('UPDATE vector_entries SET embedding_f32 = ? WHERE object_kind = ? AND object_id = ?')
      .run(Buffer.from(new Float32Array([1]).buffer), objectKind, wrongDimensionId);
    database.prepare('INSERT INTO vector_entries(object_kind, object_id, embedding_f32) VALUES (?, ?, ?)')
      .run(objectKind, 99, Buffer.from(new Float32Array(validEmbedding).buffer));
    if (uncertain) {
      database.exec("CREATE TRIGGER issue_275_cli_uncertain BEFORE INSERT ON vector_entries "
        + "WHEN NEW.object_kind = '" + objectKind + "' AND NEW.object_id = " + wrongDimensionId
        + " BEGIN SELECT RAISE(ABORT, 'forced vector write failure'); END;");
    }
    database.close();
  }
};
DatabaseSync.prototype.prepare = function patchedPrepare(...parameters) {
  if (uncertainSeen) throw new Error('connection used after uncertain in prepare');
  return originalPrepare.call(this, ...parameters);
};
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        data: body.input.map((input, index) => ({
          index,
          embedding: input.includes('fail-cli')
            || input.includes('reset-valid')
            || input.includes('reuse.safetensors')
            || input.includes('Reuse Artist')
            ? zeroEmbedding
            : validEmbedding
        }))
      };
    }
  };
};
process.env.NODE_ENV = 'test';
process.env.NOOBAI_TEST_EMPTY_COMFYUI_CATALOG = '1';
process.env.NOOBAI_EMBEDDING_BASE_URL = 'http://embedding.test/v1/';
process.env.NOOBAI_EMBEDDING_API_KEY = 'test-key';
process.env.NOOBAI_EMBEDDING_MODEL = 'fake';
process.env.NOOBAI_RERANKER_BASE_URL = 'http://reranker.test/v1/';
process.env.NOOBAI_RERANKER_API_KEY = 'test-key';
process.env.NOOBAI_RERANKER_MODEL = 'fake-reranker';
process.argv = ${JSON.stringify([process.execPath, scriptPath, ...args])};
await import(${JSON.stringify(scriptPath)});
`;
}

function runCli(scriptRelativePath, args, objectKind, options = {}) {
  const scriptPath = resolve(repositoryRoot, scriptRelativePath);
  return spawnSync(process.execPath, ['--input-type=module', '-e', modelWrapper(scriptPath, args, objectKind, options)], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
}

function createDatabase(t, objectKind, { resetFixture = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `issue-275-rebuild-cli-${objectKind}-`));
  const mediaRoot = join(root, 'media');
  const databasePath = join(root, 'catalog.sqlite');
  mkdirSync(mediaRoot, { recursive: true });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });

  const database = openCatalogDatabase({
    databasePath,
    mediaRoot,
    repositoryRoot,
    includeBuiltinComfyuiCatalog: false
  });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 40);
    database.prepare('UPDATE vector_spaces SET embedding_model = ?, dimension = ? WHERE object_kind = ?').run('fake', FIXTURE_VECTOR_DIMENSION, objectKind);
    if (objectKind === 'generation_lora') {
      database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (27501, ?, ?, ?)').run('issue-275-base', NOW, NOW);
      database.prepare(`INSERT INTO generation_models(
        id, base_model_id, file_name, file_format, precision_or_quantization,
        description, usage, created_at, updated_at
      ) VALUES (27502, 27501, 'issue-275-model.safetensors', 'safetensors', 'fp16', 'model', 'model usage', ?, ?)`).run(NOW, NOW);
      const insert = database.prepare(`INSERT INTO generation_loras(
        id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
        description, usage, trigger_words_json, weight, created_at, updated_at
      ) VALUES (?, 27501, 27502, ?, 'safetensors', 'fp16', ?, 'use this', ?, 1.0, ?, ?)`);
      insert.run(1, 'reuse.safetensors', 'reused lora', '[]', NOW, NOW);
      insert.run(2, 'fail-cli.safetensors', 'failed lora', '[]', NOW, NOW);
      insert.run(3, 'repair.safetensors', 'wrong dimension lora', '[]', NOW, NOW);
      for (const id of [1, 2, 3]) upsertVectorEntry(database, objectKind, id, createFixtureVector(), { expectedModel: 'fake' });
      if (resetFixture) database.prepare('UPDATE generation_loras SET file_name = ? WHERE id = 1').run('reset-valid.safetensors');
    } else {
      const insert = database.prepare(`INSERT INTO artist_prompt_strings(
        id, title, description, artist_string, base_model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)`);
      insert.run(11, 'Reuse Artist', 'reused artist', 'reuse_artist', NOW, NOW);
      insert.run(12, 'Fail Artist', 'fail-cli artist', 'fail_artist', NOW, NOW);
      insert.run(13, 'Repair Artist', 'wrong dimension artist', 'repair_artist', NOW, NOW);
      for (const id of [11, 12, 13]) upsertVectorEntry(database, objectKind, id, createFixtureVector(), { expectedModel: 'fake' });
      if (resetFixture) database.prepare('UPDATE artist_prompt_strings SET title = ? WHERE id = 11').run('reset-valid Artist');
    }
  } finally {
    database.close();
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { databasePath, mediaRoot };
}

function readTargetState(fixture, objectKind) {
  const database = new DatabaseSync(fixture.databasePath);
  try {
    return {
      space: { ...database.prepare('SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = ?').get(objectKind) },
      entries: database.prepare('SELECT object_id, length(embedding_f32) AS bytes FROM vector_entries WHERE object_kind = ? ORDER BY object_id').all(objectKind).map((row) => ({ ...row }))
    };
  } finally {
    database.close();
  }
}

for (const definition of scripts) {
  test(`${definition.objectKind} CLI reuses valid entries, repairs missing and wrong-dimension entries, records ordered failures, and removes orphans`, (t) => {
    const fixture = createDatabase(t, definition.objectKind);
    const result = runCli(definition.script, ['--database', fixture.databasePath, '--media-root', fixture.mediaRoot], definition.objectKind);
    assert.equal(result.status, 1, result.stderr);
    assert.notEqual(result.stdout, '', result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual({ object_kind: output.object_kind, completed: output.completed }, {
      object_kind: definition.objectKind,
      completed: [definition.validId, definition.wrongDimensionId]
    });
    assert.deepEqual(output.failures.map(({ object_id, error_code, message }) => ({ object_id, error_code, message })), [{
      object_id: definition.failureId,
      error_code: 'MODEL_PROTOCOL_ERROR',
      message: 'embedding response has a zero vector'
    }]);
    assert.equal(typeof output.rebuilt_at, 'string');
    assert.deepEqual(readTargetState(fixture, definition.objectKind), {
      space: { embedding_model: 'fake', dimension: FIXTURE_VECTOR_DIMENSION },
      entries: [
        { object_id: definition.validId, bytes: FIXTURE_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT },
        { object_id: definition.wrongDimensionId, bytes: FIXTURE_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT }
      ]
    });
  });

  test(`${definition.objectKind} CLI --reset rebuilds a previously reusable entry`, (t) => {
    const fixture = createDatabase(t, definition.objectKind, { resetFixture: true });
    const result = runCli(definition.script, ['--database', fixture.databasePath, '--media-root', fixture.mediaRoot, '--reset'], definition.objectKind);
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.completed, [definition.wrongDimensionId]);
    assert.deepEqual(output.failures.map(({ object_id, message }) => ({ object_id, message })), [
      { object_id: definition.validId, message: 'embedding response has a zero vector' },
      { object_id: definition.failureId, message: 'embedding response has a zero vector' }
    ]);
    assert.deepEqual(readTargetState(fixture, definition.objectKind).entries, [
      { object_id: definition.wrongDimensionId, bytes: FIXTURE_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT }
    ]);
  });

  test(`${definition.objectKind} CLI stops and closes after an UNCERTAIN vector transaction`, (t) => {
    const fixture = createDatabase(t, definition.objectKind);
    const result = runCli(definition.script, ['--database', fixture.databasePath, '--media-root', fixture.mediaRoot], definition.objectKind, { uncertain: true });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /transaction state uncertain/u);
    assert.doesNotMatch(result.stderr, /connection used after uncertain/u);
  });

  test(`${definition.objectKind} CLI accepts only the published arguments`, (t) => {
    const fixture = createDatabase(t, definition.objectKind);
    const result = runCli(definition.script, [
      '--database', fixture.databasePath,
      '--media-root', fixture.mediaRoot,
      '--unexpected-option'
    ], definition.objectKind);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: node scripts\/maintenance\/rebuild-/u);
    assert.deepEqual(readTargetState(fixture, definition.objectKind).entries, [
      { object_id: definition.validId, bytes: FIXTURE_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT },
      { object_id: definition.failureId, bytes: FIXTURE_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT },
      { object_id: definition.wrongDimensionId, bytes: FIXTURE_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT }
    ]);
  });
}

test('both generation-resource rebuild CLIs require --database and --media-root before opening a database', () => {
  for (const definition of scripts) {
    const missingBoth = runCli(definition.script, [], definition.objectKind);
    assert.notEqual(missingBoth.status, 0, definition.script);
    assert.match(missingBoth.stderr, /usage: node scripts\/maintenance\/rebuild-/u, definition.script);

    const missingMedia = runCli(definition.script, ['--database', '/tmp/issue-275-missing-media.sqlite'], definition.objectKind);
    assert.notEqual(missingMedia.status, 0, definition.script);
    assert.match(missingMedia.stderr, /--media-root <data\/media>/u, definition.script);
  }
});
