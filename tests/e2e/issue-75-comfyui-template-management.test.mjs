import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/test-browser-launch-options.mjs';

const UI_TIMEOUT = 2_500;
const BASE_MODEL_ID = 801;
const MODEL_ID = 802;
const LORA_ID = 803;
const FIXTURE_TEMPLATE_ID = 804;
const TEMPLATE_WRITE = Object.freeze({
  base_model_id: BASE_MODEL_ID,
  model_id: MODEL_ID,
  lora_id: LORA_ID,
  template_type: 'text_to_image_lora',
  title: 'Issue 75 UI template',
  template_json: {
    version: 1,
    state: {},
    nodes: [{
      id: 1,
      type: 'Issue75UnknownNodeThatMustNotExecute',
      pos: [0, 0],
      size: [1, 1],
      flags: {},
      order: 0,
      mode: 0,
      properties: {}
    }]
  }
});
const TEMPLATE_WRITE_V04 = Object.freeze({
  ...TEMPLATE_WRITE,
  lora_id: null,
  template_type: 'text_to_image',
  title: 'Issue 75 UI workflow 0.4',
  template_json: Object.freeze({
    last_node_id: 1,
    last_link_id: 0,
    nodes: TEMPLATE_WRITE.template_json.nodes,
    links: Object.freeze([]),
    groups: Object.freeze([]),
    config: Object.freeze({}),
    extra: Object.freeze({ frontendVersion: '1.23.0' }),
    version: 0.4
  })
});

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-request-id': `issue-75-template-e2e-${operation}-${++requestSequence}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

async function openManagementPage(app) {
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const response = await page.goto(`${app.baseUrl}/manage/comfyui-templates`, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  return Object.freeze({ browser, context, page });
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

async function templateList(page) {
  const list = page.locator('#template-list');
  await list.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await list.getAttribute('aria-label'), 'ComfyUI 模板列表');
  return list;
}

function templateCard(list, title) {
  return list.locator('.manage-card').filter({ hasText: title });
}

async function templateDrawer(page) {
  const drawer = page.getByRole('dialog').filter({ hasText: /ComfyUI 模板/u });
  await drawer.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await drawer.count(), 1);
  return drawer;
}

async function waitForEditorReady(page, drawer) {
  const saveButton = drawer.locator('#template-editor-submit');
  const element = await saveButton.elementHandle();
  assert.ok(element);
  await page.waitForFunction((button) => button.disabled === false, element, { timeout: UI_TIMEOUT });
}

async function fillTemplateForm(drawer, write) {
  await drawer.locator('[name="base_model_id"]').selectOption(String(write.base_model_id));
  await drawer.locator('[name="model_id"]').selectOption(String(write.model_id));
  await drawer.locator('[name="lora_id"]').selectOption(String(write.lora_id));
  await drawer.locator('[name="template_type"]').selectOption(write.template_type);
  await drawer.locator('[name="title"]').fill(write.title);
  await drawer.locator('[name="template_json"]').fill(JSON.stringify(write.template_json, null, 2));
}

async function visibleAlert(drawer) {
  const alert = drawer.locator('[role="alert"]:visible').first();
  await alert.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  return (await alert.textContent())?.trim() ?? '';
}

async function templateMedia(app, templateId) {
  const result = await requestJson(app, 'GET', `/api/items/template/${templateId}/images`, undefined, 'media-read');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.owner_kind, 'template');
  assert.equal(result.body.data.owner_id, templateId);
  return result.body.data;
}

