import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const sharedSource = await readFile(new URL('../../app/web/assets/generation-resource-shared.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../../app/web/assets/base-model-management.js', import.meta.url), 'utf8');
const executableSharedSource = sharedSource.replace(/^export .*?;\n/gmu, '');
const executablePageSource = pageSource.replace(/^import .*?;\n/gmu, '');
const httpClientSource = await readFile(new URL('../../app/web/assets/http-client.js', import.meta.url), 'utf8');
const paginationSource = await readFile(new URL('../../app/web/assets/pagination.js', import.meta.url), 'utf8');
const pageHtml = await readFile(new URL('../../app/web/base-models.html', import.meta.url), 'utf8');

function element() {
  const listeners = new Map();
  return {
    innerHTML: '', textContent: '', hidden: false, disabled: false, open: false, value: '', dataset: {},
    listeners, setAttribute() {}, addEventListener(type, listener) { listeners.set(type, listener); }, querySelectorAll() { return []; },
    close() { this.open = false; }, showModal() { this.open = true; }
  };
}

function loadPage() {
  const ids = [
    'base-model-status', 'base-model-error', 'base-model-list', 'base-model-pagination', 'base-model-search',
    'base-model-editor-title', 'base-model-editor-subtitle', 'base-model-name', 'base-model-editor', 'base-model-form', 'base-model-form-error',
    'base-model-editor-delete', 'base-model-record-panel', 'base-model-record-meta',
    'base-model-delete', 'base-model-cascade-list', 'base-model-retained-list', 'base-model-delete-target', 'base-model-delete-error'
  ];
  const elements = new Map(ids.map((id) => [id, element()]));
  const confirm = element();
  const cancel = element();
  const save = element();
  elements.set('base-model-editor-submit', save);
  elements.get('base-model-form').querySelectorAll = () => [cancel, save];
  const listeners = new Map();
  const calls = [];
  const document = {
    querySelector(selector) {
      if (selector === '#base-model-delete [data-action="confirm-delete"]') return confirm;
      if (selector === '#base-model-form [type="submit"]') return save;
      return selector.startsWith('#') ? elements.get(selector.slice(1)) : element();
    },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  const sandbox = {
    MANAGEMENT_LIST_PAGE_CONFIG: { baseModels: { pageSize: 16 } },
    bindManagementFilterForm() {},
    __NOOBAI_URLS__: Object.freeze({ config: Object.freeze({ http_request_timeout_ms: 15000 }), api: (path) => new URL(path, 'https://app.example.test/api/') }),
    __NOOBAI_HTTP__: undefined, document, URL, URLSearchParams, Headers, AbortController, Date, Math, Object, Array, Set, Promise, Error,
    applyRuntimeOptionSelections: (workflow) => workflow,
    presentRuntimeTestError: () => ({ replacement: null }),
    presentStaticRepairCandidate: () => ({ title: '', description: '' }),
    presentStaticWorkflowError: () => ({ title: '', description: '' }),
    setTimeout() { return 1; }, clearTimeout() {}, console
  };
  sandbox.globalThis = sandbox;
  sandbox.fetch = (path, options) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
  vm.runInNewContext(httpClientSource, sandbox, { filename: 'app/web/assets/http-client.js' });
  vm.runInNewContext(paginationSource, sandbox, { filename: 'app/web/assets/pagination.js' });
  vm.runInNewContext(`${executableSharedSource}\n${executablePageSource}`, sandbox, { filename: 'app/web/assets/base-model-management.js' });
  return { calls, cancel, confirm, elements, listeners, save };
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function success(call, data) {
  call.resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, request_id: call.options.headers.get('x-request-id'), data }) });
}

function failure(call, code, message) {
  call.resolve({ status: 409, ok: false, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, request_id: call.options.headers.get('x-request-id'), error: { code, message } }) });
}

