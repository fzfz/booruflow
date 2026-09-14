import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';

const ARTIST_WRITE = Object.freeze({
  title: 'Issue 73 artist',
  description: 'Issue 73 artist description',
  artist_string: 'issue_73_artist:1.0',
  base_model_id: null,
  style_ids: [3]
});

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-73-${operation}-${++requestSequence}`;
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-request-id': requestId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json(), requestId });
}

function assertSuccessEnvelope(result, expectedStatus) {
  assert.equal(result.status, expectedStatus);
  assert.deepEqual(Object.keys(result.body).sort(), ['data', 'ok', 'request_id']);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.request_id, result.requestId);
}

function assertErrorEnvelope(result, expectedStatus, expectedCode) {
  assert.equal(result.status, expectedStatus);
  assert.deepEqual(Object.keys(result.body).sort(), ['error', 'ok', 'request_id']);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.request_id, result.requestId);
  assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'message']);
  assert.equal(result.body.error.code, expectedCode);
}

function insertStyle(database, id, name) {
  database.prepare(`INSERT INTO styles(
    id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
  ) VALUES (?, 700, ?, '[]', ?, NULL, NULL)`)
    .run(id, name, `${name} prompt`);
}

function seedAdditionalStyles(app) {
  const database = new DatabaseSync(app.paths.database);
  insertStyle(database, 901, 'Issue 73 style one');
  insertStyle(database, 902, 'Issue 73 style two');
  return database;
}

function readStyleIds(database, artistId) {
  return database.prepare(`SELECT style_id
    FROM artist_prompt_string_styles
    WHERE artist_prompt_string_id = ?
    ORDER BY style_id`).all(artistId).map((row) => row.style_id);
}

async function createArtist(app, overrides = {}, operation = 'artist-create') {
  const result = await requestJson(app, 'POST', '/api/manage/artist-prompt-strings', {
    ...ARTIST_WRITE,
    ...overrides
  }, operation);
  assertSuccessEnvelope(result, 201);
  return result.body.data;
}

test('真实应用 HTTP 完成画师串 POST、GET、PUT CRUD，并完整替换 style_ids', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const database = seedAdditionalStyles(app);
  try {
    const created = await createArtist(app, {
      title: 'Issue 73 CRUD artist',
      style_ids: [3, 901]
    }, 'artist-crud-create');
    assert.equal(created.base_model_id, null);
    assert.deepEqual([...created.style_ids].sort((left, right) => left - right), [3, 901]);
    assert.deepEqual(readStyleIds(database, created.id), [3, 901]);

    const read = await requestJson(app, 'GET', `/api/manage/artist-prompt-strings/${created.id}`, undefined, 'artist-crud-get');
    assertSuccessEnvelope(read, 200);
    assert.equal(read.body.data.id, created.id);
    assert.equal(read.body.data.title, 'Issue 73 CRUD artist');
    assert.equal(read.body.data.base_model_id, null);
    assert.deepEqual([...read.body.data.style_ids].sort((left, right) => left - right), [3, 901]);

    const update = await requestJson(app, 'PUT', `/api/manage/artist-prompt-strings/${created.id}`, {
      ...ARTIST_WRITE,
      title: 'Issue 73 revised',
      description: 'Issue 73 updated description',
      artist_string: 'issue_73_updated_artist:1.0',
      base_model_id: null,
      style_ids: [902]
    }, 'artist-crud-update');
    assertSuccessEnvelope(update, 200);
    assert.equal(update.body.data.id, created.id);
    assert.equal(update.body.data.title, 'Issue 73 revised');
    assert.equal(update.body.data.description, 'Issue 73 updated description');
    assert.equal(update.body.data.artist_string, 'issue_73_updated_artist:1.0');
    assert.equal(update.body.data.base_model_id, null);
    assert.deepEqual(update.body.data.style_ids, [902]);
    assert.deepEqual(readStyleIds(database, created.id), [902]);

    const clearStyles = await requestJson(app, 'PUT', `/api/manage/artist-prompt-strings/${created.id}`, {
      ...ARTIST_WRITE,
      title: 'Issue 73 cleared',
      base_model_id: null,
      style_ids: []
    }, 'artist-crud-clear-styles');
    assertSuccessEnvelope(clearStyles, 200);
    assert.deepEqual(clearStyles.body.data.style_ids, []);
    assert.deepEqual(readStyleIds(database, created.id), []);
  } finally {
    database.close();
    await app.close();
  }
});

test('真实应用 HTTP 返回画师串列表的 page、page_size、total_count 和页间记录', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    await createArtist(app, { title: 'Issue 73 page one', style_ids: [] }, 'artist-page-create-one');
    await createArtist(app, { title: 'Issue 73 page two', style_ids: [] }, 'artist-page-create-two');

    const pageOne = await requestJson(app, 'GET', '/api/manage/artist-prompt-strings?page=1&page_size=1', undefined, 'artist-list-page-one');
    const pageTwo = await requestJson(app, 'GET', '/api/manage/artist-prompt-strings?page=2&page_size=1', undefined, 'artist-list-page-two');
    assertSuccessEnvelope(pageOne, 200);
    assertSuccessEnvelope(pageTwo, 200);
    assert.deepEqual({
      page: pageOne.body.data.page,
      page_size: pageOne.body.data.page_size,
      total_count: pageOne.body.data.total_count
    }, { page: 1, page_size: 1, total_count: 3 });
    assert.deepEqual({
      page: pageTwo.body.data.page,
      page_size: pageTwo.body.data.page_size,
      total_count: pageTwo.body.data.total_count
    }, { page: 2, page_size: 1, total_count: 3 });
    assert.equal(pageOne.body.data.items.length, 1);
    assert.equal(pageTwo.body.data.items.length, 1);
    assert.notEqual(pageOne.body.data.items[0].id, pageTwo.body.data.items[0].id);
    assert.ok(Array.isArray(pageOne.body.data.items[0].style_ids));
    assert.ok(Array.isArray(pageTwo.body.data.items[0].style_ids));
  } finally {
    await app.close();
  }
});

test('真实应用 HTTP 返回画师串删除影响并执行缺失、错误、正确 impact_token 确认，且保留 style 主记录', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const database = seedAdditionalStyles(app);
  try {
    database.prepare(`INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id)
      VALUES (805, 3), (805, 901)`).run();

    const impact = await requestJson(app, 'GET', '/api/manage/artist-prompt-strings/805/delete-impact', undefined, 'artist-delete-impact');
    assertSuccessEnvelope(impact, 200);
    assert.deepEqual(Object.keys(impact.body.data).sort(), ['cascade_deleted', 'impact_token', 'retained', 'target']);
    assert.equal(impact.body.data.target.id, 805);
    assert.ok(Array.isArray(impact.body.data.cascade_deleted));
    assert.ok(Array.isArray(impact.body.data.retained));
    assert.equal(typeof impact.body.data.impact_token, 'string');
    assert.notEqual(impact.body.data.impact_token.length, 0);

    const missingToken = await requestJson(app, 'DELETE', '/api/manage/artist-prompt-strings/805', undefined, 'artist-delete-missing-token');
    assertErrorEnvelope(missingToken, 422, 'VALIDATION_ERROR');

    const wrongToken = await requestJson(app, 'DELETE', '/api/manage/artist-prompt-strings/805', {
      impact_token: 'issue-73-wrong-impact-token'
    }, 'artist-delete-wrong-token');
    assertErrorEnvelope(wrongToken, 409, 'DELETE_IMPACT_STALE');

    const deleted = await requestJson(app, 'DELETE', '/api/manage/artist-prompt-strings/805', {
      impact_token: impact.body.data.impact_token
    }, 'artist-delete-confirmed');
    assertSuccessEnvelope(deleted, 200);
    assert.deepEqual(Object.keys(deleted.body.data).sort(), ['cascade_deleted', 'cleanup_failures', 'cleanup_warning', 'retained', 'target']);
    assert.equal(deleted.body.data.target.id, 805);
    assert.deepEqual(readStyleIds(database, 805), []);
    assert.deepEqual(database.prepare('SELECT id FROM styles WHERE id IN (3, 901) ORDER BY id').all().map((row) => row.id), [3, 901]);

    const missing = await requestJson(app, 'GET', '/api/manage/artist-prompt-strings/805', undefined, 'artist-get-after-delete');
    assertErrorEnvelope(missing, 404, 'NOT_FOUND');
  } finally {
    database.close();
    await app.close();
  }
});
