import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/test-browser-launch-options.mjs';
import { assertManagementModal } from './management-modal-assertions.mjs';

const UI_TIMEOUT = 2_500;
const BASIC_USERNAME = 'issue-74-basic-user';
const BASIC_PASSWORD = 'issue-74-basic-password';
const BEARER_TOKEN = 'issue-74-bearer-token';

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-74-comfyui-e2e-${operation}-${++requestSequence}`;
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

async function openManagementPage(app) {
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const response = await page.goto(`${app.baseUrl}/manage/comfyui-instances`, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  return Object.freeze({ browser, context, page });
}

async function comfyuiList(page) {
  const list = page.locator('#comfyui-instance-list');
  await list.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await list.getAttribute('aria-label'), 'ComfyUI 实例列表');
  return list;
}

function comfyuiCard(list, title) {
  return list.locator('.manage-card').filter({ hasText: title });
}

async function comfyuiDrawer(page) {
  const drawer = page.locator('#comfyui-instance-editor');
  await drawer.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
  assert.equal(await drawer.count(), 1);
  await assertManagementModal(drawer);
  return drawer;
}

function apiResponse(page, app, pathname, method) {
  const expectedPath = new URL(pathname, app.baseUrl).pathname;
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === new URL(app.baseUrl).origin
      && url.pathname === expectedPath
      && response.request().method() === method;
  });
}

function apiRequest(page, app, pathname, method) {
  const expectedPath = new URL(pathname, app.baseUrl).pathname;
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.origin === new URL(app.baseUrl).origin && url.pathname === expectedPath && request.method() === method;
  });
}

async function fillInstanceForm(drawer, { title, url, credentialType, username, password, token }) {
  await drawer.locator('[name="title"]').fill(title);
  await drawer.locator('[name="url"]').fill(url);
  await drawer.locator('[name="credential_type"]').selectOption(credentialType);
  if (credentialType === 'http_basic') {
    await drawer.locator('[name="username"]').fill(username);
    await drawer.locator('[name="password"]').fill(password);
  }
  if (credentialType === 'bearer') await drawer.locator('[name="token"]').fill(token);
}

async function createInstance(app, { title, url }, operation = 'setup-create') {
  const result = await requestJson(app, 'POST', '/api/manage/comfyui-instances', {
    title,
    url,
    credential: { type: 'none' },
    is_enabled: false
  }, operation);
  assert.equal(result.status, 201, `creating ${title}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.ok, true);
  return result.body.data;
}

function assertCredentialAbsent(value, secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
}

