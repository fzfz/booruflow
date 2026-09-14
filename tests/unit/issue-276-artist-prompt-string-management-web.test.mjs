import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const sharedSource = await readFile(new URL('../../app/web/assets/generation-resource-shared.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../../app/web/assets/artist-prompt-string-management.js', import.meta.url), 'utf8');
const httpClientSource = await readFile(new URL('../../app/web/assets/http-client.js', import.meta.url), 'utf8');
const paginationSource = await readFile(new URL('../../app/web/assets/pagination.js', import.meta.url), 'utf8');
const executableSharedSource = sharedSource.replace(/^export .*?;\n/gmu, '');
const executablePageSource = pageSource.replace(/^import .*?;\n/gmu, '');

function element(properties = {}) {
  const listeners = new Map();
  return {
    innerHTML: '', textContent: '', hidden: false, disabled: false, open: false, value: '', dataset: {}, options: [], selectedOptions: [],
    showCalls: 0, showModalCalls: 0,
    listeners,
    setAttribute() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    querySelectorAll() { return []; },
    close() { this.open = false; },
    show() { this.open = true; this.showCalls += 1; },
    showModal() { this.open = true; this.showModalCalls += 1; },
    reset() {},
    ...properties
  };
}

function loadPage() {
  const ids = [
    'artist-status', 'artist-error', 'artist-list', 'artist-pagination', 'artist-search', 'artist-editor', 'artist-editor-title', 'artist-editor-subtitle',
    'artist-editor-error', 'artist-form', 'artist-media-section', 'artist-image-list', 'artist-media-status', 'artist-image-upload',
    'artist-editor-delete', 'artist-editor-submit', 'artist-style-trigger', 'artist-style-panel', 'artist-style-search',
    'artist-style-summary', 'artist-style-count', 'artist-style-selection-count', 'artist-style-selected', 'artist-style-options'
  ];
  const elements = new Map(ids.map((id) => [id, element()]));
  const fields = new Map([
    ['title', Object.assign(element(), { value: 'Keep artist title' })],
    ['description', Object.assign(element(), { value: 'Keep artist description' })],
    ['artist_string', Object.assign(element(), { value: 'keep_artist:1.0' })],
    ['base_model_id', Object.assign(element(), { value: '' })],
    ['style_ids', Object.assign(element(), { value: '', selectedOptions: [] })]
  ]);
  const form = elements.get('artist-form');
  form.elements = { namedItem(name) { return fields.get(name); } };
  form.querySelectorAll = () => [];
  const documentListeners = new Map();
  const calls = [];
  const document = {
    querySelector(selector) { return selector.startsWith('#') ? elements.get(selector.slice(1)) : element(); },
    querySelectorAll() { return []; },
    addEventListener(type, listener) { documentListeners.set(type, listener); }
  };
  const sandbox = {
    MANAGEMENT_LIST_PAGE_CONFIG: { artists: { pageSize: 16 } },
    bindManagementFilterForm() {},
    __NOOBAI_URLS__: Object.freeze({ config: Object.freeze({ http_request_timeout_ms: 15000 }), api: (path) => new URL(path, 'https://app.example.test/api/') }),
    __NOOBAI_HTTP__: undefined, document, URL, URLSearchParams, Headers, AbortController, Date, Math, Object, Array, Set, Promise, Error, FormData,
    setTimeout() { return 1; }, clearTimeout() {}, console
  };
  sandbox.globalThis = sandbox;
  sandbox.fetch = (path, options) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
  vm.runInNewContext(httpClientSource, sandbox, { filename: 'app/web/assets/http-client.js' });
  vm.runInNewContext(paginationSource, sandbox, { filename: 'app/web/assets/pagination.js' });
  vm.runInNewContext(`${executableSharedSource}\n${executablePageSource}`, sandbox, { filename: 'app/web/assets/artist-prompt-string-management.js' });
  elements.get('artist-editor').open = true;
  return { calls, elements, fields, sandbox, documentListeners };
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function success(call, data) {
  call.resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, request_id: call.options.headers.get('x-request-id'), data }) });
}

function failure(call, status, code) {
  call.resolve({ status, ok: false, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, error: { code, message: `fixture ${code}` } }) });
}

test('画师串管理页点击卡片详情后打开模态编辑器', () => {
  const { elements, documentListeners } = loadPage();
  const editor = elements.get('artist-editor');
  editor.open = false;

  documentListeners.get('click')({
    target: {
      closest() { return { disabled: false, dataset: { action: 'open-artist-detail', id: '805' } }; }
    }
  });

  assert.equal(editor.showCalls, 0);
  assert.equal(editor.showModalCalls, 1);
});

test('画师串提交模型错误后保留编辑器和当前表单内容', async () => {
  const { calls, elements, fields } = loadPage();
  await flush();
  assert.equal(calls.length, 3);
  for (const call of calls) {
    const pathname = new URL(call.path).pathname;
    success(call, pathname === '/styles' ? { items: [] } : { items: [], page: 1, page_size: pathname === '/manage/artist-prompt-strings' ? 16 : 100, total_count: 0 });
  }
  await flush();

  fields.get('title').value = 'Keep artist title after error';
  fields.get('description').value = 'Keep artist description after error';
  fields.get('artist_string').value = 'keep_artist_after_error:1.0';
  elements.get('artist-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  const writeCall = calls.find((call) => call.options.method === 'POST' && new URL(call.path).pathname === '/manage/artist-prompt-strings');
  assert.ok(writeCall);
  failure(writeCall, 504, 'EMBEDDING_TIMEOUT');
  await flush();

  assert.equal(elements.get('artist-editor').open, true);
  assert.equal(fields.get('title').value, 'Keep artist title after error');
  assert.equal(fields.get('description').value, 'Keep artist description after error');
  assert.equal(fields.get('artist_string').value, 'keep_artist_after_error:1.0');
  assert.equal(elements.get('artist-editor-error').hidden, false);
  assert.match(elements.get('artist-editor-error').textContent, /响应超时/u);
});
