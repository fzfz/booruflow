import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/testing/test-browser-launch-options.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceRoot = join(repositoryRoot, 'tests/e2e/artifacts/step-11/manage');

test('管理页联调执行关闭处理后清理临时目录并退出', async (t) => {
  const probe = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startTestApp } from './scripts/testing/start-test-app.mjs';
    process.on('message', () => process.emit('SIGTERM'));
    const app = await startTestApp();
    console.log('TEST_ROOT=' + JSON.stringify(app.root));
  `], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise((resolve) => probe.once('exit', (code, signal) => resolve([code, signal])));
  const requestClose = () => {
    if (process.platform === 'win32') probe.send('close');
    else probe.kill('SIGTERM');
  };
  t.after(async () => {
    if (probe.exitCode === null && probe.signalCode === null) requestClose();
    await exited;
  });
  let output = '';
  const root = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待联调信号探针超时：${output}`)), 10_000);
    probe.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const line = output.split('\n').find((value) => value.startsWith('TEST_ROOT='));
      if (line && output.endsWith('\n')) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice('TEST_ROOT='.length)));
      }
    });
    probe.stderr.on('data', (chunk) => { output += chunk.toString(); });
    probe.once('error', (error) => { clearTimeout(timer); reject(error); });
    probe.once('exit', () => { clearTimeout(timer); reject(new Error(`联调探针提前退出：${output}`)); });
  });
  requestClose();
  const [code, signal] = await exited;
  assert.equal(signal, null);
  assert.equal(code, 143);
  await assert.rejects(access(root), /ENOENT/u);
});

