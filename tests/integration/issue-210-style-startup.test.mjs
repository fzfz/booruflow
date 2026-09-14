import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const NOW = '2026-08-06T00:00:00Z';
const INTERNAL_PORT = 19983;

function setEnvironment(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test('Issue #210 real local startup passes mediaRoot and completes legacy Style media migration', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'issue-210-style-startup-'));
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const databasePath = join(dataRoot, 'app.sqlite');
  const sourcePath = join(mediaRoot, 'images/legacy-startup.png');
  const restoreEnvironment = [setEnvironment('NOOBAI_INTERNAL_PORT', String(INTERNAL_PORT))];
  let application;
  try {
    await mkdir(join(mediaRoot, 'images'), { recursive: true });
    await writeFile(sourcePath, Buffer.from('legacy-startup-image'));
    runMediaCutover({ databasePath, mediaRoot, repositoryRoot });
    const database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (7, 'anima', ?, ?), (42, 'wai', ?, ?)").run(NOW, NOW, NOW, NOW);
    database.prepare(`INSERT INTO styles(
      id, source_id, source_version, name, name_normalized, aliases_json, prompt_text,
      style_description, is_available, created_at, updated_at, cover_media_path
    ) VALUES (713, 'startup-style', NULL, 'startup style', 'startup style', '[]', 'startup prompt', NULL, 1, ?, ?, NULL)`).run(NOW, NOW);
    database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (9713, 'style', 713, 'startup-image-hash', 'images/legacy-startup.png', 0, ?, ?)`).run(NOW, NOW);
    database.close();

    application = await startLocalApplication({
      repositoryRoot,
      dataPaths: { dataRoot, databasePath, mediaRoot },
      listenerMode: 'internal-only',
      vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
      vectorModelClient: createFakeSemanticModelClient(),
      authorizeWrite: () => false,
      onStarted: () => {}
    });
    assert.equal(application.publicAddress, null);
    assert.equal(application.internalAddress.port, INTERNAL_PORT);
    await application.close();
    application = null;

    const migrated = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(migrated.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name), [
        'id', 'base_model_id', 'name', 'aliases_json', 'prompt_text', 'style_description', 'cover_media_path'
      ]);
      assert.deepEqual(migrated.prepare('SELECT id, base_model_id, name FROM styles').all().map((row) => ({ ...row })), []);
      assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 1);
    } finally {
      migrated.close();
    }
    await assert.rejects(readFile(sourcePath));
  } finally {
    if (application) await application.close();
    for (const restore of [...restoreEnvironment].reverse()) restore();
    await rm(root, { recursive: true, force: true });
  }
});
