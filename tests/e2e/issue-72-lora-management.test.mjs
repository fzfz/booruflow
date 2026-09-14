import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/testing/test-browser-launch-options.mjs';
import { assertManagementModal } from './management-modal-assertions.mjs';

const UI_TIMEOUT = 2_500;
const LORA_ID = 803;
const TEMPLATE_ID = 804;
const INITIAL_LORA_IMAGE_ID = 807;
const LORA_WRITE = Object.freeze({
  base_model_id: 801,
  model_id: 802,
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  author: null,
  version: null,
  release_url: null,
  description: 'Issue 72 LoRA description',
  usage: 'Issue 72 LoRA usage',
  trigger_words: Object.freeze(['issue 72 trigger']),
  weight: 0.75
});
const MODEL_WRITE = Object.freeze({
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  author: null,
  version: null,
  release_url: null,
  published_at: null,
  description: 'Issue 72 filter model description',
  usage: 'Issue 72 filter model usage',
  skill_name: null
});

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-72-lora-e2e-${operation}-${++requestSequence}`;
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

async function createLora(app, fileName, overrides = {}) {
  const result = await requestJson(app, 'POST', '/api/manage/loras', { ...LORA_WRITE, file_name: fileName, ...overrides }, 'setup-create');
  assert.equal(result.status, 201, `creating ${fileName}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.ok, true);
  return result.body.data;
}

async function createFilterEcosystem(app) {
  const baseModel = await requestJson(app, 'POST', '/api/manage/base-models', { name: 'Issue 72 filter base model' }, 'filter-base-create');
  assert.equal(baseModel.status, 201);
  const model = await requestJson(app, 'POST', '/api/manage/models', {
    ...MODEL_WRITE,
    base_model_id: baseModel.body.data.id,
    file_name: 'issue-72-filter-model.safetensors'
  }, 'filter-model-create');
  assert.equal(model.status, 201);
  const lora = await createLora(app, 'issue-72-filter-lora.safetensors', {
    base_model_id: baseModel.body.data.id,
    model_id: model.body.data.id
  });
  return Object.freeze({ baseModel: baseModel.body.data, model: model.body.data, lora });
}

async function openManagementPage(app) {
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const response = await page.goto(`${app.baseUrl}/manage/loras`, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  return Object.freeze({ browser, context, page });
}

async function loraList(page) {
  const list = page.getByRole('region', { name: '文生图 LoRA 列表' });
  await list.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  return list;
}

function loraCard(list, fileName) {
  return list.locator('.manage-card').filter({ hasText: fileName });
}

async function assertRenderedCardCover(page, card) {
  const image = card.locator('.card-cover [data-media-image]');
  assert.equal(await image.count(), 1, 'LoRA 列表卡片首次渲染必须包含封面图片');
  await image.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  const imageElement = await image.elementHandle();
  assert.ok(imageElement);
  await page.waitForFunction((element) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0, imageElement, { timeout: UI_TIMEOUT });
}

async function loraDrawer(page) {
  const drawer = page.locator('#lora-editor');
  await drawer.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await drawer.count(), 1);
  await assertManagementModal(drawer);
  return drawer;
}

