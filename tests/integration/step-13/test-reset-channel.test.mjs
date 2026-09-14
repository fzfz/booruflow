import assert from 'node:assert/strict';
import { access, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { startTestApp } from '../../../scripts/testing/start-test-app.mjs';
import { createFixtureVector, FIXTURE_VECTOR_DIMENSION } from '../../fixtures/vector/fake-semantic-model-client.mjs';
import { upsertVectorEntry } from '../../../app/vector/vector-store.mjs';

const resetToken = 'issue-9-reset-token';

async function deleteSeedWork(baseUrl) {
  const response = await fetch(`${baseUrl}/api/items/batch-delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': 'issue-9-delete-seed' },
    body: JSON.stringify({ items: [{ kind: 'work', id: 1 }] })
  });
  assert.equal(response.status, 200);
}

test('共享重置通道独立于业务 API，只在测试模式、回环地址和令牌下开放', async () => {
  const app = await startTestApp({ testMode: true, resetToken });
  try {
    assert.equal(app.testMode, true);
    assert.match(app.resetUrl, /^http:\/\/127\.0\.0\.1:\d+\/[^/]/u);
    assert.equal(new URL(app.resetUrl).hostname, '127.0.0.1');
    assert.equal(new URL(app.resetUrl).pathname.startsWith('/api/'), false);

    const missingToken = await fetch(app.resetUrl, { method: 'POST' });
    assert.ok([401, 403].includes(missingToken.status), `缺少令牌应拒绝，实际为 ${missingToken.status}`);

    const wrongToken = await fetch(app.resetUrl, {
      method: 'POST',
      headers: { 'x-noobai-test-reset-token': 'wrong-token' }
    });
    assert.ok([401, 403].includes(wrongToken.status), `错误令牌应拒绝，实际为 ${wrongToken.status}`);

    const accepted = await fetch(app.resetUrl, {
      method: 'POST',
      headers: { 'x-noobai-test-reset-token': resetToken }
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).reset, true);
  } finally {
    await app.close();
  }
});

test('共享重置恢复数据库和媒体且复用同一个真实应用进程', async () => {
  const app = await startTestApp({ testMode: true, resetToken });
  const processId = app.processId;
  const marker = join(app.root, 'catalog', 'media', 'should-be-removed.txt');
  try {
    await deleteSeedWork(app.baseUrl);
    await writeFile(marker, 'temporary test mutation', { flag: 'wx' });

    const resetResult = await app.reset();
    assert.equal(resetResult.status, 200);
    assert.equal(app.processId, processId, '重置不得重新启动真实应用');

    const works = await fetch(`${app.baseUrl}/api/works`, { headers: { 'x-request-id': 'issue-9-after-reset' } });
    assert.equal(works.status, 200);
    assert.equal((await works.json()).data.items.length, 1);
    await assert.rejects(access(marker), /ENOENT/u);
    assert.ok((await readdir(app.paths.media)).length > 0, '重置必须恢复共享媒体样本');
  } finally {
    await app.close();
  }
});

test('共享重置按七字段 Style 的外键依赖清理向量、媒体和画师串引用且可幂等重复执行', async () => {
  const app = await startTestApp({ testMode: true, resetToken });
  const timestamp = '2026-08-06T00:00:00Z';
  const styleMedia = join(app.paths.media, 'images', 'reset-style.png');
  try {
    const database = openCatalogDatabase({ databasePath: app.paths.database, mediaRoot: app.paths.media });
    try {
      database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (701, ?, ?, ?)').run('reset-style-base', timestamp, timestamp);
      database.prepare('INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (10, 701, ?, ?, ?, ?, NULL)')
        .run('重置画风', '[]', 'reset style prompt', 'reset style description');
      database.prepare("UPDATE vector_spaces SET embedding_model = 'reset-test-model', dimension = ? WHERE object_kind IN ('style', 'artist_prompt_string')").run(FIXTURE_VECTOR_DIMENSION);
      upsertVectorEntry(database, 'style', 10, createFixtureVector(), { expectedModel: 'reset-test-model' });
      database.prepare(`INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id, created_at, updated_at)
        VALUES (51, 'reset artist', 'reset artist description', 'reset_artist:1', 701, ?, ?)`).run(timestamp, timestamp);
      upsertVectorEntry(database, 'artist_prompt_string', 51, createFixtureVector(), { expectedModel: 'reset-test-model' });
      database.prepare('INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id) VALUES (51, 10)').run();
      database.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at)
        VALUES (52, 'style', 10, 'reset-style-hash', 'images/reset-style.png', 0, ?, ?)`).run(timestamp, timestamp);
    } finally {
      database.close();
    }
    await writeFile(styleMedia, 'temporary style media', { flag: 'wx' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resetResult = await app.reset();
      assert.equal(resetResult.status, 200);
      const check = openCatalogDatabase({ databasePath: app.paths.database, mediaRoot: app.paths.media });
      try {
        assert.equal(check.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.deepEqual(check.prepare('PRAGMA table_info(styles)').all().map((column) => column.name), [
          'id', 'base_model_id', 'name', 'aliases_json', 'prompt_text', 'style_description', 'cover_media_path'
        ]);
        assert.equal(check.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 10').get().count, 0);
        assert.equal(check.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style'").get().count, 0);
        assert.equal(check.prepare('SELECT COUNT(*) AS count FROM artist_prompt_string_styles').get().count, 0);
        assert.equal(check.prepare("SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = 'style'").get().count, 0);
        assert.equal(check.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 701').get().count, 0);
        assert.equal(check.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 3').get().count, 1);
      } finally {
        check.close();
      }
      await assert.rejects(access(styleMedia), /ENOENT/u);
    }
  } finally {
    await app.close();
  }
});

test('共享重置失败和清理失败向调用方传播，并保留可核对的临时根状态', async () => {
  let app;
  try {
    app = await startTestApp({ testMode: true, resetToken });
    await assert.rejects(() => app.reset({ failStage: 'reset' }), /reset/u);
    await assert.rejects(() => app.close({ failStage: 'cleanup' }), /cleanup|清理/u);
  } finally {
    if (app) await app.close().catch(() => {});
  }
});
