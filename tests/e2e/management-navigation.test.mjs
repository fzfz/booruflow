import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/test-browser-launch-options.mjs';

const navigation = Object.freeze([
  Object.freeze({ label: '首页', url: '/', focus: null }),
  Object.freeze({ label: '角色画师管理', url: '/app/web/manage.html', focus: '#manage-search' }),
  Object.freeze({ label: 'Prompt Tag 管理', url: '/manage/prompt-terms', marker: '#prompt-term-list', focus: '#prompt-term-search' }),
  Object.freeze({ label: '底模管理', url: '/manage/base-models', marker: '#base-model-list', focus: '#base-model-search' }),
  Object.freeze({ label: '模型管理', url: '/manage/models', marker: '#model-list', focus: '#model-search' }),
  Object.freeze({ label: 'LoRA 管理', url: '/manage/loras', marker: '#lora-list', focus: '#lora-search' }),
  Object.freeze({ label: '画师串管理', url: '/manage/artist-prompt-strings', marker: '#artist-list', focus: '#artist-search' }),
  Object.freeze({ label: 'ComfyUI 实例管理', url: '/manage/comfyui-instances', marker: '#comfyui-instance-list', focus: '#comfyui-instance-search' }),
  Object.freeze({ label: 'ComfyUI 模板管理', url: '/manage/comfyui-templates', marker: '#template-list', focus: '#template-search' })
]);

async function requestJson(app, method, pathname, body, requestId) {
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-request-id': requestId,
      ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

async function setExistingCover(app, kind, id, imageId) {
  const response = await requestJson(app, 'PUT', `/api/items/${kind}/${id}/cover`, { id: imageId }, `management-cover-${kind}`);
  assert.equal(response.status, 200);
  assert.ok(response.body.data.cover_media_path);
}

async function assertCardCoverLoaded(page, card) {
  const image = card.locator('.card-cover [data-media-image]');
  assert.equal(await image.count(), 1);
  await image.waitFor({ state: 'visible' });
  const element = await image.elementHandle();
  assert.ok(element);
  await page.waitForFunction((target) => target.complete && target.naturalWidth > 0 && target.naturalHeight > 0, element);
}

test('所有管理页面通过真实 HTTP 渲染同一菜单和对应当前入口', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    for (const entry of navigation) {
      const response = await page.goto(`${app.baseUrl}${entry.url}`, { waitUntil: 'domcontentloaded' });
      assert.equal(response?.status(), 200, entry.url);
      const links = page.locator('#management-navigation .management-navigation-link');
      await links.first().waitFor({ state: 'visible' });
      assert.equal(await links.count(), navigation.length);
      assert.deepEqual(await links.allTextContents(), navigation.map(({ label }) => label));
      assert.deepEqual(
        await links.evaluateAll((elements) => elements.map((element) => new URL(element.href).pathname)),
        navigation.map(({ url }) => url)
      );
      const current = page.locator('#management-navigation [aria-current="page"]');
      assert.equal(await current.count(), 1);
      assert.equal(await current.textContent(), entry.label);
      assert.equal(await page.locator('#management-navigation a').count(), navigation.length + 1);
      assert.equal(await page.locator('#management-navigation .management-navigation-chat-link').count(), 0);
      if (entry.marker) await page.locator(entry.marker).waitFor({ state: 'attached' });
      if (entry.focus) await page.waitForFunction((selector) => document.activeElement?.matches(selector), entry.focus);
    }
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});

test('所有使用资源封面的管理列表首次渲染时直接显示现有封面', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await setExistingCover(app, 'model', 802, 806);
    await setExistingCover(app, 'lora', 803, 807);
    await setExistingCover(app, 'template', 804, 808);

    const artistUpload = new FormData();
    artistUpload.append('files', new Blob([await readFile(app.uploadFixture)], { type: 'image/png' }), 'management-cover-artist.png');
    const artistSnapshot = await requestJson(app, 'POST', '/api/items/artist_prompt_string/805/images', artistUpload, 'management-cover-artist-upload');
    assert.equal(artistSnapshot.status, 201);
    await setExistingCover(app, 'artist_prompt_string', 805, artistSnapshot.body.data.images[0].id);

    for (const target of [
      Object.freeze({ url: '/manage/models', list: '#model-list', id: 802 }),
      Object.freeze({ url: '/manage/loras', list: '#lora-list', id: 803 }),
      Object.freeze({ url: '/manage/artist-prompt-strings', list: '#artist-list', id: 805 }),
      Object.freeze({ url: '/manage/comfyui-templates', list: '#template-list', id: 804 })
    ]) {
      const response = await page.goto(`${app.baseUrl}${target.url}`, { waitUntil: 'domcontentloaded' });
      assert.equal(response?.status(), 200, target.url);
      const card = page.locator(`${target.list} .manage-card[data-id="${target.id}"]`);
      await card.waitFor({ state: 'visible' });
      await assertCardCoverLoaded(page, card);
    }

  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});

test('三档精确视口的首页不横向溢出，窄屏公共菜单、首页入口和菜单跳转可用', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 390, height: 812 } });
  const page = await context.newPage();
  try {
    for (const viewport of [
      { width: 390, height: 812 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 }
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${app.baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('.home-destination').first().waitFor({ state: 'visible' });
      assert.equal(await page.locator('.home-destination').count(), navigation.length - 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${viewport.width}×${viewport.height}`);
    }

    await page.setViewportSize({ width: 390, height: 812 });
    await page.goto(`${app.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    const menu = page.locator('#management-navigation');
    const toggle = page.getByRole('button', { name: '打开管理菜单' });
    await toggle.waitFor({ state: 'visible' });
    assert.equal(await toggle.textContent(), '管理菜单');
    assert.equal(await menu.evaluate((element) => element.classList.contains('is-open')), false);
    await toggle.click();
    assert.equal(await menu.evaluate((element) => element.classList.contains('is-open')), true);
    await page.keyboard.press('Escape');
    assert.equal(await menu.evaluate((element) => element.classList.contains('is-open')), false);
    assert.equal(await toggle.evaluate((element) => document.activeElement === element), true);
    await toggle.click();

    const links = menu.locator('.management-navigation-link');

    await links.filter({ hasText: 'LoRA 管理' }).click();
    await page.waitForURL(`${app.baseUrl}/manage/loras`);
    assert.equal(await page.locator('#management-navigation [aria-current="page"]').textContent(), 'LoRA 管理');
    await page.goto(`${app.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.home-destination').count(), navigation.length - 1);
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});

test('当前页面高亮使用菜单入口 id 而不是功能标识', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const page = await browser.newPage();
  try {
    await page.goto(`${app.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      document.body.innerHTML = '<nav id="management-navigation" data-management-page-id="management-home" data-management-view="catalog-management"></nav>';
      await import('/app/web/assets/management-navigation.js?matching-key-test=1');
    });
    assert.equal(await page.locator('#management-navigation [aria-current="page"]').textContent(), '首页');
  } finally {
    await page.close();
    await browser.close();
    await app.close();
  }
});

test('旧管理首页路径返回 404', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const response = await fetch(`${app.baseUrl}/manage`, { redirect: 'manual' });
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});

test('旧资源汇总页保持可访问但不再作为管理菜单入口', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const page = await browser.newPage();
  try {
    const response = await page.goto(`${app.baseUrl}/manage/generation-resources`, { waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200);
    assert.equal(await page.locator('#management-navigation a[href="/manage/generation-resources"]').count(), 0);
  } finally {
    await page.close();
    await browser.close();
    await app.close();
  }
});