async function waitForLoraEditorReady(page, drawer) {
  const saveButton = drawer.locator('#lora-editor-submit');
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

async function fillLoraForm(page, app, drawer, {
  fileName,
  description = LORA_WRITE.description,
  usage = LORA_WRITE.usage,
  triggerWordsText = ' first trigger\r\n\r\n second trigger \nthird trigger',
  weight = '0.123456789'
} = {}) {
  const modelOptionsResponsePromise = apiResponse(page, app, '/api/manage/models', 'GET', (url) => url.searchParams.get('base_model_id') === String(LORA_WRITE.base_model_id));
  await drawer.locator('[name="base_model_id"]').selectOption(String(LORA_WRITE.base_model_id));
  assert.equal((await modelOptionsResponsePromise).status(), 200);
  await drawer.locator('[name="model_id"]').selectOption(String(LORA_WRITE.model_id));
  await drawer.locator('[name="file_name"]').fill(fileName);
  await drawer.locator('[name="file_format"]').fill(LORA_WRITE.file_format);
  await drawer.locator('[name="precision_or_quantization"]').fill(LORA_WRITE.precision_or_quantization);
  await drawer.locator('[name="trigger_words"]').fill(triggerWordsText);
  await drawer.locator('[name="weight"]').fill(weight);
  await drawer.locator('[name="description"]').fill(description);
  await drawer.locator('[name="usage"]').fill(usage);
}

async function assertRenderedMediaImages(app, page, drawer) {
  const images = drawer.locator('[data-media-image]');
  await images.first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  const sources = await images.evaluateAll((elements) => elements.map((element) => element.currentSrc || element.src));
  assert.ok(sources.length > 0);
  const baseUrl = new URL(app.baseUrl);
  for (const source of sources) {
    assert.ok(typeof source === 'string' && source.trim() !== '');
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

async function loraMedia(app, loraId) {
  const result = await requestJson(app, 'GET', `/api/items/lora/${loraId}/images`, undefined, 'media-read');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.owner_kind, 'lora');
  assert.equal(result.body.data.owner_id, loraId);
  return result.body.data;
}

async function deleteLoraImageRow(app, page, manager, loraId, index) {
  const row = manager.locator('.image-manager-card').nth(index);
  const imageId = Number(await row.getByRole('button', { name: '删除' }).getAttribute('data-image-id'));
  assert.ok(Number.isInteger(imageId) && imageId > 0);
  const deleteDialog = page.locator('#lora-image-delete');
  const deleteResponsePromise = apiResponse(page, app, `/api/items/lora/${loraId}/images/${imageId}`, 'DELETE');
  await row.getByRole('button', { name: '删除' }).click();
  await deleteDialog.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  await deleteDialog.getByRole('button', { name: '确认删除' }).click();
  const deleteResponse = await deleteResponsePromise;
  assert.equal(deleteResponse.status(), 200);
  await deleteDialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT });
  await page.waitForFunction(({ managerSelector, deletedId }) => {
    const root = document.querySelector(managerSelector);
    return Boolean(root) && !root.querySelector(`[data-image-id="${deletedId}"]`);
  }, { managerSelector: '#lora-image-manager', deletedId: imageId }, { timeout: UI_TIMEOUT });
  return imageId;
}

