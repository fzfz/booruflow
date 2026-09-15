import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/testing/test-browser-launch-options.mjs';

const MODEL_UI_TIMEOUT = 2_500;
const MODEL_WRITE = Object.freeze({
  base_model_id: 801,
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  author: null,
  version: null,
  release_url: null,
  published_at: null,
  description: 'Issue 71 E2E model description',
  usage: 'Issue 71 E2E model usage',
  skill_name: null
});
let requestSequence = 0;

async function requestJson(app, method, pathname, body) {
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-request-id': `issue-71-e2e-${++requestSequence}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

async function createModel(app, fileName, overrides = {}) {
  const result = await requestJson(app, 'POST', '/api/manage/models', { ...MODEL_WRITE, file_name: fileName, ...overrides });
  assert.equal(result.status, 201, `creating ${fileName}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.ok, true);
  return result.body.data;
}

async function openManagementPage(app) {
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const response = await page.goto(`${app.baseUrl}/manage/models`, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  return Object.freeze({ browser, context, page });
}

async function closeBrowser(browser, context) {
  await context.close();
  await browser.close();
}

async function modelResourceCounts(app) {
  const listed = await requestJson(app, 'GET', '/api/manage/models?page=1&page_size=100');
  assert.equal(listed.status, 200);
  const database = new DatabaseSync(app.paths.database);
  try {
    return Object.freeze({
      model_count: listed.body.data.total_count,
      model_media_count: database.prepare("SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = 'model'").get().count
    });
  } finally {
    database.close();
  }
}

async function assertRenderedMediaImages(app, page, drawer) {
  const images = drawer.locator('[data-media-image]');
  await images.first().waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
  const sources = await images.evaluateAll((elements) => elements.map((element) => element.currentSrc || element.src));
  assert.ok(sources.length > 0);
  const baseUrl = new URL(app.baseUrl);
  const allowedProtocols = new Set(['http:', 'https:']);
  assert.ok(allowedProtocols.has(baseUrl.protocol), `app base URL uses an unsupported protocol: ${baseUrl.protocol}`);
  for (const source of sources) {
    const mediaUrl = new URL(source, app.baseUrl);
    assert.ok(typeof source === 'string' && source.trim() !== '', 'media image source must not be empty');
    assert.ok(allowedProtocols.has(mediaUrl.protocol), `media image URL uses an unsupported protocol: ${source}`);
    assert.equal(mediaUrl.protocol, baseUrl.protocol, `media image URL protocol does not match the app: ${source}`);
    assert.equal(mediaUrl.origin, baseUrl.origin, `media image URL origin is outside the app: ${source}`);
    assert.ok(mediaUrl.pathname.startsWith('/media/'), `media image URL is outside the application media path: ${source}`);

    const response = await fetch(mediaUrl);
    assert.equal(response.status, 200, `media response failed for ${source}`);
    assert.match(response.headers.get('content-type') ?? '', /^image\//u, `media response is not an image for ${source}`);
    assert.ok((await response.arrayBuffer()).byteLength > 0, `media response is empty for ${source}`);
  }

  const drawerElement = await drawer.elementHandle();
  assert.ok(drawerElement);
  await page.waitForFunction((element) => {
    const mediaImages = [...element.querySelectorAll('[data-media-image]')];
    return mediaImages.length > 0 && mediaImages.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, drawerElement, { timeout: MODEL_UI_TIMEOUT });
  const decoded = await images.evaluateAll((elements) => elements.map((element) => ({ complete: element.complete, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight })));
  assert.ok(decoded.every(({ complete, naturalWidth, naturalHeight }) => complete && naturalWidth > 0 && naturalHeight > 0));
}

async function modelList(page) {
  const list = page.getByRole('region', { name: '文生图模型列表' });
  await list.waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
  return list;
}

function modelCard(list, fileName) {
  return list.locator('.manage-card').filter({ hasText: fileName });
}

async function modelDrawer(page) {
  const drawer = page.locator('#model-editor');
  await drawer.waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
  assert.equal(await drawer.count(), 1);
  return drawer;
}

async function fillModelForm(drawer, { fileName, description = MODEL_WRITE.description } = {}) {
  await drawer.locator('[name="base_model_id"]').selectOption('801');
  await drawer.locator('[name="file_name"]').fill(fileName);
  await drawer.locator('[name="file_format"]').fill('safetensors');
  await drawer.locator('[name="precision_or_quantization"]').fill('fp16');
  await drawer.locator('[name="description"]').fill(description);
  await drawer.locator('[name="usage"]').fill(MODEL_WRITE.usage);
}

async function visibleAlert(drawer) {
  const alert = drawer.locator('[role="alert"]:visible').first();
  await alert.waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
  return (await alert.textContent())?.trim() ?? '';
}

async function deleteImageRow(app, page, manager, modelId, index) {
  const indexedRow = manager.locator('.image-manager-card').nth(index);
  const imageId = Number(await indexedRow.getByRole('button', { name: '删除' }).getAttribute('data-image-id'));
  assert.ok(Number.isInteger(imageId) && imageId > 0, `imageId must be a positive integer: ${imageId}`);
  const rowSelector = `.image-manager-card:has([data-action="delete-model-image"][data-image-id="${imageId}"])`;
  const row = manager.locator(rowSelector);
  assert.equal(await row.count(), 1, `expected one row for imageId ${imageId}`);
  const deleteDialog = page.locator('#model-image-delete');
  await row.getByRole('button', { name: '删除' }).click();
  await deleteDialog.waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
  assert.equal(await deleteDialog.count(), 1);
  const confirmButton = deleteDialog.getByRole('button', { name: '确认删除' });
  await confirmButton.waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
  await confirmButton.click();
  await Promise.all([
    deleteDialog.waitFor({ state: 'hidden', timeout: MODEL_UI_TIMEOUT }),
    row.waitFor({ state: 'detached', timeout: MODEL_UI_TIMEOUT })
  ]);
  const deleted = await requestJson(app, 'GET', `/api/items/model/${modelId}/images`);
  assert.equal(deleted.status, 200);
  assert.ok(deleted.body.data.images.every(({ id }) => id !== imageId), `deleted imageId ${imageId} is still persisted`);
  return imageId;
}

test('真实应用 HTTP 覆盖模型 CRUD、底模关联、分页边界和过期删除影响', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const created = await createModel(app, 'issue-71-http-model.safetensors');
    assert.equal(created.base_model_id, 801);

    const duplicate = await requestJson(app, 'POST', '/api/manage/models', { ...MODEL_WRITE, file_name: created.file_name });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'DUPLICATE_RESOURCE');

    const invalidBase = await requestJson(app, 'POST', '/api/manage/models', { ...MODEL_WRITE, base_model_id: 999999, file_name: 'issue-71-invalid-base.safetensors' });
    assert.equal(invalidBase.status, 409);
    assert.equal(invalidBase.body.error.code, 'RELATION_CONFLICT');

    const pageOne = await requestJson(app, 'GET', '/api/manage/models?page=1&page_size=1');
    const pageTwo = await requestJson(app, 'GET', '/api/manage/models?page=2&page_size=1');
    const invalidPage = await requestJson(app, 'GET', '/api/manage/models?page=0&page_size=1');
    assert.equal(pageOne.status, 200);
    assert.equal(pageTwo.status, 200);
    assert.equal(pageOne.body.data.page, 1);
    assert.equal(pageTwo.body.data.page, 2);
    assert.equal(pageOne.body.data.page_size, 1);
    assert.equal(pageOne.body.data.total_count, 2);
    assert.equal(pageTwo.body.data.total_count, 2);
    assert.equal(invalidPage.status, 422);
    assert.equal(invalidPage.body.error.code, 'VALIDATION_ERROR');

    const impact = await requestJson(app, 'GET', `/api/manage/models/${created.id}/delete-impact`);
    assert.equal(impact.status, 200);
    const updated = await requestJson(app, 'PUT', `/api/manage/models/${created.id}`, { ...MODEL_WRITE, file_name: 'issue-71-http-model-updated.safetensors' });
    assert.equal(updated.status, 200);
    const staleDelete = await requestJson(app, 'DELETE', `/api/manage/models/${created.id}`, { impact_token: impact.body.data.impact_token });
    assert.equal(staleDelete.status, 409);
    assert.equal(staleDelete.body.error.code, 'DELETE_IMPACT_STALE');

    const currentImpact = await requestJson(app, 'GET', `/api/manage/models/${created.id}/delete-impact`);
    const deleted = await requestJson(app, 'DELETE', `/api/manage/models/${created.id}`, { impact_token: currentImpact.body.data.impact_token });
    assert.equal(deleted.status, 200);
    const missing = await requestJson(app, 'GET', `/api/manage/models/${created.id}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('管理页面真实浏览器覆盖模型列表、底模关联和页码分页边界', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    for (let index = 0; index < 20; index += 1) await createModel(app, `issue-71-page-${String(index).padStart(2, '0')}.safetensors`);
    ({ browser, context, page } = await openManagementPage(app));
    const list = await modelList(page);
    assert.equal(await list.locator('.manage-card').count(), 16);
    assert.match(await list.textContent(), /fixture-model\.safetensors/u);

    const pagination = page.getByRole('navigation', { name: '文生图模型分页' });
    assert.equal(await pagination.getByRole('button', { name: '上一页' }).isDisabled(), true);
    assert.equal(await pagination.getByRole('button', { name: '下一页' }).isDisabled(), false);
    await pagination.getByRole('button', { name: '下一页' }).click();
    await pagination.getByText('第 2 页', { exact: true }).waitFor();
    assert.equal(await list.locator('.manage-card').count(), 5);
    assert.match(await list.textContent(), /issue-71-page-19\.safetensors/u);
    assert.equal(await pagination.getByRole('button', { name: '下一页' }).isDisabled(), true);
  } finally {
    if (browser) await closeBrowser(browser, context);
    await app.close();
  }
});

test('管理页面真实浏览器覆盖模型 CRUD、创建后同一抽屉编辑、重复失败和删除取消确认', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await modelList(page);
    await page.getByRole('button', { name: '新增模型' }).click();
    const drawer = await modelDrawer(page);
    const creationDrawerElement = await drawer.elementHandle();
    assert.ok(creationDrawerElement);
    const createTitle = await drawer.locator('h2').textContent();
    await fillModelForm(drawer, { fileName: 'issue-71-ui-model.safetensors' });
    const createResponsePromise = page.waitForResponse((response) => response.url() === new URL('/api/manage/models', app.baseUrl).href && response.request().method() === 'POST');
    await drawer.locator('#model-editor-submit').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201);
    const createBody = await createResponse.json();
    assert.equal(createBody.ok, true);
    await drawer.locator('[name="file_name"]').waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
    assert.equal(await drawer.isVisible(), true);
    assert.equal(await drawer.evaluate((node, expected) => node === expected, creationDrawerElement), true);
    assert.equal(await creationDrawerElement.evaluate((node) => node.isConnected), true);
    assert.notEqual(await drawer.locator('h2').textContent(), createTitle);
    assert.equal(await drawer.getByRole('button', { name: '更换封面' }).isVisible(), true);
    assert.equal(await drawer.getByRole('button', { name: '管理图片' }).isVisible(), true);
    const createdModelId = Number(createBody.data.id);
    const createImageResponsePromise = page.waitForResponse((response) => response.url() === new URL(`/api/items/model/${createdModelId}/images`, app.baseUrl).href && response.request().method() === 'POST');
    await drawer.locator('#model-image-upload').setInputFiles(app.uploadFixture);
    const createImageResponse = await createImageResponsePromise;
    assert.equal(createImageResponse.status(), 201);
    await drawer.locator('#model-image-list [data-media-image]').first().waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
    await assertRenderedMediaImages(app, page, drawer);

    const createdCard = modelCard(list, 'issue-71-ui-model.safetensors');
    await createdCard.waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
    const modelId = Number(await createdCard.getAttribute('data-id'));
    assert.equal(modelId, createdModelId);
    const detail = await requestJson(app, 'GET', `/api/manage/models/${modelId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.base_model_id, 801);

    await drawer.locator('[name="description"]').fill('Issue 71 updated description');
    await drawer.locator('#model-editor-submit').click();
    const updated = await requestJson(app, 'GET', `/api/manage/models/${modelId}`);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.description, 'Issue 71 updated description');

    await page.locator('[data-action="close-model-editor"]').click();
    const beforeDuplicate = await modelResourceCounts(app);
    await page.getByRole('button', { name: '新增模型' }).click();
    const duplicateDrawer = await modelDrawer(page);
    await fillModelForm(duplicateDrawer, { fileName: 'fixture-model.safetensors' });
    const duplicateResponsePromise = page.waitForResponse((response) => response.url() === new URL('/api/manage/models', app.baseUrl).href && response.request().method() === 'POST');
    await duplicateDrawer.locator('#model-editor-submit').click();
    const duplicateResponse = await duplicateResponsePromise;
    assert.equal(duplicateResponse.status(), 409);
    const duplicateBody = await duplicateResponse.json();
    assert.equal(duplicateBody.ok, false);
    assert.equal(duplicateBody.error.code, 'DUPLICATE_RESOURCE');
    assert.equal(duplicateBody.error.message, 'generation model identity already exists');
    assert.match(await visibleAlert(duplicateDrawer), /模型.*(?:已存在|重复)/u);
    assert.equal(await duplicateDrawer.isVisible(), true);
    assert.deepEqual(await modelResourceCounts(app), beforeDuplicate);
    await duplicateDrawer.locator('[data-action="close-model-editor"]').click();

    const fixtureCard = modelCard(list, 'fixture-model.safetensors');
    const deleteImpactResponsePromise = page.waitForResponse((response) => response.url() === new URL('/api/manage/models/802/delete-impact', app.baseUrl).href && response.request().method() === 'GET');
    await fixtureCard.getByRole('button', { name: '编辑' }).click();
    const fixtureDrawer = await modelDrawer(page);
    await fixtureDrawer.locator('#model-editor-submit').waitFor({ state: 'visible' });
    await fixtureDrawer.locator('#model-editor-delete').click();
    const deleteImpactResponse = await deleteImpactResponsePromise;
    assert.equal(deleteImpactResponse.status(), 200);
    const deleteDialog = page.getByRole('dialog').filter({ hasText: /级联删除/u });
    await deleteDialog.waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
    assert.equal(await deleteDialog.count(), 1);
    assert.match(await deleteDialog.textContent(), /fixture-lora\.safetensors/u);
    assert.match(await deleteDialog.textContent(), /Fixture template/u);
    assert.match(await deleteDialog.textContent(), /images\/fixture-model\.png/u);
    await deleteDialog.getByRole('button', { name: '取消' }).click();
    assert.equal(await modelCard(list, 'fixture-model.safetensors').count(), 1);

    await fixtureDrawer.locator('#model-editor-delete').click();
    const confirmDialog = page.getByRole('dialog').filter({ hasText: /级联删除/u });
    assert.equal(await confirmDialog.count(), 1);
    await confirmDialog.getByRole('button', { name: '确认删除' }).click();
    await modelCard(list, 'fixture-model.safetensors').waitFor({ state: 'detached', timeout: MODEL_UI_TIMEOUT });
    const deletedDetail = await requestJson(app, 'GET', '/api/manage/models/802');
    assert.equal(deletedDetail.status, 404);
    const database = new DatabaseSync(app.paths.database);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 803').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = 804').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (806, 807, 808)').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 801').get().count, 1);
    } finally {
      database.close();
    }
  } finally {
    if (browser) await closeBrowser(browser, context);
    await app.close();
  }
});

test('管理页面真实浏览器覆盖模型资源图片上传、非法文件失败、排序、封面和封面删除约束', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await modelList(page);
    const fixtureCard = modelCard(list, 'fixture-model.safetensors');
    await fixtureCard.getByRole('button', { name: /详情|编辑/u }).click();
    const drawer = await modelDrawer(page);
    const modelId = Number(await fixtureCard.getAttribute('data-id'));
    const upload = drawer.locator('#model-image-upload');
    const beforeInvalidUpload = await modelResourceCounts(app);
    const invalidUploadResponsePromise = page.waitForResponse((response) => response.url() === new URL(`/api/items/model/${modelId}/images`, app.baseUrl).href && response.request().method() === 'POST');
    await upload.setInputFiles({ name: 'not-an-image.png', mimeType: 'image/png', buffer: Buffer.from('not an image', 'utf8') });
    const invalidUploadResponse = await invalidUploadResponsePromise;
    assert.equal(invalidUploadResponse.status(), 415);
    const invalidUploadBody = await invalidUploadResponse.json();
    assert.equal(invalidUploadBody.ok, false);
    assert.equal(invalidUploadBody.error.code, 'UPLOAD_TYPE_UNSUPPORTED');
    assert.equal(invalidUploadBody.error.message, 'file is not a valid JPEG, PNG, or WebP image');
    assert.match(await visibleAlert(drawer), /上传失败.*(?:JPEG|PNG|WebP|有效)/u);
    assert.deepEqual(await modelResourceCounts(app), beforeInvalidUpload);
    assert.equal(await drawer.locator('#model-image-list [data-media-image]').count(), 1);

    const validUploadResponsePromise = page.waitForResponse((response) => response.url() === new URL(`/api/items/model/${modelId}/images`, app.baseUrl).href && response.request().method() === 'POST');
    await upload.setInputFiles([
      { name: 'issue-71-first.png', mimeType: 'image/png', buffer: await readFile(app.uploadFixture) },
      { name: 'issue-71-second.png', mimeType: 'image/png', buffer: await readFile(app.uploadFixture) },
      { name: 'issue-71-third.png', mimeType: 'image/png', buffer: await readFile(app.uploadFixture) }
    ]);
    assert.equal((await validUploadResponsePromise).status(), 201);
    await drawer.getByRole('button', { name: '管理图片' }).click();
    const manager = page.locator('#model-image-manager');
    await manager.waitFor({ state: 'visible', timeout: MODEL_UI_TIMEOUT });
    assert.equal(await manager.locator('.image-manager-card').count(), 3);
    await assertRenderedMediaImages(app, page, manager);
    assert.match(await manager.locator('#model-image-manager-range').textContent(), /图片 1–3 \/ 4/u);
    await manager.getByRole('button', { name: '显示后 3 张图片' }).click();
    assert.match(await manager.locator('#model-image-manager-range').textContent(), /图片 4–4 \/ 4/u);
    assert.equal(await manager.locator('.image-manager-card').count(), 1);
    assert.equal(await manager.locator('.image-manager-add').count(), 1);
    assert.equal(await manager.locator('.image-manager-empty').count(), 1);
    await manager.getByRole('button', { name: '显示前 3 张图片' }).click();

    const initialOrder = (await requestJson(app, 'GET', `/api/items/model/${modelId}/images`)).body.data.images.map(({ id }) => id);
    assert.equal(initialOrder.length, 4);
    const expectedOrder = [initialOrder[1], initialOrder[0], ...initialOrder.slice(2)];
    const reorderResponsePromise = page.waitForResponse((response) => response.url() === new URL(`/api/items/model/${modelId}/images/order`, app.baseUrl).href && response.request().method() === 'PUT');
    await manager.getByRole('button', { name: '后移' }).first().click();
    const reorderResponse = await reorderResponsePromise;
    assert.equal(reorderResponse.status(), 200);
    const reordered = await requestJson(app, 'GET', `/api/items/model/${modelId}/images`);
    assert.deepEqual(reordered.body.data.images.map(({ id }) => id), expectedOrder);
    assert.deepEqual(reordered.body.data.images.map(({ sort_order }) => sort_order), expectedOrder.map((_, index) => index));

    const coverButton = manager.getByRole('button', { name: '设为封面' }).first();
    const coverImageId = Number(await coverButton.getAttribute('data-image-id'));
    const coverResponsePromise = page.waitForResponse((response) => response.url() === new URL(`/api/items/model/${modelId}/cover`, app.baseUrl).href && response.request().method() === 'PUT');
    await coverButton.click();
    assert.equal((await coverResponsePromise).status(), 200);
    const covered = await requestJson(app, 'GET', `/api/items/model/${modelId}/images`);
    const coverImage = covered.body.data.images.find(({ id }) => id === coverImageId);
    assert.equal(covered.body.data.cover_media_path, coverImage.media_path);
    const database = new DatabaseSync(app.paths.database);
    try {
      assert.equal(database.prepare('SELECT cover_media_path FROM generation_models WHERE id = ?').get(modelId).cover_media_path, coverImage.media_path);
    } finally {
      database.close();
    }

    await deleteImageRow(app, page, manager, modelId, 0);
    const afterCoverDelete = await requestJson(app, 'GET', `/api/items/model/${modelId}/images`);
    assert.equal(afterCoverDelete.body.data.images.length, 3);
    assert.notEqual(afterCoverDelete.body.data.cover_media_path, coverImage.media_path);
    const databaseAfterCoverDelete = new DatabaseSync(app.paths.database);
    try {
      assert.notEqual(databaseAfterCoverDelete.prepare('SELECT cover_media_path FROM generation_models WHERE id = ?').get(modelId).cover_media_path, coverImage.media_path);
    } finally {
      databaseAfterCoverDelete.close();
    }

    while ((await requestJson(app, 'GET', `/api/items/model/${modelId}/images`)).body.data.images.length > 0) {
      if (await manager.locator('.image-manager-card').count() === 0) await manager.getByRole('button', { name: '显示前 3 张图片' }).click();
      await deleteImageRow(app, page, manager, modelId, 0);
    }
    assert.equal(await manager.getByRole('button', { name: '添加第一张图片' }).count(), 1);
    const empty = await requestJson(app, 'GET', `/api/items/model/${modelId}/images`);
    assert.deepEqual(empty.body.data.images, []);
    assert.equal(empty.body.data.cover_media_path, null);
    const finalDatabase = new DatabaseSync(app.paths.database);
    try {
      assert.equal(finalDatabase.prepare('SELECT cover_media_path FROM generation_models WHERE id = ?').get(modelId).cover_media_path, null);
    } finally {
      finalDatabase.close();
    }
  } finally {
    if (browser) await closeBrowser(browser, context);
    await app.close();
  }
});
