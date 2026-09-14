import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { createCatalogRepository } from '../../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../../app/catalog/catalog-service.mjs';
import { createCatalogHttpDispatcher } from '../../../app/http/catalog-http.mjs';
import { createErrorMapper } from '../../../app/security/error-mapping.mjs';

const NOW = '2026-07-30T00:00:00Z';

function fixture() {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Manage fixture base', NOW, NOW);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, cover_media_path, is_available, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(1, 'Arc', 'arc', '[]', 'images/arc.png', 1, NOW, NOW);
  database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, cover_media_path, is_available, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(2, 1, 'Keeper', 'keeper', '[]', 'ink', 'images/keeper.png', 1, NOW, NOW);
  database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
    VALUES (?, 1, ?, ?, ?, NULL, ?)`).run(3, 'Arc Style', '[]', 'paper', null);
  database.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(11, 'work', 1, 'hash-11', 'images/arc.png', 0, NOW, NOW);
  database.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(12, 'character', 2, 'hash-12', 'images/keeper.png', 4, NOW, NOW);
  const repository = createCatalogRepository(database);
  const service = createCatalogService({ database, repository });
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper() });
  return { database, service, dispatcher };
}

test('management catalog returns a bounded stable projection with total-count pages', () => {
  const { database, service } = fixture();
  try {
    const first = service.listManageItems({ kind: 'all', query: '', limit: 2, page: 1 });
    assert.deepEqual(first.items, [
      { kind: 'work', id: 1, name: 'Arc', work_name: null, aliases: [], prompt_text: null, style_description: null, category_name: null, base_model_id: null, base_model_name: null, cover_media_path: 'images/arc.png', image_count: 1, is_available: true },
      { kind: 'style', id: 3, name: 'Arc Style', work_name: null, aliases: [], prompt_text: 'paper', style_description: null, category_name: null, base_model_id: 1, base_model_name: 'Manage fixture base', cover_media_path: null, image_count: 0, is_available: true }
    ]);
    assert.equal(first.items.length, 2);
    assert.deepEqual({ total_count: first.total_count, page: first.page, page_size: first.page_size }, { total_count: 3, page: 1, page_size: 2 });
    const second = service.listManageItems({ kind: 'all', query: '', limit: 2, page: 2 });
    assert.deepEqual(second.items.map(({ kind, id }) => `${kind}:${id}`), ['character:2']);
    assert.deepEqual({ total_count: second.total_count, page: second.page, page_size: second.page_size }, { total_count: 3, page: 2, page_size: 2 });
  } finally {
    database.close();
  }
});

test('management page validates page number and reports the same total for normalized search', () => {
  const { database, service, dispatcher } = fixture();
  try {
    const first = service.listManageItems({ kind: 'all', query: ' ARC ', limit: 1, page: 1 });
    assert.deepEqual(first.items.map(({ kind, id }) => `${kind}:${id}`), ['work:1']);
    assert.equal(first.total_count, 3);
    assert.throws(() => service.listManageItems({ kind: 'all', query: 'arc', limit: 1, page: 0 }), (error) => error.code === 'VALIDATION_ERROR');
    const invalid = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/manage/items?kind=all&limit=1&page=0', requestId: 'invalid-page' });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.request_id, 'invalid-page');
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
    assert.equal(Object.hasOwn(invalid.body, 'data'), false);
    const valid = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/manage/items?kind=all&limit=1', requestId: 'valid-list' });
    assert.equal(valid.status, 200);
    assert.equal(Array.isArray(valid.body.data.items), true);
    assert.deepEqual({ total_count: valid.body.data.total_count, page: valid.body.data.page, page_size: valid.body.data.page_size }, { total_count: 3, page: 1, page_size: 1 });
  } finally {
    database.close();
  }
});

test('management catalog searches related work names and applies base-model and availability filters', () => {
  const { database, service } = fixture();
  try {
    assert.deepEqual(service.listManageItems({ kind: 'character', query: 'arc', limit: 16, page: 1 }).items.map(({ id }) => id), [2]);
    assert.deepEqual(service.listManageItems({ kind: 'all', query: '', limit: 16, page: 1, base_model_id: 1 }).items.map(({ kind, id }) => `${kind}:${id}`), ['style:3']);
    assert.equal(service.listManageItems({ kind: 'all', query: '', limit: 16, page: 1, availability: 'available' }).total_count, 3);
    assert.equal(service.listManageItems({ kind: 'all', query: '', limit: 16, page: 1, availability: 'unavailable' }).total_count, 0);
  } finally {
    database.close();
  }
});

test('management catalog returns an empty page and rejects out-of-range limits', () => {
  const { database, service, dispatcher } = fixture();
  try {
    assert.deepEqual(service.listManageItems({ kind: 'style', query: 'missing', limit: 30, page: 1 }), { items: [], total_count: 0, page: 1, page_size: 30 });
    assert.throws(() => service.listManageItems({ kind: 'all', query: '', limit: 101, page: 1 }), (error) => error.code === 'VALIDATION_ERROR');
    const invalid = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/manage/items?limit=101', requestId: 'invalid-limit' });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  } finally {
    database.close();
  }
});

test('management detail returns a database snapshot without changing stored media paths', () => {
  const { database, service } = fixture();
  try {
    assert.deepEqual(service.getManageItemDetail('work', 1), {
      kind: 'work',
      id: 1,
      name: 'Arc',
      work_id: null,
      work_name: null,
      aliases: [],
      prompt_text: null,
      style_description: null,
      category_name: null,
      base_model_id: null,
      base_model_name: null,
      cover_media_path: 'images/arc.png',
      image_count: 1,
      is_available: true,
      created_at: NOW,
      updated_at: NOW,
      images: [{ id: 11, media_path: 'images/arc.png', sort_order: 0 }],
      characters: [{ id: 2, name: 'Keeper', cover_media_path: 'images/keeper.png', is_available: true }]
    });
  } finally {
    database.close();
  }
});