test('底模删除后超出末页会回退重载最后有效页，并显示文件清理告警', async () => {
  const { calls, elements, listeners } = loadPage();
  const click = (action, data = {}) => listeners.get('click')({ target: { disabled: false, dataset: { action, ...data }, closest() { return this; } } });

  await flush();
  success(calls[0], { items: [{ id: 1, name: '末页底模' }], page: 2, page_size: 20, total_count: 21 });
  await flush();
  click('open-delete', { id: '1' });
  await flush();
  success(calls[1], { target: { id: 1, name: '末页底模' }, cascade_deleted: [], retained: [], impact_token: 'impact-token' });
  await flush();
  click('confirm-delete');
  await flush();
  success(calls[2], { target: { id: 1 }, cascade_deleted: [], retained: [], cleanup_warning: true, cleanup_failures: [{ path: 'images/model.png' }] });
  await flush();
  assert.equal(new URL(calls[3].path).searchParams.get('page'), '2');
  success(calls[3], { items: [], page: 2, page_size: 20, total_count: 20 });
  await flush();
  assert.equal(new URL(calls[4].path).searchParams.get('page'), '1');
  success(calls[4], { items: [{ id: 2, name: '最后有效页底模' }], page: 1, page_size: 20, total_count: 20 });
  await flush();
  assert.match(elements.get('base-model-list').innerHTML, /最后有效页底模/u);
  assert.match(elements.get('base-model-pagination').innerHTML, /第 1 页/u);
  assert.equal(elements.get('base-model-error').hidden, false);
  assert.match(elements.get('base-model-error').textContent, /资源图片文件等待后续清理/u);
});

test('底模列表请求失败时保持错误状态，不渲染空状态', async () => {
  const { calls, elements } = loadPage();
  await flush();
  calls[0].resolve({ status: 503, ok: false, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, request_id: calls[0].options.headers.get('x-request-id'), error: { code: 'DATABASE_BUSY', message: 'busy' } }) });
  await flush();
  assert.match(elements.get('base-model-list').innerHTML, /底模列表读取失败/u);
  assert.doesNotMatch(elements.get('base-model-list').innerHTML, /暂无匹配底模/u);
});

test('底模列表载入显示骨架而非普通载入文字', async () => {
  const { elements } = loadPage();
  await flush();
  assert.match(elements.get('base-model-list').innerHTML, /base-model-skeleton/u);
  assert.doesNotMatch(elements.get('base-model-list').innerHTML, /<p class="state-line"/u);
});

test('底模标题栏关闭按钮不提交保存请求', async () => {
  assert.match(pageHtml, /<button type="button" class="icon-button" data-action="close-editor" aria-label="关闭编辑弹窗">×<\/button>/u);
  assert.doesNotMatch(pageHtml, /data-action="close-editor">取消<\/button>/u);
  const { calls, elements, listeners } = loadPage();
  await flush();
  success(calls[0], { items: [], page: 1, page_size: 20, total_count: 0 });
  await flush();
  listeners.get('click')({ target: { disabled: false, dataset: { action: 'open-create' }, closest() { return this; } } });
  listeners.get('click')({ target: { disabled: false, dataset: { action: 'close-editor' }, closest() { return this; } } });
  await flush();
  assert.equal(elements.get('base-model-editor').open, false);
  assert.equal(calls.length, 1);
});

test('底模保存 pending 锁定会忽略同一表单的重复提交', async () => {
  const { calls, elements, listeners } = loadPage();
  await flush();
  success(calls[0], { items: [], page: 1, page_size: 20, total_count: 0 });
  await flush();
  listeners.get('click')({ target: { disabled: false, dataset: { action: 'open-create' }, closest() { return this; } } });
  elements.get('base-model-name').value = '单次提交';
  const submit = elements.get('base-model-form').listeners.get('submit');
  submit({ preventDefault() {} });
  submit({ preventDefault() {} });
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].path).pathname, '/manage/base-models');
  assert.equal(calls[1].options.method, 'POST');
});

