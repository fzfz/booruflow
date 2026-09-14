import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/test-browser-launch-options.mjs';
import { assertManagementModal } from './management-modal-assertions.mjs';

const UI_TIMEOUT = 2_500;
const FIXTURE_ARTIST_ID = 805;
const ARTIST_WRITE = Object.freeze({
  title: 'Issue 73 UI Artist',
  description: 'Issue 73 artist description',
  artist_string: 'issue_73_artist:1.0',
  base_model_id: null,
  style_ids: [3, 901]
});

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-73-artist-e2e-${operation}-${++requestSequence}`;
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
  database.close();
}

async function createArtist(app, overrides = {}, operation = 'setup-create') {
  const result = await requestJson(app, 'POST', '/api/manage/artist-prompt-strings', {
    ...ARTIST_WRITE,
    ...overrides
  }, operation);
  assert.equal(result.status, 201, `creating artist: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.ok, true);
  return result.body.data;
}

async function openManagementPage(app) {
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const response = await page.goto(`${app.baseUrl}/manage/artist-prompt-strings`, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  return Object.freeze({ browser, context, page });
}

async function artistList(page) {
  const list = page.locator('#artist-list');
  await list.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await list.getAttribute('aria-label'), '画师串列表');
  return list;
}

function artistCard(list, title) {
  return list.locator('.manage-card').filter({ hasText: title });
}

async function artistDrawer(page) {
  const drawer = page.locator('#artist-editor');
  await drawer.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await drawer.count(), 1);
  await assertManagementModal(drawer);
  return drawer;
}

async function waitForEditorReady(page, drawer) {
  const saveButton = drawer.locator('#artist-editor-submit');
  const element = await saveButton.elementHandle();
  assert.ok(element);
  await page.waitForFunction((button) => button.disabled === false, element, { timeout: UI_TIMEOUT });
}

function apiResponse(page, app, pathname, method, predicate = () => true) {
  const expectedPath = new URL(pathname, app.baseUrl).pathname;
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === new URL(app.baseUrl).origin
      && url.pathname === expectedPath
      && response.request().method() === method
      && predicate(url);
  });
}

function apiRequest(page, app, pathname, method) {
  const expectedPath = new URL(pathname, app.baseUrl).pathname;
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.origin === new URL(app.baseUrl).origin && url.pathname === expectedPath && request.method() === method;
  });
}

async function fillArtistForm(drawer, { title, description, artistString, styleIds }) {
  await drawer.locator('[name="title"]').fill(title);
  await drawer.locator('[name="description"]').fill(description);
  await drawer.locator('[name="artist_string"]').fill(artistString);
  await drawer.locator('[name="base_model_id"]').selectOption('');
  const trigger = drawer.locator('#artist-style-trigger');
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  const desired = new Set(styleIds.map(String));
  const selectedButtons = drawer.locator('#artist-style-selected [data-action="remove-artist-style"]');
  const selectedIds = await selectedButtons.evaluateAll((buttons) => buttons.map((button) => button.dataset.styleId));
  for (const styleId of selectedIds) {
    if (!desired.has(styleId)) {
      await drawer.locator(`#artist-style-selected [data-action="remove-artist-style"][data-style-id="${styleId}"]`).click();
    }
  }
  for (const styleId of desired) {
    if (await drawer.locator(`#artist-style-selected [data-style-id="${styleId}"]`).count() === 0) {
      await drawer.locator(`#artist-style-options [data-style-id="${styleId}"]`).click();
    }
  }
  assert.equal(await drawer.locator('#artist-style-selected [data-action="remove-artist-style"]').count(), desired.size);
}

async function artistMedia(app, artistId) {
  const result = await requestJson(app, 'GET', `/api/items/artist_prompt_string/${artistId}/images`, undefined, 'media-read');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.owner_kind, 'artist_prompt_string');
  assert.equal(result.body.data.owner_id, artistId);
  return result.body.data;
}

