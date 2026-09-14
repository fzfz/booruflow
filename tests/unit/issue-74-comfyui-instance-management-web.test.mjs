import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const sharedSource = await readFile(new URL('../../app/web/assets/generation-resource-shared.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../../app/web/assets/comfyui-instance-management.js', import.meta.url), 'utf8');
const httpClientSource = await readFile(new URL('../../app/web/assets/http-client.js', import.meta.url), 'utf8');
const paginationSource = await readFile(new URL('../../app/web/assets/pagination.js', import.meta.url), 'utf8');
const executableSharedSource = sharedSource.replace(/^export .*?;\n/gmu, '');
const executablePageSource = pageSource.replace(/^import .*?;\n/gmu, '');

function element(properties = {}) {
  const listeners = new Map();
  return {
    innerHTML: '', textContent: '', hidden: false, disabled: false, checked: false, open: false, value: '', dataset: {},
    showCalls: 0, showModalCalls: 0, listeners,
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
    'comfyui-instance-status', 'comfyui-instance-error', 'comfyui-instance-list', 'comfyui-instance-pagination',
    'comfyui-instance-search', 'comfyui-instance-editor', 'comfyui-instance-editor-title', 'comfyui-instance-editor-subtitle', 'comfyui-instance-form',
    'comfyui-instance-credential-fields', 'comfyui-instance-validation-status', 'comfyui-instance-editor-error',
    'comfyui-instance-editor-delete', 'comfyui-instance-editor-submit', 'comfyui-instance-record-panel', 'comfyui-instance-record-meta'
  ];
  const elements = new Map(ids.map((id) => [id, element()]));
  const fields = new Map([
    ['title', element()],
    ['url', element()],
    ['credential_type', Object.assign(element(), { value: 'none' })],
    ['is_enabled', element()]
  ]);
  const form = elements.get('comfyui-instance-form');
  form.elements = { namedItem(name) { return fields.get(name); } };
  const documentListeners = new Map();
  const calls = [];
  const document = {
    querySelector(selector) { return selector.startsWith('#') ? elements.get(selector.slice(1)) : element(); },
    addEventListener(type, listener) { documentListeners.set(type, listener); }
  };
  const sandbox = {
    MANAGEMENT_LIST_PAGE_CONFIG: { comfyuiInstances: { pageSize: 16 } },
    bindManagementFilterForm() {},
    __NOOBAI_URLS__: Object.freeze({
      config: Object.freeze({ http_request_timeout_ms: 15000 }),
      api: (path) => new URL(path, 'https://app.example.test/api/')
    }),
    __NOOBAI_HTTP__: undefined,
    document, URL, URLSearchParams, Headers, AbortController, Date, Math, Object, Array, Set, Promise, Error,
    setTimeout() { return 1; }, clearTimeout() {}, console
  };
  sandbox.globalThis = sandbox;
  sandbox.fetch = (path, options) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
  vm.runInNewContext(httpClientSource, sandbox, { filename: 'app/web/assets/http-client.js' });
  vm.runInNewContext(paginationSource, sandbox, { filename: 'app/web/assets/pagination.js' });
  vm.runInNewContext(`${executableSharedSource}\n${executablePageSource}`, sandbox, { filename: 'app/web/assets/comfyui-instance-management.js' });
  return { elements, documentListeners };
}

test('ComfyUI 实例管理页点击卡片详情后打开模态编辑器', () => {
  const { elements, documentListeners } = loadPage();
  const editor = elements.get('comfyui-instance-editor');

  documentListeners.get('click')({
    target: {
      closest() { return { disabled: false, dataset: { action: 'open-comfyui-instance-detail', id: '74' } }; }
    }
  });

  assert.equal(editor.showCalls, 0);
  assert.equal(editor.showModalCalls, 1);
});