test('旧保存响应不会让关闭后重新打开的编辑器底部按钮保持禁用', async () => {
  const { calls, cancel, elements, listeners, save } = loadPage();
  const click = (action) => listeners.get('click')({ target: { disabled: false, dataset: { action }, closest() { return this; } } });
  await flush();
  success(calls[0], { items: [], page: 1, page_size: 20, total_count: 0 });
  await flush();
  click('open-create');
  elements.get('base-model-name').value = '正在保存';
  elements.get('base-model-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  assert.equal(cancel.disabled, true);
  assert.equal(save.disabled, true);
  click('close-editor');
  click('open-create');
  assert.equal(cancel.disabled, false);
  assert.equal(save.disabled, false);
  elements.get('base-model-name').value = '新编辑器保存';
  elements.get('base-model-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  assert.equal(calls.length, 3);
  assert.match(calls[2].options.body, /新编辑器保存/u);
  success(calls[1], { id: 1, name: '正在保存' });
  await flush();
  assert.equal(cancel.disabled, true);
  assert.equal(save.disabled, true);
  success(calls[2], { id: 2, name: '新编辑器保存' });
  await flush();
  success(calls[3], { items: [{ id: 2, name: '新编辑器保存' }], page: 1, page_size: 20, total_count: 1 });
  await flush();
  assert.equal(cancel.disabled, false);
  assert.equal(save.disabled, false);
});

test('底模写入失败保留编辑器并显示可操作中文错误', async () => {
  const { calls, elements, listeners } = loadPage();
  await flush();
  success(calls[0], { items: [], page: 1, page_size: 20, total_count: 0 });
  await flush();
  listeners.get('click')({ target: { disabled: false, dataset: { action: 'open-create' }, closest() { return this; } } });
  elements.get('base-model-name').value = '重复名称';
  elements.get('base-model-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  failure(calls[1], 'DUPLICATE_RESOURCE', 'duplicate');
  await flush();
  assert.equal(elements.get('base-model-editor').open, true);
  assert.match(elements.get('base-model-form-error').textContent, /底模名称已存在.*修改名称后重试/u);
});

test('底模列表的迟到响应不会覆盖较新的列表读取结果', async () => {
  const { calls, elements, listeners } = loadPage();
  const click = (action) => listeners.get('click')({ target: { disabled: false, dataset: { action }, closest() { return this; } } });
  await flush();
  click('next-page');
  await flush();
  success(calls[1], { items: [{ id: 2, name: 'B 最新列表' }], page: 2, page_size: 20, total_count: 40 });
  await flush();
  success(calls[0], { items: [{ id: 1, name: 'A 迟到列表' }], page: 1, page_size: 20, total_count: 20 });
  await flush();
  assert.match(elements.get('base-model-list').innerHTML, /B 最新列表/u);
  assert.doesNotMatch(elements.get('base-model-list').innerHTML, /A 迟到列表/u);
});

test('底模详情与删除影响预览的迟到响应不会覆盖当前目标或误删旧目标', async () => {
  const { calls, elements, listeners } = loadPage();
  const click = (action, data = {}) => listeners.get('click')({ target: { disabled: false, dataset: { action, ...data }, closest() { return this; } } });
  await flush();
  success(calls[0], { items: [], page: 1, page_size: 20, total_count: 0 });
  await flush();
  click('open-detail', { id: '1' });
  click('open-detail', { id: '2' });
  await flush();
  success(calls[2], { id: 2, name: 'B 当前详情' });
  await flush();
  success(calls[1], { id: 1, name: 'A 迟到详情' });
  await flush();
  assert.equal(elements.get('base-model-name').value, 'B 当前详情');

  click('open-delete', { id: '1' });
  click('open-delete', { id: '2' });
  await flush();
  success(calls[4], { target: { id: 2, name: 'B 当前底模' }, cascade_deleted: [], retained: [], impact_token: 'B-token' });
  await flush();
  success(calls[3], { target: { id: 1, name: 'A 迟到底模' }, cascade_deleted: [], retained: [], impact_token: 'A-token' });
  await flush();
  assert.match(elements.get('base-model-delete-target').textContent, /B 当前底模/u);
  assert.doesNotMatch(elements.get('base-model-delete-target').textContent, /A 迟到底模/u);
  click('confirm-delete');
  await flush();
  assert.equal(new URL(calls[5].path).pathname, '/manage/base-models/2');
  assert.match(calls[5].options.body, /B-token/u);
});

test('底模详情加载期间锁定编辑和保存，加载完成后才允许完整更新', async () => {
  const { calls, elements, listeners, save } = loadPage();
  const click = (action, data = {}) => listeners.get('click')({ target: { disabled: false, dataset: { action, ...data }, closest() { return this; } } });
  await flush();
  success(calls[0], { items: [{ id: 1, name: 'E2E WAI' }], page: 1, page_size: 20, total_count: 1 });
  await flush();
  click('open-detail', { id: '1' });
  await flush();
  assert.equal(elements.get('base-model-name').disabled, true);
  assert.equal(save.disabled, true);
  elements.get('base-model-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  assert.equal(calls.length, 2);
  success(calls[1], { id: 1, name: 'E2E WAI' });
  await flush();
  assert.equal(elements.get('base-model-name').disabled, false);
  assert.equal(save.disabled, false);
  elements.get('base-model-name').value = 'E2E WAI Updated';
  elements.get('base-model-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  assert.equal(new URL(calls[2].path).pathname, '/manage/base-models/1');
});

test('底模详情读取失败时保持锁定，不能提交不完整更新', async () => {
  const { calls, elements, listeners, save } = loadPage();
  const click = (action, data = {}) => listeners.get('click')({ target: { disabled: false, dataset: { action, ...data }, closest() { return this; } } });
  await flush();
  success(calls[0], { items: [{ id: 1, name: 'E2E WAI' }], page: 1, page_size: 20, total_count: 1 });
  await flush();
  click('open-detail', { id: '1' });
  await flush();
  failure(calls[1], 'DATABASE_BUSY', 'busy');
  await flush();
  assert.equal(elements.get('base-model-name').disabled, true);
  assert.equal(save.disabled, true);
  assert.equal(elements.get('base-model-form-error').hidden, false);
  assert.notEqual(elements.get('base-model-form-error').textContent, 'busy');
  elements.get('base-model-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  assert.equal(calls.length, 2);
});

test('底模保存迟到响应不会关闭或刷新已经切换的编辑器', async () => {
  const { calls, elements, listeners } = loadPage();
  const click = (action, data = {}) => listeners.get('click')({ target: { disabled: false, dataset: { action, ...data }, closest() { return this; } } });
  await flush();
  success(calls[0], { items: [], page: 1, page_size: 20, total_count: 0 });
  await flush();
  click('open-detail', { id: '1' });
  await flush();
  success(calls[1], { id: 1, name: 'A' });
  await flush();
  elements.get('base-model-name').value = 'A 修改';
  elements.get('base-model-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  click('open-detail', { id: '2' });
  await flush();
  success(calls[3], { id: 2, name: 'B 当前编辑器' });
  await flush();
  success(calls[2], { id: 1, name: 'A 修改' });
  await flush();
  assert.equal(elements.get('base-model-editor').open, true);
  assert.equal(elements.get('base-model-name').value, 'B 当前编辑器');
  assert.equal(calls.length, 4);
});

test('关闭删除弹窗后，已完成的删除仍刷新列表并显示清理告警；失败仍显示全局错误', async () => {
  const { calls, elements, listeners } = loadPage();
  const click = (action, data = {}) => listeners.get('click')({ target: { disabled: false, dataset: { action, ...data }, closest() { return this; } } });
  await flush();
  success(calls[0], { items: [{ id: 1, name: '待删' }], page: 1, page_size: 20, total_count: 1 });
  await flush();
  click('open-delete', { id: '1' });
  await flush();
  success(calls[1], { target: { id: 1, name: '待删' }, cascade_deleted: [], retained: [], impact_token: 'token' });
  await flush();
  click('confirm-delete');
  await flush();
  click('close-delete');
  success(calls[2], { target: { id: 1 }, cascade_deleted: [], retained: [], cleanup_warning: true, cleanup_failures: [{ audit_error: 'audit unavailable' }] });
  await flush();
  success(calls[3], { items: [], page: 1, page_size: 20, total_count: 0 });
  await flush();
  assert.match(elements.get('base-model-error').textContent, /清理审计未能持久化/u);

  click('open-delete', { id: '2' });
  await flush();
  success(calls[4], { target: { id: 2, name: '失败目标' }, cascade_deleted: [], retained: [], impact_token: 'token-2' });
  await flush();
  click('confirm-delete');
  await flush();
  click('close-delete');
  failure(calls[5], 'DATABASE_BUSY', 'busy');
  await flush();
  assert.match(elements.get('base-model-error').textContent, /删除暂时无法完成.*稍后重试/u);
});