test('管理页面真实浏览器覆盖 ComfyUI 实例 CRUD、Basic/Bearer 凭据不回显和连接检测启用门控', { concurrency: false }, async () => {
  const app = await startTestApp();
  const successUrl = `${app.baseUrl}/manage/generation-resources`;
  const failureUrl = `${app.baseUrl}/__missing-comfyui-endpoint`;
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await comfyuiList(page);

    await page.getByRole('button', { name: '新增 ComfyUI 实例' }).click();
    const drawer = await comfyuiDrawer(page);
    const enable = drawer.locator('[name="is_enabled"]');
    assert.equal(await enable.isDisabled(), true);
    await fillInstanceForm(drawer, {
      title: 'Issue 74 Basic instance',
      url: successUrl,
      credentialType: 'http_basic',
      username: BASIC_USERNAME,
      password: BASIC_PASSWORD
    });
    const createRequestPromise = apiRequest(page, app, '/api/manage/comfyui-instances', 'POST');
    const createResponsePromise = apiResponse(page, app, '/api/manage/comfyui-instances', 'POST');
    await drawer.locator('#comfyui-instance-editor-submit').click();
    const [createRequest, createResponse] = await Promise.all([createRequestPromise, createResponsePromise]);
    assert.equal(createResponse.status(), 201);
    const createBody = await createResponse.json();
    const createdId = Number(createBody.data.id);
    assert.ok(Number.isInteger(createdId) && createdId > 0);
    assert.deepEqual(createRequest.postDataJSON(), {
      title: 'Issue 74 Basic instance',
      url: successUrl,
      credential: { action: 'replace', type: 'http_basic', username: BASIC_USERNAME, password: BASIC_PASSWORD },
      is_enabled: false
    });
    assertCredentialAbsent(createBody, [BASIC_USERNAME, BASIC_PASSWORD]);
    assert.doesNotMatch(await page.content(), new RegExp(`${BASIC_USERNAME}|${BASIC_PASSWORD}`, 'u'));

    const createdCard = comfyuiCard(list, 'Issue 74 Basic instance');
    await createdCard.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.doesNotMatch((await createdCard.textContent()) ?? '', new RegExp(`${BASIC_USERNAME}|${BASIC_PASSWORD}`, 'u'));
    await drawer.locator('[data-action="close-comfyui-instance-editor"]').click();

    const readResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${createdId}`, 'GET');
    await createdCard.getByRole('button', { name: /详情|编辑/u }).click();
    assert.equal((await readResponsePromise).status(), 200);
    const readDrawer = await comfyuiDrawer(page);
    assert.equal(await readDrawer.locator('[name="username"]').inputValue(), '');
    assert.equal(await readDrawer.locator('[name="password"]').inputValue(), '');
    assert.doesNotMatch(await page.content(), new RegExp(`${BASIC_USERNAME}|${BASIC_PASSWORD}`, 'u'));

    await readDrawer.locator('[name="title"]').fill('Issue 74 Bearer instance');
    const keepRequestPromise = apiRequest(page, app, `/api/manage/comfyui-instances/${createdId}`, 'PUT');
    const keepResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${createdId}`, 'PUT');
    await readDrawer.locator('#comfyui-instance-editor-submit').click();
    const [keepRequest, keepResponse] = await Promise.all([keepRequestPromise, keepResponsePromise]);
    assert.equal(keepResponse.status(), 200);
    assert.deepEqual(keepRequest.postDataJSON(), {
      title: 'Issue 74 Bearer instance',
      url: successUrl,
      credential: { action: 'keep' },
      is_enabled: false
    });
    assertCredentialAbsent(await keepResponse.json(), [BASIC_USERNAME, BASIC_PASSWORD]);

    await readDrawer.locator('[name="credential_type"]').selectOption('bearer');
    await readDrawer.locator('[name="token"]').fill(BEARER_TOKEN);
    assert.equal(await readDrawer.locator('[name="username"]').count(), 0);
    const replaceRequestPromise = apiRequest(page, app, `/api/manage/comfyui-instances/${createdId}`, 'PUT');
    const replaceResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${createdId}`, 'PUT');
    await readDrawer.locator('#comfyui-instance-editor-submit').click();
    const [replaceRequest, replaceResponse] = await Promise.all([replaceRequestPromise, replaceResponsePromise]);
    assert.equal(replaceResponse.status(), 200);
    assert.deepEqual(replaceRequest.postDataJSON(), {
      title: 'Issue 74 Bearer instance',
      url: successUrl,
      credential: { action: 'replace', type: 'bearer', token: BEARER_TOKEN },
      is_enabled: false
    });
    const replaceBody = await replaceResponse.json();
    assert.equal(replaceBody.data.is_valid, false);
    assert.equal(replaceBody.data.is_enabled, false);
    assertCredentialAbsent(replaceBody, [BASIC_USERNAME, BASIC_PASSWORD, BEARER_TOKEN]);
    assert.doesNotMatch(await page.content(), new RegExp(`${BASIC_USERNAME}|${BASIC_PASSWORD}|${BEARER_TOKEN}`, 'u'));

    const validateSuccessResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${createdId}/validate`, 'POST');
    await readDrawer.getByRole('button', { name: /检测连接|连接检测/u }).click();
    const validateSuccessResponse = await validateSuccessResponsePromise;
    assert.equal(validateSuccessResponse.status(), 200);
    const validateSuccessBody = await validateSuccessResponse.json();
    assert.equal(validateSuccessBody.data.is_valid, true);
    assert.equal(validateSuccessBody.data.is_enabled, false);
    assert.equal(await readDrawer.locator('[name="is_enabled"]').isDisabled(), false);
    assertCredentialAbsent(validateSuccessBody, [BASIC_USERNAME, BASIC_PASSWORD, BEARER_TOKEN]);

    await readDrawer.locator('[name="is_enabled"]').check();
    const enableRequestPromise = apiRequest(page, app, `/api/manage/comfyui-instances/${createdId}`, 'PUT');
    const enableResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${createdId}`, 'PUT');
    await readDrawer.locator('#comfyui-instance-editor-submit').click();
    const [enableRequest, enableResponse] = await Promise.all([enableRequestPromise, enableResponsePromise]);
    assert.equal(enableResponse.status(), 200);
    assert.equal(enableRequest.postDataJSON().credential.action, 'keep');
    assert.equal(enableRequest.postDataJSON().is_enabled, true);
    assert.equal((await enableResponse.json()).data.is_enabled, true);

    await readDrawer.locator('[name="url"]').fill(failureUrl);
    const invalidateRequestPromise = apiRequest(page, app, `/api/manage/comfyui-instances/${createdId}`, 'PUT');
    const invalidateResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${createdId}`, 'PUT');
    await readDrawer.locator('#comfyui-instance-editor-submit').click();
    const [, invalidateResponse] = await Promise.all([invalidateRequestPromise, invalidateResponsePromise]);
    assert.equal(invalidateResponse.status(), 200);
    const invalidateBody = await invalidateResponse.json();
    assert.equal(invalidateBody.data.is_valid, false);
    assert.equal(invalidateBody.data.is_enabled, false);
    assert.equal(await readDrawer.locator('[name="is_enabled"]').isDisabled(), true);

    const validateFailureResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${createdId}/validate`, 'POST');
    await readDrawer.getByRole('button', { name: /检测连接|连接检测/u }).click();
    const validateFailureResponse = await validateFailureResponsePromise;
    assert.equal(validateFailureResponse.status(), 200);
    const validateFailureBody = await validateFailureResponse.json();
    assert.equal(validateFailureBody.data.is_valid, false);
    assert.equal(validateFailureBody.data.is_enabled, false);
    assert.equal(await readDrawer.locator('[name="is_enabled"]').isDisabled(), true);
    assertCredentialAbsent(validateFailureBody, [BASIC_USERNAME, BASIC_PASSWORD, BEARER_TOKEN]);

    const database = new DatabaseSync(app.paths.database);
    try {
      const stored = database.prepare('SELECT credential_type, credential_ciphertext FROM comfyui_instances WHERE id = ?').get(createdId);
      assert.equal(stored.credential_type, 'bearer');
      assert.equal(typeof stored.credential_ciphertext, 'string');
      assert.doesNotMatch(stored.credential_ciphertext, new RegExp(`${BASIC_USERNAME}|${BASIC_PASSWORD}|${BEARER_TOKEN}`, 'u'));
    } finally {
      database.close();
    }

    await readDrawer.locator('[data-action="close-comfyui-instance-editor"]').click();
    const currentCard = list.locator(`.manage-card[data-id="${createdId}"]`);
    const deleteImpactResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${createdId}/delete-impact`, 'GET');
    await currentCard.getByRole('button', { name: '编辑' }).click();
    const deleteDrawer = await comfyuiDrawer(page);
    await deleteDrawer.locator('#comfyui-instance-editor-submit').waitFor({ state: 'visible' });
    await deleteDrawer.locator('#comfyui-instance-editor-delete').click();
    assert.equal((await deleteImpactResponsePromise).status(), 200);
    const deleteDialog = page.locator('#comfyui-instance-delete');
    await deleteDialog.waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await deleteDialog.getByRole('button', { name: '确认删除' }).click();
    await currentCard.waitFor({ state: 'detached', timeout: UI_TIMEOUT });
    const deleted = await requestJson(app, 'GET', `/api/manage/comfyui-instances/${createdId}`, undefined, 'crud-delete-read');
    assert.equal(deleted.status, 404);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面把 ComfyUI 实例启用复选框与字段文字排列为一个左对齐控件', { concurrency: false }, async () => {
  const app = await startTestApp();
  let browser;
  let context;
  let page;
  try {
    const instance = await createInstance(app, {
      title: 'Issue 74 aligned enable field',
      url: `${app.baseUrl}/manage/generation-resources`
    }, 'aligned-enable-field');
    ({ browser, context, page } = await openManagementPage(app));
    const list = await comfyuiList(page);
    await comfyuiCard(list, instance.title).getByRole('button', { name: /详情|编辑/u }).click();
    const drawer = await comfyuiDrawer(page);
    const field = drawer.locator('.comfyui-enabled-field');
    const checkbox = field.locator('[name="is_enabled"]');
    const [fieldBox, checkboxBox, display] = await Promise.all([
      field.boundingBox(),
      checkbox.boundingBox(),
      field.evaluate((element) => getComputedStyle(element).display)
    ]);
    assert.ok(fieldBox);
    assert.ok(checkboxBox);
    assert.equal(display, 'flex');
    assert.ok(Math.abs((checkboxBox.y + checkboxBox.height / 2) - (fieldBox.y + fieldBox.height / 2)) <= 2);
    assert.ok(checkboxBox.x - fieldBox.x <= 2);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面允许无凭据实例检测成功后启用并立即刷新列表状态', { concurrency: false }, async () => {
  const app = await startTestApp();
  const successUrl = `${app.baseUrl}/manage/generation-resources`;
  let browser;
  let context;
  let page;
  try {
    ({ browser, context, page } = await openManagementPage(app));
    const list = await comfyuiList(page);
    await page.getByRole('button', { name: '新增 ComfyUI 实例' }).click();
    const drawer = await comfyuiDrawer(page);
    await fillInstanceForm(drawer, {
      title: 'Issue 74 none browser enable',
      url: successUrl,
      credentialType: 'none'
    });

    const createResponsePromise = apiResponse(page, app, '/api/manage/comfyui-instances', 'POST');
    await drawer.locator('#comfyui-instance-editor-submit').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201);
    const created = await createResponse.json();
    const id = created.data.id;
    const card = comfyuiCard(list, 'Issue 74 none browser enable');
    await card.waitFor({ state: 'visible', timeout: UI_TIMEOUT });

    const validateResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${id}/validate`, 'POST');
    await drawer.getByRole('button', { name: /检测连接|连接检测/u }).click();
    const validateResponse = await validateResponsePromise;
    assert.equal(validateResponse.status(), 200);
    assert.equal((await validateResponse.json()).data.is_valid, true);
    const enable = drawer.locator('[name="is_enabled"]');
    assert.equal(await enable.isDisabled(), false);
    await enable.check();

    const enableRequestPromise = apiRequest(page, app, `/api/manage/comfyui-instances/${id}`, 'PUT');
    const enableResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${id}`, 'PUT');
    await drawer.locator('#comfyui-instance-editor-submit').click();
    const [enableRequest, enableResponse] = await Promise.all([enableRequestPromise, enableResponsePromise]);
    assert.deepEqual(enableRequest.postDataJSON(), {
      title: 'Issue 74 none browser enable',
      url: successUrl,
      credential: { action: 'keep' },
      is_enabled: true
    });
    assert.equal(enableResponse.status(), 200);
    assert.equal((await enableResponse.json()).data.is_enabled, true);
    assert.equal(await enable.isChecked(), true);

    await drawer.locator('[data-action="close-comfyui-instance-editor"]').click();
    assert.match((await card.textContent()) ?? '', /无凭据[\s\S]*已启用/u);

    const reopenResponsePromise = apiResponse(page, app, `/api/manage/comfyui-instances/${id}`, 'GET');
    await card.getByRole('button', { name: /详情|编辑/u }).click();
    const reopenResponse = await reopenResponsePromise;
    assert.equal(reopenResponse.status(), 200);
    assert.equal((await reopenResponse.json()).data.is_enabled, true);
    const reopenedDrawer = await comfyuiDrawer(page);
    assert.equal(await reopenedDrawer.locator('[name="is_enabled"]').isChecked(), true);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});

