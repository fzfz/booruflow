import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/testing/test-browser-launch-options.mjs';

const FIXTURE_MEDIA_PATHS = ['images/fixture-model.png', 'images/fixture-lora.png', 'images/fixture-template.png'];

test('管理页面完成底模 CRUD、分页、实际关联删除影响和提交后媒体清理', async () => {
  const app = await startTestApp({ generationResourceFixture: true, baseModelDetailReadBehavior: 'delay' });
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    const pageResponse = await page.goto(`${app.baseUrl}/manage/base-models`, { waitUntil: 'domcontentloaded' });
    assert.equal(pageResponse?.status(), 200);

    await page.getByRole('button', { name: '新增底模' }).click();
    await page.locator('#base-model-name').fill('E2E WAI');
    await page.locator('#base-model-editor-submit').click();
    await page.getByText('E2E WAI', { exact: true }).waitFor();

    const detailCard = page.locator('.manage-card', { hasText: 'E2E WAI' });
    const detailPathname = `/api/manage/base-models/${await detailCard.getAttribute('data-id')}`;
    const updateRequests = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'PUT' && /\/api\/manage\/base-models\/\d+$/u.test(pathname)) updateRequests.push({ pathname, body: request.postData() });
    });
    await detailCard.getByRole('button', { name: '编辑' }).click();
    assert.equal(await page.locator('#base-model-name').isDisabled(), true);
    assert.equal(await page.locator('#base-model-editor-submit').isDisabled(), true);
    await page.evaluate(() => document.querySelector('#base-model-form').requestSubmit());
    await page.waitForTimeout(100);
    assert.equal(updateRequests.length, 0);
    await page.waitForFunction(() => document.querySelector('#base-model-name').disabled === false);
    await page.locator('#base-model-name').fill('E2E WAI Updated');
    await page.locator('#base-model-editor-submit').click();
    await page.getByText('E2E WAI Updated', { exact: true }).waitFor();
    assert.deepEqual(updateRequests, [{ pathname: detailPathname, body: '{"name":"E2E WAI Updated"}' }]);

    await page.evaluate(async () => {
      for (let index = 0; index < 20; index += 1) {
        const response = await fetch('/api/manage/base-models', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-request-id': `e2e-page-${index}` },
          body: JSON.stringify({ name: `E2E Page ${String(index).padStart(2, '0')}` })
        });
        if (!response.ok) throw new Error(`seed base model ${index} failed`);
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const baseModelPagination = page.locator('#base-model-pagination');
    assert.equal(await baseModelPagination.getByRole('button', { name: '上一页' }).isDisabled(), true);
    await baseModelPagination.getByRole('button', { name: '下一页' }).click();
    await baseModelPagination.getByText('第 2 页').waitFor();

    await page.locator('#base-model-search').fill('Fixture WAI');
    await page.locator('#base-model-filter-form').getByRole('button', { name: '搜索' }).click();
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('#base-model-list .manage-card')];
      return cards.length === 1 && cards[0].textContent?.includes('Fixture WAI');
    });
    const impact = await page.evaluate(async () => {
      const response = await fetch('/api/manage/base-models/801/delete-impact');
      return await response.json();
    });
    assert.deepEqual(impact.data.cascade_deleted.filter((item) => item.kind !== 'image').map((item) => [item.kind, item.name]), [
      ['model', 'fixture-model.safetensors'], ['lora', 'fixture-lora.safetensors'], ['template', 'Fixture template']
    ]);
    assert.deepEqual(impact.data.retained.map((item) => [item.kind, item.name]), [['artist_prompt_string', 'Fixture artist']]);

    const fixtureCard = page.locator('.manage-card', { hasText: 'Fixture WAI' });
    await fixtureCard.getByRole('button', { name: '编辑' }).click();
    await page.locator('#base-model-editor-delete').click();
    await page.getByText('模型：fixture-model.safetensors', { exact: true }).waitFor();
    await page.getByText('LoRA：fixture-lora.safetensors', { exact: true }).waitFor();
    await page.getByText('模板：Fixture template', { exact: true }).waitFor();
    await page.getByText('画师串：Fixture artist', { exact: true }).waitFor();
    await page.getByRole('button', { name: '确认删除' }).click();
    await page.locator('#base-model-list .manage-card', { hasText: 'Fixture WAI' }).waitFor({ state: 'detached' });

    const database = new DatabaseSync(app.paths.database);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 801').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 802').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 803').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = 804').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (806, 807, 808)').get().count, 0);
      assert.equal(database.prepare('SELECT base_model_id FROM artist_prompt_strings WHERE id = 805').get().base_model_id, null);
    } finally {
      database.close();
    }
    for (const mediaPath of FIXTURE_MEDIA_PATHS) assert.equal(existsSync(join(app.paths.media, mediaPath)), false);
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});

test('详情 GET 失败时保持表单锁定并拒绝提交', async () => {
  const app = await startTestApp({ baseModelDetailReadBehavior: 'fail' });
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${app.baseUrl}/manage/base-models`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '新增底模' }).click();
    await page.locator('#base-model-name').fill('E2E Detail Failure');
    await page.locator('#base-model-editor-submit').click();
    await page.getByText('E2E Detail Failure', { exact: true }).waitFor();

    let updateRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && /\/api\/manage\/base-models\/\d+$/u.test(new URL(request.url()).pathname)) updateRequests += 1;
    });
    await page.locator('.manage-card', { hasText: 'E2E Detail Failure' }).getByRole('button', { name: '编辑' }).click();
    await page.getByText('读取底模未完成：数据暂时被占用。请稍后重试。', { exact: true }).waitFor();
    assert.equal(await page.locator('#base-model-name').isDisabled(), true);
    assert.equal(await page.locator('#base-model-editor-submit').isDisabled(), true);
    await page.evaluate(() => document.querySelector('#base-model-form').requestSubmit());
    await page.waitForTimeout(100);
    assert.equal(updateRequests, 0);
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});
