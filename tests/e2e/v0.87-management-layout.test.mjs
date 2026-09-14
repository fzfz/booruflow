import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { startTestApp } from '../../scripts/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/test-browser-launch-options.mjs';

const TARGET_TAG = 'v087_layout_target';

async function requestJson(app, method, pathname, body, requestId) {
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-request-id': requestId
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

const MANAGEMENT_LIST_PAGES = Object.freeze([
  Object.freeze({ name: '角色画师管理', path: '/app/web/manage.html', list: '#manage-list', pagination: '#manage-pagination' }),
  Object.freeze({ name: 'Prompt Tag 管理', path: '/manage/prompt-terms', list: '#prompt-term-list', pagination: '#prompt-term-pagination' }),
  Object.freeze({ name: '底模管理', path: '/manage/base-models', list: '#base-model-list', pagination: '#base-model-pagination' }),
  Object.freeze({ name: '模型管理', path: '/manage/models', list: '#model-list', pagination: '#model-pagination' }),
  Object.freeze({ name: 'LoRA 管理', path: '/manage/loras', list: '#lora-list', pagination: '#lora-pagination' }),
  Object.freeze({ name: '画师串管理', path: '/manage/artist-prompt-strings', list: '#artist-list', pagination: '#artist-pagination' }),
  Object.freeze({ name: 'ComfyUI 实例管理', path: '/manage/comfyui-instances', list: '#comfyui-instance-list', pagination: '#comfyui-instance-pagination' }),
  Object.freeze({ name: 'ComfyUI 模板管理', path: '/manage/comfyui-templates', list: '#template-list', pagination: '#template-pagination' })
]);

test('v0.87 首页使用批准原型的工作区、主视觉和三组功能卡片', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${app.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.home-function-card').count(), 3);
    assert.equal(await page.locator('.home-destination').count(), 8);
    assert.equal(await page.locator('.home-function-card').nth(0).locator('.home-destination').count(), 2);
    assert.equal(await page.locator('.home-function-card').nth(1).locator('.home-destination').count(), 4);
    assert.equal(await page.locator('.home-function-card').nth(2).locator('.home-destination').count(), 2);
    assert.equal(
      await page.locator('#home-title').textContent(),
      '把角色、画风、Prompt Tag 与生成资源，整理在一个工作台。'
    );
    const layout = await page.evaluate(() => {
      const rectangle = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? Object.fromEntries(['left', 'right', 'top', 'bottom', 'width', 'height'].map((key) => [key, Math.round(value[key])])) : null;
      };
      const versionStyle = getComputedStyle(document.querySelector('.home-version'));
      return {
        sidebar: rectangle('.management-navigation'),
        workspaceBar: rectangle('.workspace-bar'),
        content: rectangle('.home-view'),
        hero: rectangle('.home-hero'),
        title: rectangle('#home-title'),
        functionGrid: rectangle('.home-function-grid'),
        versionBackground: versionStyle.backgroundColor,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    assert.equal(layout.sidebar.width, 236);
    assert.equal(layout.workspaceBar.height, 56);
    assert.equal(layout.content.left, 260);
    assert.equal(layout.hero.top, 72);
    assert.ok(layout.hero.height >= 258);
    assert.ok(layout.title.left >= layout.hero.left + 26);
    assert.ok(layout.title.right < layout.hero.right);
    assert.equal(layout.versionBackground, 'rgb(29, 41, 47)');
    assert.equal(layout.overflow, 0);
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});

function seedManagementLists(app) {
  const database = openCatalogDatabase({ databasePath: app.paths.database, mediaRoot: app.paths.media, includeBuiltinComfyuiCatalog: false });
  const now = '2026-08-31T00:00:00.000Z';
  try {
    const insertWork = database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at)
      VALUES (?, ?, ?, '[]', '布局验收', 1, ?, ?)`);
    const insertBase = database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const insertModel = database.prepare(`INSERT INTO generation_models(id, base_model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
      VALUES (?, ?, ?, 'layout-format', 'layout-precision', '模型布局说明', '模型布局用法', ?, ?)`);
    const insertLora = database.prepare(`INSERT INTO generation_loras(id, base_model_id, model_id, file_name, file_format, precision_or_quantization, description, usage, trigger_words_json, weight, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'layout-format', 'layout-precision', 'LoRA 布局说明', 'LoRA 布局用法', '["layout"]', 0.8, ?, ?)`);
    const insertArtist = database.prepare(`INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id, created_at, updated_at)
      VALUES (?, ?, '画师串布局说明', 'artist:layout', ?, ?, ?)`);
    const insertInstance = database.prepare(`INSERT INTO comfyui_instances(id, title, url, credential_type, credential_ciphertext, is_enabled, is_valid, created_at, updated_at)
      VALUES (?, ?, ?, 'none', NULL, 1, 1, ?, ?)`);
    const insertTemplate = database.prepare(`INSERT INTO comfyui_templates(id, base_model_id, model_id, lora_id, template_type, title, template_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'text_to_image_lora', ?, '{}', ?, ?)`);
    const insertPromptTerm = database.prepare(`INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?, ?, ?)`);
    for (let index = 1; index <= 17; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const base = 87000 + index;
      const model = 87100 + index;
      const lora = 87200 + index;
      insertWork.run(87300 + index, `布局作品 ${suffix}`, `布局作品 ${suffix}`, now, now);
      insertBase.run(base, `布局底模 ${suffix}`, now, now);
      insertModel.run(model, base, `layout-model-${suffix}.custom`, now, now);
      insertLora.run(lora, base, model, `layout-lora-${suffix}.custom`, now, now);
      insertArtist.run(87400 + index, `布局画师串 ${suffix}`, base, now, now);
      insertInstance.run(87500 + index, `布局实例 ${suffix}`, `http://127.0.0.1:${19000 + index}`, now, now);
      insertTemplate.run(87600 + index, base, model, lora, `布局模板 ${suffix}`, now, now);
      insertPromptTerm.run(87700 + index, `v087_layout_${suffix}`, index, JSON.stringify([`布局别名 ${index}`]), now, now);
    }
  } finally {
    database.close();
  }
}