test('管理页面真实浏览器覆盖 ComfyUI 实例页码分页', { concurrency: false }, async () => {
  const app = await startTestApp();
  let browser;
  let context;
  let page;
  try {
    for (let index = 0; index < 21; index += 1) {
      await createInstance(app, {
        title: `Issue 74 page ${String(index).padStart(2, '0')}`,
        url: `http://127.0.0.1:${20_000 + index}`
      }, `pagination-${index}`);
    }
    ({ browser, context, page } = await openManagementPage(app));
    const list = await comfyuiList(page);
    assert.equal(await list.locator('.manage-card').count(), 16);
    const pagination = page.getByRole('navigation', { name: 'ComfyUI 实例分页' });
    assert.equal(await pagination.getByRole('button', { name: '上一页' }).isDisabled(), true);
    assert.equal(await pagination.getByRole('button', { name: '下一页' }).isDisabled(), false);
    await pagination.getByRole('button', { name: '下一页' }).click();
    await pagination.getByText('第 2 页', { exact: true }).waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    assert.equal(await list.locator('.manage-card').count(), 5);
    assert.match((await list.textContent()) ?? '', /Issue 74 page 20/u);
    assert.equal(await pagination.getByRole('button', { name: '下一页' }).isDisabled(), true);
  } finally {
    if (browser) {
      await context.close();
      await browser.close();
    }
    await app.close();
  }
});