async function assertRenderedMediaImage(app, page, drawer) {
  const image = drawer.locator('[data-media-image]').first();
  await image.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  const source = await image.getAttribute('src');
  assert.ok(source);
  const mediaUrl = new URL(source, app.baseUrl);
  assert.equal(mediaUrl.origin, new URL(app.baseUrl).origin);
  assert.ok(mediaUrl.pathname.startsWith('/media/'), `media image URL is outside the application media path: ${source}`);
  const response = await fetch(mediaUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^image\//u);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
  const imageElement = await image.elementHandle();
  assert.ok(imageElement);
  await page.waitForFunction((element) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0, imageElement, { timeout: UI_TIMEOUT });
}

async function createTemplateFromPage(app, page, write) {
  await page.getByRole('button', { name: /新增.*模板/u }).click();
  const drawer = await templateDrawer(page);
  await fillTemplateForm(drawer, write);
  const createRequestPromise = apiRequest(page, app, '/api/manage/comfyui-templates', 'POST');
  const createResponsePromise = apiResponse(page, app, '/api/manage/comfyui-templates', 'POST');
  await drawer.locator('#template-editor-submit').click();
  const [createRequest, createResponse] = await Promise.all([createRequestPromise, createResponsePromise]);
  assert.equal(createResponse.status(), 201);
  const body = await createResponse.json();
  assert.equal(body.ok, true);
  assert.deepEqual(createRequest.postDataJSON(), write);
  await drawer.locator('#template-media-section').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  await waitForEditorReady(page, drawer);
  return Object.freeze({ drawer, templateId: Number(body.data.id), body });
}

test('管理页面保留无效 Workflow 编辑内容并展示受支持的格式版本', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await templateList(page);
    const fixtureCard = templateCard(list, 'Fixture template');
    await fixtureCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    await page.getByRole('button', { name: /新增.*模板/u }).click();
    const drawer = await templateDrawer(page);
    const invalidWrite = {
      ...TEMPLATE_WRITE,
      title: 'Issue 75 invalid workflow',
      template_json: { version: 0, state: {}, nodes: [] }
    };
    await fillTemplateForm(drawer, invalidWrite);
    const invalidResponsePromise = apiResponse(page, app, '/api/manage/comfyui-templates', 'POST');
    await drawer.locator('#template-editor-submit').click();
    const invalidResponse = await invalidResponsePromise;
    assert.equal(invalidResponse.status(), 422);
    const invalidBody = await invalidResponse.json();
    assert.equal(invalidBody.ok, false);
    assert.equal(invalidBody.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(invalidBody.error.details, { field: 'template_json', supported_versions: ['0.4', '1.0'] });
    assert.equal(await drawer.evaluate((element) => element.open), true);
    assert.match(await visibleAlert(drawer), /Workflow JSON 必须符合 0\.4 或 1\.0 格式/u);
    assert.equal(await templateCard(list, invalidWrite.title).count(), 0);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面真实浏览器覆盖 ComfyUI 模板列表、单表单 CRUD、Workflow 校验和生态字段', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await templateList(page);
    const fixtureCard = templateCard(list, 'Fixture template');
    await fixtureCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await fixtureCard.getAttribute('data-id'), String(FIXTURE_TEMPLATE_ID));

    const created = await createTemplateFromPage(app, page, TEMPLATE_WRITE);
    const createdCard = templateCard(list, TEMPLATE_WRITE.title);
    await createdCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(Number(await createdCard.getAttribute('data-id')), created.templateId);
    assert.equal(await created.drawer.locator('[name="base_model_id"]').inputValue(), String(BASE_MODEL_ID));
    assert.equal(await created.drawer.locator('[name="model_id"]').inputValue(), String(MODEL_ID));
    assert.equal(await created.drawer.locator('[name="lora_id"]').inputValue(), String(LORA_ID));

    await page.locator('[data-action="close-template-editor"]').click();
    const readResponsePromise = apiResponse(page, app, `/api/manage/comfyui-templates/${created.templateId}`, 'GET');
    await createdCard.getByRole('button', { name: /详情|编辑/u }).click();
    assert.equal((await readResponsePromise).status(), 200);
    const readDrawer = await templateDrawer(page);
    await waitForEditorReady(page, readDrawer);
    assert.equal(await readDrawer.locator('[name="title"]').inputValue(), TEMPLATE_WRITE.title);
    assert.equal(await readDrawer.locator('[name="base_model_id"]').inputValue(), String(BASE_MODEL_ID));
    assert.equal(await readDrawer.locator('[name="model_id"]').inputValue(), String(MODEL_ID));
    assert.equal(await readDrawer.locator('[name="lora_id"]').inputValue(), String(LORA_ID));
    assert.equal(await readDrawer.locator('#template-form').count(), 1);
    assert.equal(await readDrawer.locator('[name="template_json"]').isVisible(), true);
    assert.equal(await readDrawer.locator('#template-workflow-tabs, #template-static-panel, #template-runtime-panel, #template-runtime-test-panel').count(), 0);

    const updatedWrite = {
      ...TEMPLATE_WRITE,
      lora_id: null,
      template_type: 'text_to_image',
      title: 'Issue 75 UI template updated',
      template_json: { ...TEMPLATE_WRITE.template_json, extra: { updated: true } }
    };
    await fillTemplateForm(readDrawer, updatedWrite);
    const updateRequestPromise = apiRequest(page, app, `/api/manage/comfyui-templates/${created.templateId}`, 'PUT');
    const updateResponsePromise = apiResponse(page, app, `/api/manage/comfyui-templates/${created.templateId}`, 'PUT');
    await readDrawer.locator('#template-editor-submit').click();
    const [updateRequest, updateResponse] = await Promise.all([updateRequestPromise, updateResponsePromise]);
    assert.equal(updateResponse.status(), 200);
    assert.deepEqual(updateRequest.postDataJSON(), updatedWrite);
    const updatedBody = await updateResponse.json();
    assert.deepEqual(updatedBody.data.template_json, updatedWrite.template_json);
    assert.equal(updatedBody.data.lora_id, null);

    await page.locator('[data-action="close-template-editor"]').click();
    const updatedCard = templateCard(list, updatedWrite.title);
    await updatedCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    const deleteImpactResponsePromise = apiResponse(page, app, `/api/manage/comfyui-templates/${created.templateId}/delete-impact`, 'GET');
    await updatedCard.getByRole('button', { name: '编辑' }).click();
    const deleteDrawer = await templateDrawer(page);
    await waitForEditorReady(page, deleteDrawer);
    await deleteDrawer.locator('#template-editor-delete').click();
    assert.equal((await deleteImpactResponsePromise).status(), 200);
    const deleteDialog = page.locator('#template-delete');
    await deleteDialog.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await deleteDialog.getByRole('button', { name: '确认删除' }).click();
    await updatedCard.waitFor({ state: 'detached', timeout: UI_TIMEOUT });
    const deleted = await requestJson(app, 'GET', `/api/manage/comfyui-templates/${created.templateId}`, undefined, 'crud-delete-read');
    assert.equal(deleted.status, 404);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面真实浏览器保存 ComfyUI Workflow JSON 0.4', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await templateList(page);
    await page.getByRole('button', { name: /新增.*模板/u }).click();
    const drawer = await templateDrawer(page);
    assert.match(await drawer.locator('#template-json-help').textContent(), /0\.4.*1\.0/u);
    await page.locator('[data-action="close-template-editor"]').click();

    const created = await createTemplateFromPage(app, page, TEMPLATE_WRITE_V04);
    assert.deepEqual(created.body.data.template_json, TEMPLATE_WRITE_V04.template_json);
    const createdCard = templateCard(list, TEMPLATE_WRITE_V04.title);
    await createdCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(Number(await createdCard.getAttribute('data-id')), created.templateId);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面真实浏览器覆盖 ComfyUI 模板唯一封面上传、单封面界面和按图片 id 删除', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await templateList(page);
    const write = { ...TEMPLATE_WRITE, title: 'Issue 75 UI cover template' };
    const created = await createTemplateFromPage(app, page, write);
    const templateId = created.templateId;
    const drawer = created.drawer;
    assert.equal(await drawer.locator('#template-media-section').isVisible(), true);
    assert.deepEqual((await templateMedia(app, templateId)).images, []);

    const upload = drawer.locator('#template-image-upload');
    await upload.setInputFiles({
      name: 'issue-75-template-cover.png',
      mimeType: 'image/png',
      buffer: await readFile(app.uploadFixture)
    });
    const uploadResponsePromise = apiResponse(page, app, `/api/items/template/${templateId}/images`, 'POST');
    await drawer.getByRole('button', { name: '上传封面' }).click();
    const uploadResponse = await uploadResponsePromise;
    assert.equal(uploadResponse.status(), 201);
    await drawer.locator('.detail-image').first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await drawer.locator('.detail-image').count(), 1);
    await assertRenderedMediaImage(app, page, drawer);
    const uploaded = await templateMedia(app, templateId);
    assert.equal(uploaded.images.length, 1);
    const [image] = uploaded.images;
    assert.equal(uploaded.cover_media_path, image.media_path);

    assert.equal(await drawer.locator('#template-image-upload-controls').isVisible(), false);
    assert.equal(await drawer.locator('.detail-image').count(), 1);

    const deletedRow = drawer.locator(`.detail-image:has([data-action="delete-template-image"][data-image-id="${image.id}"])`);
    assert.equal(await deletedRow.count(), 1);
    const deleteDialog = page.locator('#template-image-delete');
    const deleteResponsePromise = apiResponse(page, app, `/api/items/template/${templateId}/images/${image.id}`, 'DELETE');
    await deletedRow.getByRole('button', { name: '删除图片' }).click();
    await deleteDialog.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await deleteDialog.getByRole('button', { name: '确认删除' }).click();
    const deleteResponse = await deleteResponsePromise;
    assert.equal(deleteResponse.status(), 200);
    await Promise.all([
      deleteDialog.waitFor({ state: 'hidden', timeout: UI_TIMEOUT }),
      deletedRow.waitFor({ state: 'detached', timeout: UI_TIMEOUT })
    ]);
    const afterDelete = await templateMedia(app, templateId);
    assert.deepEqual(afterDelete.images, []);
    assert.equal(afterDelete.cover_media_path, null);
    assert.equal((await fetch(`${app.baseUrl}/media/${image.media_path}`)).status, 404);
    assert.equal(await templateCard(list, write.title).count(), 1);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});