test('管理页浏览器真实查询覆盖搜索、空结果、总数分页和 HTTP 错误', async () => {
  const app = await startTestApp();
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const managementListRequests = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/manage/items') managementListRequests.push(request.url());
  });
  try {
    await page.goto(`${app.baseUrl}/app/web/manage.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.manage-card', { timeout: 5_000 });
    const queryResults = await page.evaluate(async () => {
      const firstResponse = await fetch('/api/manage/items?kind=all&limit=1&page=1');
      const first = await firstResponse.json();
      const secondResponse = await fetch('/api/manage/items?kind=all&limit=1&page=2');
      const second = await secondResponse.json();
      const invalidResponse = await fetch('/api/manage/items?kind=all&limit=1&page=0');
      const invalid = await invalidResponse.json();
      return { first, second, invalidStatus: invalidResponse.status, invalid };
    });
    assert.equal(queryResults.first.ok, true);
    assert.equal(queryResults.second.ok, true);
    assert.notEqual(queryResults.first.data.items[0].id, queryResults.second.data.items[0].id);
    assert.equal(queryResults.first.data.total_count, 3);
    assert.deepEqual([queryResults.first.data.page, queryResults.second.data.page], [1, 2]);
    assert.equal(queryResults.invalidStatus, 422);
    assert.equal(queryResults.invalid.error.code, 'VALIDATION_ERROR');
    managementListRequests.length = 0;
    await page.locator('#manage-search').fill('不存在的管理对象');
    await page.waitForTimeout(80);
    assert.equal(managementListRequests.length, 0, '输入本身不发送管理搜索请求');
    await page.locator('#manage-search').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.manage-card').length === 0);
    assert.equal(managementListRequests.length, 1, 'Enter 发送一次管理搜索请求');
    assert.match(await page.locator('#manage-list').textContent(), /暂无匹配档案/u);
    await page.locator('#manage-search-submit').click();
    await page.waitForFunction(() => document.querySelector('#manage-search-submit').disabled === false);
    assert.equal(managementListRequests.length, 2, '搜索按钮再发送一次管理搜索请求');
    await page.locator('#manage-search').fill('');
    await page.waitForTimeout(80);
    assert.equal(managementListRequests.length, 2, '清空搜索文本不发送请求');
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});

test('角色画师管理页首次渲染时直接显示作品、角色与画风现有封面', async () => {
  const app = await startTestApp();
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    for (const [kind, id] of [['work', 1], ['character', 2], ['style', 3]]) {
      if (kind === 'style') {
        const form = new FormData();
        form.append('files', new Blob([await readFile(app.uploadFixture)], { type: 'image/png' }), 'manage-initial-style-cover.png');
        const uploadResponse = await fetch(`${app.baseUrl}/api/items/style/${id}/images`, {
          method: 'POST',
          headers: { accept: 'application/json', 'x-request-id': 'manage-initial-cover-style-upload' },
          body: form
        });
        assert.equal(uploadResponse.status, 201);
      }
      const snapshotResponse = await fetch(`${app.baseUrl}/api/items/${kind}/${id}/images`, { headers: { accept: 'application/json', 'x-request-id': `manage-initial-cover-${kind}-snapshot` } });
      assert.equal(snapshotResponse.status, 200);
      const snapshot = await snapshotResponse.json();
      assert.ok(snapshot.data.images[0]?.id);
      const coverResponse = await fetch(`${app.baseUrl}/api/items/${kind}/${id}/cover`, {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-request-id': `manage-initial-cover-${kind}-set` },
        body: JSON.stringify({ id: snapshot.data.images[0].id })
      });
      assert.equal(coverResponse.status, 200);
    }
    await page.goto(`${app.baseUrl}/app/web/manage.html`, { waitUntil: 'networkidle' });
    const images = page.locator('#manage-list .manage-card [data-media-image]');
    await images.first().waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await images.count(), 3);
    const elements = await images.elementHandles();
    await page.waitForFunction((targets) => targets.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0), elements);
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});

test('管理页真实启动联调覆盖三类目录、作品关系、上传、封面和删除', async () => {
  const app = await startTestApp();
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const managementListRequests = [];
  const mediaWriteRequests = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/manage/items') managementListRequests.push(request.url());
    if (new URL(request.url()).pathname.startsWith('/api/items/') && request.method() === 'PUT') {
      mediaWriteRequests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    }
  });
  try {
    await page.goto(`${app.baseUrl}/app/web/manage.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.manage-card', { timeout: 5_000 });
    assert.equal(await page.locator('.manage-card').count(), 3);
    const workCard = page.locator('.manage-card[data-item^="work:"]');
    await workCard.getByRole('button', { name: '编辑' }).click();
    const editor = page.locator('#manage-detail');
    await editor.waitFor({ state: 'visible' });
    await editor.locator('#detail-title').filter({ hasText: '编辑作品' }).waitFor();
    assert.match(await editor.locator('#detail-title').textContent(), /编辑作品/u);

    const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/items/work/1/images'
      && response.status() === 201);
    await editor.locator('#manage-image-upload').setInputFiles(app.uploadFixture);
    await uploadResponse;
    await editor.getByRole('button', { name: '管理图片' }).click();
    const imageManager = page.locator('#manage-image-manager');
    await imageManager.waitFor({ state: 'visible' });
    assert.equal(await imageManager.locator('.image-manager-card').count(), 2);
    assert.equal(await imageManager.getByRole('button', { name: '添加图片' }).count(), 2);

    await imageManager.locator('.image-manager-preview').nth(1).click();
    const preview = page.locator('#manage-image-preview');
    await preview.waitFor({ state: 'visible' });
    const renderedImageBounds = await preview.locator('#manage-image-preview-image').evaluate((image) => ({
      objectFit: getComputedStyle(image).objectFit,
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight
    }));
    assert.deepEqual(renderedImageBounds, { objectFit: 'contain', complete: true, naturalWidth: 1, naturalHeight: 1 });
    assert.match(await preview.locator('#manage-image-preview-image').getAttribute('src'), /\/media\/images\/[0-9a-f]{2}\//u);
    await preview.getByRole('button', { name: '显示上一张图' }).click();
    assert.match(await preview.locator('#manage-image-preview-count').textContent(), /图片 1 \/ 2/u);
    await preview.getByRole('button', { name: '关闭原图预览' }).click();

    const coverButton = imageManager.getByRole('button', { name: '设为封面' }).last();
    const selectedImageIndex = Number(await coverButton.getAttribute('data-image-index'));
    await coverButton.click();
    const coverWrite = mediaWriteRequests.find((request) => request.path.endsWith('/cover'));
    const mediaSnapshot = await (await fetch(`${app.baseUrl}/api/items/work/1/images`)).json();
    assert.deepEqual(coverWrite?.body, { id: mediaSnapshot.data.images[selectedImageIndex].id });
    await imageManager.getByRole('button', { name: '删除' }).last().click();
    await page.locator('#manage-confirm').getByRole('button', { name: '确认删除' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#manage-image-manager-grid .image-manager-card').length === 1);
    await imageManager.getByRole('button', { name: '完成' }).click();
    await page.locator('[data-action="close-detail"]').click();

    const characterCard = page.locator('.manage-card[data-item^="character:"]');
    await characterCard.getByRole('button', { name: '编辑' }).click();
    await editor.locator('#detail-title').filter({ hasText: '编辑角色' }).waitFor();
    await page.locator('#manage-work-trigger').click();
    await page.locator('#manage-work-search').fill('联调');
    assert.equal(await page.locator('#manage-work-options [data-action="select-work"]').count(), 1);
    await page.locator('#manage-work-options [data-action="select-work"]').click();
    assert.match(await page.locator('#manage-work-trigger').textContent(), /联调作品/u);
    await page.locator('[data-action="close-detail"]').click();

    await workCard.getByRole('button', { name: '编辑' }).click();
    await editor.locator('#detail-title').filter({ hasText: '编辑作品' }).waitFor();
    await page.locator('#manage-editor-delete').click();
    const listRequestCountBeforeBatchDelete = managementListRequests.length;
    const deletionResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/items/batch-delete'
      && response.status() === 200);
    const refreshResponse = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/manage/items'
      && new URL(response.url()).searchParams.get('page') === '1'
      && response.status() === 200);
    await page.locator('#manage-confirm [data-action="confirm-delete"]').click();
    await deletionResponse;
    await refreshResponse;
    assert.equal(await page.locator('.manage-card').count(), 1);
    assert.equal(managementListRequests.length, listRequestCountBeforeBatchDelete + 1);
    await mkdir(evidenceRoot, { recursive: true });
    await page.screenshot({ path: join(evidenceRoot, 'manage-closed-loop.png'), fullPage: true });
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});