async function cardLayout(page, listSelector, paginationSelector) {
  return page.locator(`${listSelector} .manage-card`).evaluateAll((cards, paginationSelector) => {
    const rectangles = cards.map((card) => card.getBoundingClientRect());
    const pagination = document.querySelector(paginationSelector)?.getBoundingClientRect();
    return {
      count: rectangles.length,
      columns: new Set(rectangles.map(({ left }) => Math.round(left))).size,
      rows: new Set(rectangles.map(({ top }) => Math.round(top))).size,
      bottom: Math.max(...rectangles.map(({ bottom }) => bottom)),
      paginationBottom: pagination?.bottom ?? Number.POSITIVE_INFINITY,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth
    };
  }, paginationSelector);
}

test('v0.87 八个管理列表按 16 条形成桌面 4×4、平板 2 列和手机 1 列', { concurrency: false }, async () => {
  const app = await startTestApp();
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    seedManagementLists(app);
    for (const target of MANAGEMENT_LIST_PAGES) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${app.baseUrl}${target.path}`, { waitUntil: 'networkidle' });
      await page.locator(`${target.list} .manage-card`).first().waitFor({ state: 'visible' });
      assert.equal(await page.locator('.resource-section-heading h1').textContent(), target.name);
      const prototypeLayout = await page.evaluate(() => {
        const rectangle = (selector) => {
          const value = document.querySelector(selector)?.getBoundingClientRect();
          return value ? Object.fromEntries(['left', 'right', 'top', 'bottom', 'width', 'height'].map((key) => [key, Math.round(value[key])])) : null;
        };
        return {
          sidebar: rectangle('.management-navigation'),
          workspaceBar: rectangle('.workspace-bar'),
          heading: rectangle('.resource-section-heading'),
          toolbar: rectangle('.manage-toolbar'),
          status: rectangle('.generation-model-section.list-view > .state-line:not(.error)'),
          list: rectangle('.manage-list'),
          card: rectangle('.manage-card'),
          workspaceBackground: getComputedStyle(document.querySelector('.workspace-bar')).backgroundColor,
          toolbarBackground: getComputedStyle(document.querySelector('.manage-toolbar')).backgroundColor,
          bodyFont: getComputedStyle(document.body).fontFamily,
          paginationSummaryDisplay: getComputedStyle(document.querySelector('.pagination-summary')).display,
          editOffset: Math.round(document.querySelector('.manage-actions button').getBoundingClientRect().top - document.querySelector('.manage-card').getBoundingClientRect().top),
          footerOffset: Math.round(document.querySelector('.card-footer').getBoundingClientRect().bottom - document.querySelector('.manage-card').getBoundingClientRect().bottom)
        };
      });
      assert.deepEqual(prototypeLayout.sidebar, { left: 0, right: 236, top: 0, bottom: 900, width: 236, height: 900 }, target.name);
      assert.deepEqual(prototypeLayout.workspaceBar, { left: 236, right: 1440, top: 0, bottom: 56, width: 1204, height: 56 }, target.name);
      assert.equal(prototypeLayout.heading.left, 260, target.name);
      assert.equal(prototypeLayout.heading.top, 72, target.name);
      assert.equal(prototypeLayout.toolbar.left, 260, target.name);
      assert.equal(prototypeLayout.toolbar.right, 1416, target.name);
      assert.equal(prototypeLayout.toolbar.height, 78, target.name);
      assert.deepEqual(prototypeLayout.status, { left: 260, right: 1416, top: 235, bottom: 252, width: 1156, height: 17 }, target.name);
      assert.equal(prototypeLayout.list.left, 260, target.name);
      assert.equal(prototypeLayout.list.right, 1416, target.name);
      assert.equal(prototypeLayout.list.top, 262, target.name);
      assert.deepEqual(prototypeLayout.card, { left: 260, right: 542, top: 262, bottom: 400, width: 282, height: 138 }, target.name);
      assert.equal(prototypeLayout.workspaceBackground, 'rgb(255, 253, 248)', target.name);
      assert.equal(prototypeLayout.toolbarBackground, 'rgb(237, 241, 239)', target.name);
      assert.match(prototypeLayout.bodyFont, /PingFang SC/u, target.name);
      assert.equal(prototypeLayout.paginationSummaryDisplay, 'none', target.name);
      assert.equal(prototypeLayout.editOffset, 8, target.name);
      assert.equal(prototypeLayout.footerOffset, -1, target.name);
      assert.match(await page.locator('.generation-model-section.list-view > .state-line:not(.error)').textContent(), /^共 \d+ 条记录第 1 \/ \d+ 页 · 每页 16 条$/u, target.name);
      const desktop = await cardLayout(page, target.list, target.pagination);
      assert.equal(desktop.count, 16, target.name);
      assert.equal(desktop.columns, 4, target.name);
      assert.equal(desktop.rows, 4, target.name);
      assert.equal(desktop.viewportHeight, 900, target.name);
      assert.ok(desktop.scrollWidth <= desktop.viewportWidth, target.name);
      assert.ok(desktop.bottom <= desktop.viewportHeight, `${target.name} 的 1440×900 视口必须完整显示 4×4 卡片：${JSON.stringify(desktop)}`);
      assert.ok(desktop.paginationBottom <= desktop.viewportHeight, `${target.name} 的分页必须位于桌面首屏：${JSON.stringify(desktop)}`);

      await page.setViewportSize({ width: 768, height: 1024 });
      const tablet = await cardLayout(page, target.list, target.pagination);
      assert.equal(tablet.columns, 2, target.name);
      assert.equal(tablet.rows, 8, target.name);
      assert.ok(tablet.scrollWidth <= tablet.viewportWidth, target.name);

      await page.setViewportSize({ width: 390, height: 812 });
      const mobile = await cardLayout(page, target.list, target.pagination);
      assert.equal(mobile.columns, 1, target.name);
      assert.equal(mobile.rows, 16, target.name);
      assert.ok(mobile.scrollWidth <= mobile.viewportWidth, target.name);
    }
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});

test('Prompt Tag 页面通过只读类别选项完成新增、按钮搜索、编辑和删除', { concurrency: false }, async () => {
  const app = await startTestApp();
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${app.baseUrl}/manage/prompt-terms`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '新增 Prompt Tag' }).click();
    const editor = page.locator('#prompt-term-editor');
    await editor.waitFor({ state: 'visible' });
    assert.deepEqual(await editor.locator('[name="category"] option').evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent }))), [
      { value: '0', label: '通用' },
      { value: '1', label: '作者' },
      { value: '3', label: '作品/IP' },
      { value: '4', label: '角色' },
      { value: '5', label: '元数据' }
    ]);
    await editor.locator('[name="canonical_tag"]').fill(TARGET_TAG);
    await editor.locator('[name="category"]').selectOption('0');
    await editor.locator('[name="post_count"]').fill('41');
    await editor.locator('[name="aliases"]').fill('layout target\n布局目标');
    const createResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/manage/prompt-terms');
    await editor.locator('#prompt-term-editor-submit').click();
    const created = await createResponse;
    assert.equal(created.status(), 201);
    const createdId = (await created.json()).data.id;
    assert.ok(Number.isInteger(createdId) && createdId > 0);
    await editor.getByText('更改已保存', { exact: true }).waitFor();
    await editor.getByRole('button', { name: '关闭编辑弹窗' }).click();

    const listRequests = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/manage/prompt-terms') listRequests.push(request.url());
    });
    const search = page.locator('#prompt-term-search');
    assert.equal(await search.getAttribute('placeholder'), '搜索规范标签、别名、常见拼写、中文译名');
    await search.fill('布局目标');
    await page.waitForTimeout(80);
    assert.equal(listRequests.length, 0, '输入关键词时不得自动发送搜索请求');
    const searchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/api/manage/prompt-terms'
        && url.searchParams.get('q') === '布局目标';
    });
    await page.locator('#prompt-term-filter-form').getByRole('button', { name: '搜索' }).click();
    assert.equal((await searchResponse).status(), 200);
    assert.equal(listRequests.length, 1);

    const card = page.locator(`#prompt-term-list .manage-card[data-id="${createdId}"]`);
    await card.waitFor({ state: 'visible' });
    assert.match(await card.textContent(), /布局目标[\s\S]*通用[\s\S]*41 张关联图片/u);
    await card.getByRole('button', { name: '编辑' }).click();
    await editor.locator('#prompt-term-editor-title').filter({ hasText: '编辑 Prompt Tag' }).waitFor();
    await editor.locator('#prompt-term-editor-subtitle').filter({ hasText: TARGET_TAG }).waitFor();
    await editor.locator('[name="category"]').selectOption('5');
    await editor.locator('[name="post_count"]').fill('57');
    await editor.locator('[name="aliases"]').fill('layout target\n布局目标\n布局验收');
    const updateResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === `/api/manage/prompt-terms/${createdId}`);
    await editor.locator('#prompt-term-editor-submit').click();
    assert.equal((await updateResponse).status(), 200);
    await editor.getByText('更改已保存', { exact: true }).waitFor();

    await editor.locator('#prompt-term-delete-button').click();
    const confirmation = page.locator('#prompt-term-delete');
    await confirmation.waitFor({ state: 'visible' });
    assert.match(await confirmation.textContent(), new RegExp(TARGET_TAG, 'u'));
    const deleteResponse = page.waitForResponse((response) => response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === `/api/manage/prompt-terms/${createdId}`);
    await confirmation.getByRole('button', { name: '确认删除' }).click();
    assert.equal((await deleteResponse).status(), 200);
    await editor.waitFor({ state: 'hidden' });
    await page.locator('#prompt-term-list').getByText('暂无匹配 Prompt Tag。', { exact: true }).waitFor();
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});