async function assertRenderedMediaImages(app, page, drawer) {
  const images = drawer.locator('[data-media-image]');
  await images.first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  const sources = await images.evaluateAll((elements) => elements.map((element) => element.currentSrc || element.src));
  assert.ok(sources.length > 0);
  const baseUrl = new URL(app.baseUrl);
  for (const source of sources) {
    const mediaUrl = new URL(source, app.baseUrl);
    assert.equal(mediaUrl.origin, baseUrl.origin);
    assert.ok(mediaUrl.pathname.startsWith('/media/'), `media image URL is outside the application media path: ${source}`);
    const response = await fetch(mediaUrl);
    assert.equal(response.status, 200, `media response failed for ${source}`);
    assert.match(response.headers.get('content-type') ?? '', /^image\//u);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }

  const drawerElement = await drawer.elementHandle();
  assert.ok(drawerElement);
  await page.waitForFunction((element) => {
    const mediaImages = [...element.querySelectorAll('[data-media-image]')];
    return mediaImages.length > 0 && mediaImages.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, drawerElement, { timeout: UI_TIMEOUT });
}

test('管理页面真实浏览器覆盖画师串列表、创建后编辑、可空底模和完整 style_ids 更新', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    seedAdditionalStyles(app);
    ({ browser, context, page } = await openManagementPage(app));
    const list = await artistList(page);
    const fixtureCard = artistCard(list, 'Fixture artist');
    await fixtureCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 1);

    await page.getByRole('button', { name: '新增画师串' }).click();
    const drawer = await artistDrawer(page);
    assert.equal(await drawer.locator('#artist-media-section').isVisible(), true);
    await fillArtistForm(drawer, {
      title: ARTIST_WRITE.title,
      description: ARTIST_WRITE.description,
      artistString: ARTIST_WRITE.artist_string,
      styleIds: ARTIST_WRITE.style_ids
    });
    assert.equal(await drawer.locator('[name="base_model_id"]').inputValue(), '');
    assert.deepEqual(await drawer.locator('[name="style_ids"] option:checked').evaluateAll((options) => options.map((option) => Number(option.value))), [3, 901]);

    const createRequestPromise = apiRequest(page, app, '/api/manage/artist-prompt-strings', 'POST');
    const createResponsePromise = apiResponse(page, app, '/api/manage/artist-prompt-strings', 'POST');
    await drawer.locator('#artist-editor-submit').click();
    const [createRequest, createResponse] = await Promise.all([createRequestPromise, createResponsePromise]);
    assert.equal(createResponse.status(), 201);
    const createdBody = await createResponse.json();
    assert.equal(createdBody.ok, true);
    const createdId = Number(createdBody.data.id);
    assert.ok(Number.isInteger(createdId) && createdId > 0);
    assert.deepEqual(createRequest.postDataJSON(), ARTIST_WRITE);
    await waitForEditorReady(page, drawer);
    assert.equal(await drawer.locator('#artist-media-section').isVisible(), true);
    assert.equal(await drawer.getByRole('button', { name: '更换封面' }).isVisible(), true);
    assert.equal(await drawer.getByRole('button', { name: '管理图片' }).isVisible(), true);
    await page.locator('[data-action="close-artist-editor"]').click();

    const search = page.locator('#artist-search');
    const creationFilterResponsePromise = apiResponse(page, app, '/api/manage/artist-prompt-strings', 'GET', (url) => url.searchParams.get('q') === ARTIST_WRITE.title);
    await search.fill(ARTIST_WRITE.title);
    await page.locator('#artist-filter-form').getByRole('button', { name: '搜索' }).click();
    assert.equal((await creationFilterResponsePromise).status(), 200);
    const createdCard = artistCard(list, ARTIST_WRITE.title);
    await createdCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    const readResponsePromise = apiResponse(page, app, `/api/manage/artist-prompt-strings/${createdId}`, 'GET');
    await createdCard.getByRole('button', { name: /详情|编辑/u }).click();
    assert.equal((await readResponsePromise).status(), 200);
    const readDrawer = await artistDrawer(page);
    await waitForEditorReady(page, readDrawer);
    assert.equal(await readDrawer.locator('[name="title"]').inputValue(), ARTIST_WRITE.title);
    assert.equal(await readDrawer.locator('[name="base_model_id"]').inputValue(), '');
    assert.deepEqual(await readDrawer.locator('[name="style_ids"] option:checked').evaluateAll((options) => options.map((option) => Number(option.value))), [3, 901]);

    const updatedTitle = 'Issue 73 UI Revised';
    const updatedDescription = 'Issue 73 updated description';
    const updatedArtistString = 'issue_73_updated_artist:1.0';
    await fillArtistForm(readDrawer, {
      title: updatedTitle,
      description: updatedDescription,
      artistString: updatedArtistString,
      styleIds: [902]
    });
    const updateRequestPromise = apiRequest(page, app, `/api/manage/artist-prompt-strings/${createdId}`, 'PUT');
    const updateResponsePromise = apiResponse(page, app, `/api/manage/artist-prompt-strings/${createdId}`, 'PUT');
    await readDrawer.locator('#artist-editor-submit').click();
    const [updateRequest, updateResponse] = await Promise.all([updateRequestPromise, updateResponsePromise]);
    assert.equal(updateResponse.status(), 200);
    const updateBody = await updateResponse.json();
    assert.equal(updateBody.data.id, createdId);
    assert.deepEqual(updateRequest.postDataJSON(), {
      title: updatedTitle,
      description: updatedDescription,
      artist_string: updatedArtistString,
      base_model_id: null,
      style_ids: [902]
    });
    const updatedRead = await requestJson(app, 'GET', `/api/manage/artist-prompt-strings/${createdId}`, undefined, 'crud-read-after-update');
    assert.equal(updatedRead.status, 200);
    assert.equal(updatedRead.body.data.base_model_id, null);
    assert.deepEqual(updatedRead.body.data.style_ids, [902]);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面真实浏览器覆盖画师串图片显示、上传、设封面和按图片 id 删除', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await artistList(page);
    const fixtureCard = artistCard(list, 'Fixture artist');
    await fixtureCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    const readResponsePromise = apiResponse(page, app, `/api/manage/artist-prompt-strings/${FIXTURE_ARTIST_ID}`, 'GET');
    await fixtureCard.getByRole('button', { name: /详情|编辑/u }).click();
    assert.equal((await readResponsePromise).status(), 200);
    const drawer = await artistDrawer(page);
    await waitForEditorReady(page, drawer);
    const initial = await artistMedia(app, FIXTURE_ARTIST_ID);
    assert.deepEqual(initial.images, []);
    assert.equal(initial.cover_media_path, null);
    assert.equal(await drawer.locator('#artist-media-section').isVisible(), true);

    const fixtureBytes = await readFile(app.uploadFixture);
    const upload = drawer.locator('#artist-image-upload');
    const uploadResponsePromise = apiResponse(page, app, `/api/items/artist_prompt_string/${FIXTURE_ARTIST_ID}/images`, 'POST');
    await upload.setInputFiles([
      { name: 'issue-73-artist-first.png', mimeType: 'image/png', buffer: fixtureBytes },
      { name: 'issue-73-artist-second.png', mimeType: 'image/png', buffer: fixtureBytes }
    ]);
    const uploadResponse = await uploadResponsePromise;
    assert.equal(uploadResponse.status(), 201);
    await drawer.getByRole('button', { name: '管理图片' }).click();
    const manager = page.locator('#artist-image-manager');
    await manager.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await manager.locator('.image-manager-card').count(), 2);
    assert.equal(await manager.getByRole('button', { name: '添加图片' }).count(), 2);
    await assertRenderedMediaImages(app, page, manager);

    const uploaded = await artistMedia(app, FIXTURE_ARTIST_ID);
    assert.equal(uploaded.images.length, 2);
    const [firstImage, secondImage] = uploaded.images;
    const coverButton = manager.getByRole('button', { name: '设为封面' }).first();
    assert.equal(Number(await coverButton.getAttribute('data-image-id')), firstImage.id);
    const coverResponsePromise = apiResponse(page, app, `/api/items/artist_prompt_string/${FIXTURE_ARTIST_ID}/cover`, 'PUT');
    await coverButton.click();
    const coverResponse = await coverResponsePromise;
    assert.equal(coverResponse.status(), 200);
    const covered = await artistMedia(app, FIXTURE_ARTIST_ID);
    assert.equal(covered.cover_media_path, firstImage.media_path);
    assert.equal(await manager.locator('.image-manager-card.is-cover').count(), 1);
    assert.match(await manager.locator('.image-manager-card.is-cover').textContent(), /当前封面/u);

    const deletedRow = manager.locator(`.image-manager-card:has([data-action="delete-artist-image"][data-image-id="${secondImage.id}"])`);
    assert.equal(await deletedRow.count(), 1);
    const deleteDialog = page.locator('#artist-image-delete');
    const deleteResponsePromise = apiResponse(page, app, `/api/items/artist_prompt_string/${FIXTURE_ARTIST_ID}/images/${secondImage.id}`, 'DELETE');
    await deletedRow.getByRole('button', { name: '删除' }).click();
    await deleteDialog.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await deleteDialog.getByRole('button', { name: '确认删除' }).click();
    const deleteResponse = await deleteResponsePromise;
    assert.equal(deleteResponse.status(), 200);
    await Promise.all([
      deleteDialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT }),
      deletedRow.waitFor({ state: 'detached', timeout: UI_TIMEOUT })
    ]);
    const afterDelete = await artistMedia(app, FIXTURE_ARTIST_ID);
    assert.deepEqual(afterDelete.images.map(({ id }) => id), [firstImage.id]);
    assert.equal(afterDelete.cover_media_path, firstImage.media_path);
    await assertRenderedMediaImages(app, page, drawer);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});
