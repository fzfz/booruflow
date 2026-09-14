import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/testing/test-browser-launch-options.mjs';

const UI_TIMEOUT = 2_500;
const FIXTURE_ARTIST_ID = 805;
let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-request-id': `issue-76-release-acceptance-${operation}-${++requestSequence}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

async function openManagementPage(app, pathname, context = null) {
  const browser = context === null ? await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS) : null;
  const activeContext = context ?? await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await activeContext.newPage();
  const response = await page.goto(`${app.baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  return Object.freeze({ browser, context: activeContext, page });
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

async function artistList(page) {
  const list = page.locator('#artist-list');
  await list.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await list.getAttribute('aria-label'), '画师串列表');
  return list;
}

async function templateList(page) {
  const list = page.locator('#template-list');
  await list.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await list.getAttribute('aria-label'), 'ComfyUI 模板列表');
  return list;
}

function card(list, title) {
  return list.locator('.manage-card').filter({ hasText: title });
}

async function artistMedia(app, artistId, operation) {
  const result = await requestJson(app, 'GET', `/api/items/artist_prompt_string/${artistId}/images`, undefined, operation);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.data.owner_kind, 'artist_prompt_string');
  assert.equal(result.body.data.owner_id, artistId);
  return result.body.data;
}

function seedPagedGenerationResources(app) {
  const database = new DatabaseSync(app.paths.database);
  const now = '2026-08-03T00:00:00Z';
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    for (let index = 0; index < 20; index += 1) {
      const suffix = String(index).padStart(2, '0');
      database.prepare(`INSERT INTO artist_prompt_strings(
        title, description, artist_string, base_model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`I76 artist ${suffix}`, 'issue 76 artist page fixture', `issue_76_artist_${suffix}:1.0`, 801, now, now);
      database.prepare(`INSERT INTO comfyui_templates(
        base_model_id, model_id, lora_id, template_type, title, template_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(801, 802, 803, 'text_to_image', `I76 template ${suffix}`, '{}', now, now);
    }
  } finally {
    database.close();
  }
}

test('v0.2 发布验收：画师串删除确认后移除真实记录', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  try {
    ({ browser, context } = await openManagementPage(app, '/manage/artist-prompt-strings'));
    const page = context.pages()[0];
    const list = await artistList(page);
    const fixtureCard = card(list, 'Fixture artist');
    await fixtureCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    const impactResponsePromise = apiResponse(page, app, `/api/manage/artist-prompt-strings/${FIXTURE_ARTIST_ID}/delete-impact`, 'GET');
    await fixtureCard.getByRole('button', { name: '编辑' }).click();
    await page.locator('#artist-editor-delete').click();
    assert.equal((await impactResponsePromise).status(), 200);
    const deleteDialog = page.locator('#artist-delete');
    await deleteDialog.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.match(await deleteDialog.textContent(), /将删除画师串“Fixture artist”/u);

    const deleteResponsePromise = apiResponse(page, app, `/api/manage/artist-prompt-strings/${FIXTURE_ARTIST_ID}`, 'DELETE');
    await deleteDialog.getByRole('button', { name: '确认删除' }).click();
    assert.equal((await deleteResponsePromise).status(), 200);
    await fixtureCard.waitFor({ state: 'detached', timeout: UI_TIMEOUT });
    const deleted = await requestJson(app, 'GET', `/api/manage/artist-prompt-strings/${FIXTURE_ARTIST_ID}`, undefined, 'artist-delete-read');
    assert.equal(deleted.status, 404);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await app.close();
  }
});

test('v0.2 发布验收：画师串管理页码分页显示第二页记录', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  try {
    seedPagedGenerationResources(app);
    ({ browser, context } = await openManagementPage(app, '/manage/artist-prompt-strings'));
    const page = context.pages()[0];
    const list = await artistList(page);
    await list.locator('.manage-card').first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 16);
    const pagination = page.getByRole('navigation', { name: '画师串分页' });
    assert.match(await pagination.textContent(), /共 21 项 \/ 2 页/u);
    assert.equal(await pagination.getByRole('button', { name: '上一页' }).isDisabled(), true);

    const nextPageResponsePromise = apiResponse(page, app, '/api/manage/artist-prompt-strings', 'GET', (url) => url.searchParams.get('page') === '2' && url.searchParams.get('page_size') === '16');
    await pagination.getByRole('button', { name: '下一页' }).click();
    assert.equal((await nextPageResponsePromise).status(), 200);
    await pagination.getByText('第 2 页', { exact: true }).waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 5);
    assert.equal(await card(list, 'I76 artist 19').count(), 1);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await app.close();
  }
});

test('v0.2 发布验收：ComfyUI 模板管理页码分页显示第二页记录', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  try {
    seedPagedGenerationResources(app);
    ({ browser, context } = await openManagementPage(app, '/manage/comfyui-templates'));
    const page = context.pages()[0];
    const list = await templateList(page);
    await list.locator('.manage-card').first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 16);
    const pagination = page.getByRole('navigation', { name: 'ComfyUI 模板分页' });
    assert.match(await pagination.textContent(), /共 21 项 \/ 2 页/u);
    assert.equal(await pagination.getByRole('button', { name: '上一页' }).isDisabled(), true);

    const nextPageResponsePromise = apiResponse(page, app, '/api/manage/comfyui-templates', 'GET', (url) => url.searchParams.get('page') === '2' && url.searchParams.get('page_size') === '16');
    await pagination.getByRole('button', { name: '下一页' }).click();
    assert.equal((await nextPageResponsePromise).status(), 200);
    await pagination.getByText('第 2 页', { exact: true }).waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 5);
    assert.equal(await card(list, 'I76 template 19').count(), 1);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await app.close();
  }
});

test('v0.2 发布验收：画师串图片上移后保存新的真实顺序', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  try {
    ({ browser, context } = await openManagementPage(app, '/manage/artist-prompt-strings'));
    const page = context.pages()[0];
    const list = await artistList(page);
    const fixtureCard = card(list, 'Fixture artist');
    await fixtureCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await fixtureCard.getByRole('button', { name: /详情|编辑/u }).click();
    const drawer = page.locator('#artist-editor');
    await drawer.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    const uploadResponsePromise = apiResponse(page, app, `/api/items/artist_prompt_string/${FIXTURE_ARTIST_ID}/images`, 'POST');
    await drawer.locator('#artist-image-upload').setInputFiles([
      { name: 'issue-76-artist-one.png', mimeType: 'image/png', buffer: await readFile(app.uploadFixture) },
      { name: 'issue-76-artist-two.png', mimeType: 'image/png', buffer: await readFile(app.uploadFixture) },
      { name: 'issue-76-artist-three.png', mimeType: 'image/png', buffer: await readFile(app.uploadFixture) }
    ]);
    assert.equal((await uploadResponsePromise).status(), 201);
    await drawer.getByRole('button', { name: '管理图片' }).click();
    const manager = page.locator('#artist-image-manager');
    await manager.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await manager.locator('.image-manager-card').count(), 3);
    const initial = await artistMedia(app, FIXTURE_ARTIST_ID, 'artist-order-initial');
    assert.equal(initial.images.length, 3);
    const initialIds = initial.images.map(({ id }) => id);

    const orderRequestPromise = apiRequest(page, app, `/api/items/artist_prompt_string/${FIXTURE_ARTIST_ID}/images/order`, 'PUT');
    const orderResponsePromise = apiResponse(page, app, `/api/items/artist_prompt_string/${FIXTURE_ARTIST_ID}/images/order`, 'PUT');
    await manager.locator('.image-manager-card').nth(1).getByRole('button', { name: '前移' }).click();
    const [orderRequest, orderResponse] = await Promise.all([orderRequestPromise, orderResponsePromise]);
    assert.equal(orderResponse.status(), 200);
    assert.deepEqual(orderRequest.postDataJSON(), { ids: [initialIds[1], initialIds[0], initialIds[2]] });
    const reordered = await artistMedia(app, FIXTURE_ARTIST_ID, 'artist-order-after');
    assert.deepEqual(reordered.images.map(({ id }) => id), [initialIds[1], initialIds[0], initialIds[2]]);
    await page.waitForFunction((expectedId) => document.querySelector('#artist-image-manager-grid .image-manager-card:first-child button[data-action="move-artist-image-up"]')?.dataset.imageId === String(expectedId), initialIds[1], { timeout: UI_TIMEOUT });
    assert.equal(await manager.locator('.image-manager-card').nth(0).getByRole('button', { name: '前移' }).getAttribute('data-image-id'), String(initialIds[1]));
    assert.match(await manager.locator('.image-manager-card').nth(0).textContent(), /资源图片 1/u);
    assert.match(await manager.locator('.image-manager-card').nth(1).textContent(), /资源图片 2/u);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await app.close();
  }
});
