import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { createCatalogRepository } from '../../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../../app/catalog/catalog-service.mjs';
import { createCatalogHttpDispatcher } from '../../../app/http/catalog-http.mjs';
import { createErrorMapper } from '../../../app/security/error-mapping.mjs';
import { normalizeSearchText } from '../../../app/security/input-validation.mjs';

const NOW = '2026-08-01T00:00:00Z';

function fixture() {
  const database = openCatalogDatabase();
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Catalog pagination base', NOW, NOW);
  for (const [id, name] of [[1, 'Amber Archive'], [2, 'Brass Archive'], [3, 'Cedar Archive']]) {
    database.prepare('INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(id, name, name.toLocaleLowerCase('und'), '[]', NOW, NOW);
  }
  database.prepare('INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (4, ?, ?, ?, 0, ?, ?)')
    .run('Aardvark Archive', 'aardvark archive', '[]', NOW, NOW);
  database.prepare('INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (11, 1, ?, ?, ?, ?, 1, ?, ?)')
    .run('Amber Keeper', 'amber keeper', '[]', 'amber ink', NOW, NOW);
  database.prepare('INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (12, 1, ?, ?, ?, ?, 1, ?, ?)')
    .run('Amber Reader', 'amber reader', '[]', 'amber paper', NOW, NOW);
  database.prepare('INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (21, 1, ?, ?, ?, NULL, NULL)')
    .run('Amber Style', '[]', 'amber wash');
  const service = createCatalogService({ database, repository: createCatalogRepository(database) });
  return { database, dispatcher: createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper() }) };
}

test('公开目录 HTTP 接缝按当前类型、查询条件和作品范围返回有界游标页', () => {
  const { database, dispatcher } = fixture();
  try {
    const first = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/works?q=archive&limit=2', requestId: 'home-page-1' });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data.items.map((item) => item.name), ['Amber Archive', 'Brass Archive']);
    assert.equal(typeof first.body.data.next_cursor, 'string');

    const second = dispatcher.dispatch({ listener: 'public', method: 'GET', url: `/api/works?q=archive&limit=2&cursor=${encodeURIComponent(first.body.data.next_cursor)}`, requestId: 'home-page-2' });
    assert.deepEqual(second.body.data.items.map((item) => item.name), ['Cedar Archive']);
    assert.equal(second.body.data.next_cursor, null);

    const characters = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/works/1/characters?q=reader&limit=1', requestId: 'home-work-characters' });
    assert.deepEqual(characters.body.data.items.map(({ id, work_id }) => ({ id, work_id })), [{ id: 12, work_id: 1 }]);
    assert.equal(characters.body.data.next_cursor, null);

    const invalidCursor = dispatcher.dispatch({ listener: 'public', method: 'GET', url: `/api/styles?q=amber&cursor=${encodeURIComponent(first.body.data.next_cursor)}`, requestId: 'home-invalid-cursor' });
    assert.equal(invalidCursor.status, 400);
    assert.equal(invalidCursor.body.error.code, 'INVALID_CURSOR');

    const invalidLimit = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/works?limit=101', requestId: 'home-invalid-limit' });
    assert.equal(invalidLimit.status, 422);
    assert.equal(invalidLimit.body.error.code, 'VALIDATION_ERROR');
  } finally {
    database.close();
  }
});

test('公开目录游标对三种目录使用与持久化键完全相同的 NFKC 空白折叠键', () => {
  const database = openCatalogDatabase();
  const now = '2026-08-05T00:00:00Z';
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Cursor base', now, now);
  const insertWork = database.prepare('INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)');
  for (const [id, name] of [[101, '  Ａ   Work  '], [102, '  Ｂ   Work  '], [103, '  Ｃ   Work  ']]) {
    insertWork.run(id, name, normalizeSearchText(name), '[]', now, now);
  }
  const insertCharacter = database.prepare('INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (?, 101, ?, ?, ?, ?, 1, ?, ?)');
  for (const [id, name] of [[201, '  Ａ   Keeper  '], [202, '  Ｂ   Keeper  '], [203, '  Ｃ   Keeper  ']]) {
    insertCharacter.run(id, name, normalizeSearchText(name), '[]', `${name} prompt`, now, now);
  }
  const insertStyle = database.prepare('INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (?, 1, ?, ?, ?, NULL, NULL)');
  for (const [id, name] of [[301, '  Ａ   Style  '], [302, '  Ｂ   Style  '], [303, '  Ｃ   Style  ']]) {
    insertStyle.run(id, name, '[]', `${name} prompt`);
  }
  const repository = createCatalogRepository(database);
  const collectIds = (kind, workId = null) => {
    const ids = [];
    let cursor = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = repository.listPublicCatalog({ kind, query: '', workId, limit: 1, cursor });
      ids.push(...page.items.map(({ id }) => id));
      if (page.next_cursor === null) return ids;
      cursor = page.next_cursor;
    }
    throw new Error(`${kind} pagination did not terminate`);
  };
  try {
    assert.deepEqual(collectIds('work'), [101, 102, 103]);
    assert.deepEqual(collectIds('character', 101), [201, 202, 203]);
    assert.deepEqual(collectIds('style'), [301, 302, 303]);
  } finally {
    database.close();
  }
});

test('管理目录搜索保留 works/characters 的 name_normalized 语义并使用同一折叠键', () => {
  const database = openCatalogDatabase();
  const now = '2026-08-05T00:00:00Z';
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Manage cursor base', now, now);
  database.prepare('INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (101, ?, ?, ?, 1, ?, ?)')
    .run('  Ａ   Work  ', normalizeSearchText('  Ａ   Work  '), '[]', now, now);
  database.prepare('INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (102, ?, ?, ?, 1, ?, ?)')
    .run('  Ｂ   Work  ', normalizeSearchText('  Ｂ   Work  '), '[]', now, now);
  database.prepare('INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (201, 101, ?, ?, ?, ?, 1, ?, ?)')
    .run('  Ｂ   Keeper  ', normalizeSearchText('  Ｂ   Keeper  '), '[]', 'keeper prompt', now, now);
  database.prepare('INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (301, 1, ?, ?, ?, NULL, NULL)')
    .run('  Ａ   Style  ', '[]', 'style prompt');
  const service = createCatalogService({ database, repository: createCatalogRepository(database) });
  try {
    assert.deepEqual(service.listManageItems({ kind: 'work', query: 'Ａ   Work', limit: 10, page: 1 }).items.map(({ id }) => id), [101]);
    assert.deepEqual(service.listManageItems({ kind: 'character', query: 'Ｂ Keeper', limit: 10, page: 1 }).items.map(({ id }) => id), [201]);
    assert.deepEqual(service.listManageItems({ kind: 'style', query: 'Ａ Style', limit: 10, page: 1 }).items.map(({ id }) => id), [301]);
  } finally {
    database.close();
  }
});