test('LoRA 管理页首次渲染列表时直接显示现有封面', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    const coverResponse = await requestJson(app, 'PUT', `/api/items/lora/${LORA_ID}/cover`, { id: INITIAL_LORA_IMAGE_ID }, 'setup-existing-cover');
    assert.equal(coverResponse.status, 200);
    assert.ok(coverResponse.body.data.cover_media_path);
    ({ browser, context, page } = await openManagementPage(app));
    const list = await loraList(page);
    const fixtureCard = loraCard(list, 'fixture-lora.safetensors');
    await fixtureCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await page.locator('#lora-editor').isVisible(), false);
    await assertRenderedCardCover(page, fixtureCard);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面真实浏览器覆盖 LoRA 分区、分页筛选、CRUD 和删除影响确认', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    for (let index = 0; index < 20; index += 1) await createLora(app, `issue-72-page-${String(index).padStart(2, '0')}.safetensors`);
    ({ browser, context, page } = await openManagementPage(app));
    const list = await loraList(page);
    assert.equal(await list.locator('.manage-card').count(), 16);

    const pagination = page.getByRole('navigation', { name: '文生图 LoRA 分页' });
    assert.equal(await pagination.getByRole('button', { name: '上一页' }).isDisabled(), true);
    const nextPageResponsePromise = apiResponse(page, app, '/api/manage/loras', 'GET', (url) => url.searchParams.get('page') === '2');
    await pagination.getByRole('button', { name: '下一页' }).click();
    const nextPageResponse = await nextPageResponsePromise;
    assert.equal(nextPageResponse.status(), 200);
    const nextPageData = (await nextPageResponse.json()).data;
    assert.ok(nextPageData.items.length > 0);
    await pagination.getByText('第 2 页', { exact: true }).waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await list.locator(`.manage-card[data-id="${nextPageData.items[0].id}"]`).waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), nextPageData.items.length);

    const search = page.locator('#lora-search');
    const filterResponsePromise = apiResponse(page, app, '/api/manage/loras', 'GET', (url) => url.searchParams.get('q') === 'fixture' && url.searchParams.get('page') === '1');
    await search.fill('fixture');
    await page.locator('#lora-filter-form').getByRole('button', { name: '搜索' }).click();
    const filterResponse = await filterResponsePromise;
    assert.equal(filterResponse.status(), 200);
    await loraCard(list, 'fixture-lora.safetensors').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 1);

    const clearFilterResponsePromise = apiResponse(page, app, '/api/manage/loras', 'GET', (url) => url.searchParams.get('q') === '' && url.searchParams.get('page') === '1');
    await page.locator('#lora-filter-form').getByRole('button', { name: '重置' }).click();
    assert.equal((await clearFilterResponsePromise).status(), 200);

    const filterEcosystem = await createFilterEcosystem(app);
    const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(reloadResponse?.status(), 200);
    await loraCard(list, 'fixture-lora.safetensors').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    const baseModelFilter = page.locator('#lora-filter-base-model');
    const modelFilter = page.locator('#lora-filter-model');
    await baseModelFilter.locator(`option[value="${filterEcosystem.baseModel.id}"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT });
    await modelFilter.locator(`option[value="${filterEcosystem.model.id}"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT });

    const baseModelFilterResponsePromise = apiResponse(page, app, '/api/manage/loras', 'GET', (url) =>
      url.searchParams.get('base_model_id') === String(filterEcosystem.baseModel.id)
      && url.searchParams.has('model_id') === false
      && url.searchParams.get('page') === '1');
    await baseModelFilter.selectOption(String(filterEcosystem.baseModel.id));
    await page.locator('#lora-filter-form').getByRole('button', { name: '搜索' }).click();
    assert.equal((await baseModelFilterResponsePromise).status(), 200);
    await loraCard(list, filterEcosystem.lora.file_name).waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 1);

    const modelOnlyFilterResponsePromise = apiResponse(page, app, '/api/manage/loras', 'GET', (url) =>
      url.searchParams.has('base_model_id') === false
      && url.searchParams.get('model_id') === String(filterEcosystem.model.id)
      && url.searchParams.get('page') === '1');
    const modelOptionsResponsePromise = apiResponse(page, app, '/api/manage/models', 'GET', (url) => url.searchParams.has('base_model_id') === false);
    await baseModelFilter.selectOption('');
    await modelOptionsResponsePromise;
    await modelFilter.selectOption(String(filterEcosystem.model.id));
    await page.locator('#lora-filter-form').getByRole('button', { name: '搜索' }).click();
    assert.equal((await modelOnlyFilterResponsePromise).status(), 200);
    await loraCard(list, filterEcosystem.lora.file_name).waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 1);

    const combinedFilterResponsePromise = apiResponse(page, app, '/api/manage/loras', 'GET', (url) =>
      url.searchParams.get('base_model_id') === String(LORA_WRITE.base_model_id)
      && url.searchParams.get('model_id') === String(LORA_WRITE.model_id)
      && url.searchParams.get('page') === '1');
    const compatibleModelsResponsePromise = apiResponse(page, app, '/api/manage/models', 'GET', (url) => url.searchParams.get('base_model_id') === String(LORA_WRITE.base_model_id));
    await baseModelFilter.selectOption(String(LORA_WRITE.base_model_id));
    await compatibleModelsResponsePromise;
    await modelFilter.selectOption(String(LORA_WRITE.model_id));
    await page.locator('#lora-filter-form').getByRole('button', { name: '搜索' }).click();
    assert.equal((await combinedFilterResponsePromise).status(), 200);
    await loraCard(list, 'fixture-lora.safetensors').waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    const clearStructuredFiltersResponsePromise = apiResponse(page, app, '/api/manage/loras', 'GET', (url) =>
      url.searchParams.has('base_model_id') === false
      && url.searchParams.has('model_id') === false
      && url.searchParams.get('page') === '1');
    await page.locator('#lora-filter-form').getByRole('button', { name: '重置' }).click();
    assert.equal((await clearStructuredFiltersResponsePromise).status(), 200);
    await loraCard(list, 'fixture-lora.safetensors').waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    const initialLoadingState = await page.evaluate(() => {
      document.querySelector('[data-action="open-lora-create"]').click();
      const editor = document.querySelector('#lora-editor');
      return {
        open: editor.open,
        triggerWordsDisabled: editor.querySelector('[name="trigger_words"]').disabled,
        weightDisabled: editor.querySelector('[name="weight"]').disabled
      };
    });
    assert.deepEqual(initialLoadingState, { open: true, triggerWordsDisabled: true, weightDisabled: true });
    const drawer = await loraDrawer(page);
    const drawerElement = await drawer.elementHandle();
    assert.ok(drawerElement);
    await waitForLoraEditorReady(page, drawer);
    assert.equal(await drawer.locator('[name="trigger_words"]').inputValue(), '');
    assert.equal(await drawer.locator('[name="weight"]').inputValue(), '1.0');
    await fillLoraForm(page, app, drawer, { fileName: 'issue-72-ui-lora.safetensors' });

    let emptyWeightPostCount = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === new URL(app.baseUrl).origin && url.pathname === '/api/manage/loras' && request.method() === 'POST') emptyWeightPostCount += 1;
    });
    await drawer.locator('[name="weight"]').fill('');
    await drawer.locator('[name="weight"]').evaluate((element) => { element.required = false; });
    await drawer.locator('#lora-editor-submit').click();
    await drawer.locator('#lora-editor-error').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.match(await drawer.locator('#lora-editor-error').textContent(), /默认模型权重不能为空/u);
    assert.equal(await drawer.locator('[name="weight"]').isDisabled(), false);
    assert.equal(await drawer.locator('[name="file_name"]').inputValue(), 'issue-72-ui-lora.safetensors');
    assert.equal(emptyWeightPostCount, 0);
    await drawer.locator('[name="weight"]').evaluate((element) => { element.required = true; });
    await drawer.locator('[name="weight"]').fill('0.123456789');

    await drawer.locator('[name="file_name"]').fill('fixture-lora.safetensors');
    const duplicateResponsePromise = apiResponse(page, app, '/api/manage/loras', 'POST');
    await drawer.locator('#lora-editor-submit').click();
    assert.equal((await duplicateResponsePromise).status(), 409);
    await drawer.locator('#lora-editor-error').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.match(await drawer.locator('#lora-editor-error').textContent(), /LoRA 已存在/u);
    assert.equal(await drawer.locator('[name="trigger_words"]').isDisabled(), false);
    assert.equal(await drawer.locator('[name="weight"]').isDisabled(), false);
    assert.equal(await drawer.locator('[name="file_name"]').inputValue(), 'fixture-lora.safetensors');
    assert.equal(await drawer.locator('[name="trigger_words"]').inputValue(), ' first trigger\n\n second trigger \nthird trigger');
    assert.equal(await drawer.locator('[name="weight"]').inputValue(), '0.123456789');
    await drawer.locator('[name="file_name"]').fill('issue-72-ui-lora.safetensors');

    const createResponsePromise = apiResponse(page, app, '/api/manage/loras', 'POST');
    const savingState = await drawer.evaluate((editor) => {
      editor.querySelector('button[type="submit"]').click();
      return {
        triggerWordsDisabled: editor.querySelector('[name="trigger_words"]').disabled,
        weightDisabled: editor.querySelector('[name="weight"]').disabled
      };
    });
    assert.deepEqual(savingState, { triggerWordsDisabled: true, weightDisabled: true });
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201);
    const createdBody = await createResponse.json();
    assert.equal(createdBody.ok, true);
    const createdId = Number(createdBody.data.id);
    assert.ok(Number.isInteger(createdId) && createdId > 0);
    assert.deepEqual(createdBody.data.trigger_words, ['first trigger', 'second trigger', 'third trigger']);
    assert.equal(createdBody.data.weight, 0.123456789);
    await waitForLoraEditorReady(page, drawer);
    await drawer.locator('[name="file_name"]').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await drawer.getByRole('button', { name: '更换封面' }).isVisible(), true);
    assert.equal(await drawer.getByRole('button', { name: '管理图片' }).isVisible(), true);
    assert.equal(await drawer.evaluate((node, expected) => node === expected, drawerElement), true);
    await page.locator('[data-action="close-lora-editor"]').click();

    const creationFilterResponsePromise = apiResponse(page, app, '/api/manage/loras', 'GET', (url) => url.searchParams.get('q') === 'issue-72-ui-lora');
    await search.fill('issue-72-ui-lora');
    await page.locator('#lora-filter-form').getByRole('button', { name: '搜索' }).click();
    assert.equal((await creationFilterResponsePromise).status(), 200);
    const createdCard = loraCard(list, 'issue-72-ui-lora.safetensors');
    await createdCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    const readResponsePromise = apiResponse(page, app, `/api/manage/loras/${createdId}`, 'GET');
    await createdCard.getByRole('button', { name: /详情|编辑/u }).click();
    const readResponse = await readResponsePromise;
    assert.equal(readResponse.status(), 200);
    const readBody = await readResponse.json();
    assert.equal(readBody.data.id, createdId);
    assert.deepEqual(readBody.data.trigger_words, ['first trigger', 'second trigger', 'third trigger']);
    assert.equal(readBody.data.weight, 0.123456789);
    const readDrawer = await loraDrawer(page);
    await waitForLoraEditorReady(page, readDrawer);
    assert.equal(await readDrawer.locator('[name="file_name"]').inputValue(), 'issue-72-ui-lora.safetensors');
    assert.equal(await readDrawer.locator('[name="trigger_words"]').inputValue(), 'first trigger\nsecond trigger\nthird trigger');
    assert.equal(await readDrawer.locator('[name="weight"]').inputValue(), '0.123456789');

    const updatedFileName = 'issue-72-ui-lora-updated.safetensors';
    await readDrawer.locator('[name="file_name"]').fill(updatedFileName);
    await readDrawer.locator('[name="description"]').fill('Issue 72 updated LoRA description');
    await readDrawer.locator('[name="usage"]').fill('Issue 72 updated LoRA usage');
    await readDrawer.locator('[name="trigger_words"]').fill('updated first\nupdated second');
    await readDrawer.locator('[name="weight"]').fill('-0.5');
    const updateResponsePromise = apiResponse(page, app, `/api/manage/loras/${createdId}`, 'PUT');
    await readDrawer.locator('#lora-editor-submit').click();
    const updateResponse = await updateResponsePromise;
    assert.equal(updateResponse.status(), 200);
    const updateBody = await updateResponse.json();
    assert.equal(updateBody.data.file_name, updatedFileName);
    assert.equal(updateBody.data.description, 'Issue 72 updated LoRA description');
    assert.equal(updateBody.data.usage, 'Issue 72 updated LoRA usage');
    assert.deepEqual(updateBody.data.trigger_words, ['updated first', 'updated second']);
    assert.equal(updateBody.data.weight, -0.5);
    const updatedRead = await requestJson(app, 'GET', `/api/manage/loras/${createdId}`, undefined, 'crud-read-after-update');
    assert.equal(updatedRead.status, 200);
    assert.equal(updatedRead.body.data.file_name, updatedFileName);
    assert.deepEqual(updatedRead.body.data.trigger_words, ['updated first', 'updated second']);
    assert.equal(updatedRead.body.data.weight, -0.5);

    await page.locator('[data-action="close-lora-editor"]').click();
    await page.locator('#lora-filter-form').getByRole('button', { name: '重置' }).click();
    await loraCard(list, 'fixture-lora.safetensors').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    const fixtureCard = loraCard(list, 'fixture-lora.safetensors');
    const impactResponsePromise = apiResponse(page, app, `/api/manage/loras/${LORA_ID}/delete-impact`, 'GET');
    await fixtureCard.getByRole('button', { name: '编辑' }).click();
    const fixtureDrawer = await loraDrawer(page);
    await waitForLoraEditorReady(page, fixtureDrawer);
    await fixtureDrawer.locator('#lora-editor-delete').click();
    const impactResponse = await impactResponsePromise;
    assert.equal(impactResponse.status(), 200);
    const impactBody = await impactResponse.json();
    const deleteDialog = page.locator('#lora-delete');
    await deleteDialog.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.match(await deleteDialog.textContent(), /fixture-lora\.safetensors/u);
    assert.match(await deleteDialog.textContent(), /Fixture template/u);
    assert.match(await deleteDialog.textContent(), /images\/fixture-lora\.png/u);
    assert.ok(impactBody.data.cascade_deleted.some(({ kind, id }) => kind === 'template' && id === TEMPLATE_ID));
    await deleteDialog.getByRole('button', { name: '取消' }).click();
    assert.equal(await deleteDialog.isVisible(), false);
    assert.equal(await fixtureCard.count(), 1);
    assert.equal((await requestJson(app, 'GET', `/api/manage/loras/${LORA_ID}`, undefined, 'delete-cancel-read')).status, 200);

    const confirmedImpactResponsePromise = apiResponse(page, app, `/api/manage/loras/${LORA_ID}/delete-impact`, 'GET');
    await fixtureDrawer.locator('#lora-editor-delete').click();
    const confirmedImpactResponse = await confirmedImpactResponsePromise;
    assert.equal(confirmedImpactResponse.status(), 200);
    const confirmedImpactBody = await confirmedImpactResponse.json();
    const deleteRequestPromise = apiRequest(page, app, `/api/manage/loras/${LORA_ID}`, 'DELETE');
    const deleteResponsePromise = apiResponse(page, app, `/api/manage/loras/${LORA_ID}`, 'DELETE');
    await deleteDialog.getByRole('button', { name: '确认删除' }).click();
    const [deleteRequest, deleteResponse] = await Promise.all([deleteRequestPromise, deleteResponsePromise]);
    assert.deepEqual(deleteRequest.postDataJSON(), { impact_token: confirmedImpactBody.data.impact_token });
    assert.equal(deleteResponse.status(), 200);
    await fixtureCard.waitFor({ state: 'detached', timeout: UI_TIMEOUT });

    const missing = await requestJson(app, 'GET', `/api/manage/loras/${LORA_ID}`, undefined, 'delete-confirmed-read');
    assert.equal(missing.status, 404);
    const database = new DatabaseSync(app.paths.database);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = ?').get(LORA_ID).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = ?').get(TEMPLATE_ID).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = \'lora\' AND owner_id = ?').get(LORA_ID).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = \'template\' AND owner_id = ?').get(TEMPLATE_ID).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = ?').get(createdId).count, 1);
    } finally {
      database.close();
    }
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面真实浏览器覆盖 LoRA 图片上传、显示、排序、封面和删除', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await loraList(page);
    const fixtureCard = loraCard(list, 'fixture-lora.safetensors');
    await fixtureCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    const readResponsePromise = apiResponse(page, app, `/api/manage/loras/${LORA_ID}`, 'GET');
    await fixtureCard.getByRole('button', { name: /详情|编辑/u }).click();
    assert.equal((await readResponsePromise).status(), 200);
    const drawer = await loraDrawer(page);
    const initial = await loraMedia(app, LORA_ID);
    assert.deepEqual(initial.images.map(({ id }) => id), [INITIAL_LORA_IMAGE_ID]);
    await assertRenderedMediaImages(app, page, drawer);

    const fixtureBytes = await readFile(app.uploadFixture);
    const upload = drawer.locator('#lora-image-upload');
    const uploadResponsePromise = apiResponse(page, app, `/api/items/lora/${LORA_ID}/images`, 'POST');
    await upload.setInputFiles([
      { name: 'issue-72-lora-first.png', mimeType: 'image/png', buffer: fixtureBytes },
      { name: 'issue-72-lora-second.png', mimeType: 'image/png', buffer: fixtureBytes },
      { name: 'issue-72-lora-third.png', mimeType: 'image/png', buffer: fixtureBytes }
    ]);
    const uploadResponse = await uploadResponsePromise;
    assert.equal(uploadResponse.status(), 201);
    await drawer.getByRole('button', { name: '管理图片' }).click();
    const manager = page.locator('#lora-image-manager');
    await manager.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await manager.locator('.image-manager-card').count(), 3);
    await assertRenderedMediaImages(app, page, manager);
    assert.match(await manager.locator('#lora-image-manager-range').textContent(), /图片 1–3 \/ 4/u);
    await manager.getByRole('button', { name: '显示后 3 张图片' }).click();
    assert.match(await manager.locator('#lora-image-manager-range').textContent(), /图片 4–4 \/ 4/u);
    assert.equal(await manager.locator('.image-manager-card').count(), 1);
    assert.equal(await manager.locator('.image-manager-add').count(), 1);
    assert.equal(await manager.locator('.image-manager-empty').count(), 1);
    await manager.getByRole('button', { name: '显示前 3 张图片' }).click();

    const initialOrder = (await loraMedia(app, LORA_ID)).images.map(({ id }) => id);
    assert.equal(initialOrder.length, 4);
    const expectedOrder = [initialOrder[1], initialOrder[0], ...initialOrder.slice(2)];
    const reorderResponsePromise = apiResponse(page, app, `/api/items/lora/${LORA_ID}/images/order`, 'PUT');
    await manager.getByRole('button', { name: '后移' }).first().click();
    const reorderResponse = await reorderResponsePromise;
    assert.equal(reorderResponse.status(), 200);
    const reordered = await loraMedia(app, LORA_ID);
    assert.deepEqual(reordered.images.map(({ id }) => id), expectedOrder);
    assert.deepEqual(reordered.images.map(({ sort_order }) => sort_order), [0, 1, 2, 3]);

    const coverButton = manager.getByRole('button', { name: '设为封面' }).first();
    const coverImageId = Number(await coverButton.getAttribute('data-image-id'));
    const coverResponsePromise = apiResponse(page, app, `/api/items/lora/${LORA_ID}/cover`, 'PUT');
    await coverButton.click();
    const coverResponse = await coverResponsePromise;
    assert.equal(coverResponse.status(), 200);
    const covered = await loraMedia(app, LORA_ID);
    const coverImage = covered.images.find(({ id }) => id === coverImageId);
    assert.ok(coverImage);
    assert.equal(covered.cover_media_path, coverImage.media_path);
    assert.equal(await manager.locator('.image-manager-card.is-cover').count(), 1);
    assert.match(await manager.locator('.image-manager-card.is-cover').textContent(), /当前封面/u);
    const database = new DatabaseSync(app.paths.database);
    try {
      assert.equal(database.prepare('SELECT cover_media_path FROM generation_loras WHERE id = ?').get(LORA_ID).cover_media_path, coverImage.media_path);
    } finally {
      database.close();
    }

    await manager.getByRole('button', { name: '显示后 3 张图片' }).click();
    const deletedImageId = await deleteLoraImageRow(app, page, manager, LORA_ID, 0);
    const afterDelete = await loraMedia(app, LORA_ID);
    assert.equal(afterDelete.images.length, 3);
    assert.ok(afterDelete.images.every(({ id }) => id !== deletedImageId));
    assert.equal(afterDelete.cover_media_path, coverImage.media_path);
    await assertRenderedMediaImages(app, page, manager);
    const finalDatabase = new DatabaseSync(app.paths.database);
    try {
      assert.equal(finalDatabase.prepare('SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = \'lora\' AND owner_id = ?').get(LORA_ID).count, 3);
      assert.equal(finalDatabase.prepare('SELECT cover_media_path FROM generation_loras WHERE id = ?').get(LORA_ID).cover_media_path, coverImage.media_path);
    } finally {
      finalDatabase.close();
    }
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});
