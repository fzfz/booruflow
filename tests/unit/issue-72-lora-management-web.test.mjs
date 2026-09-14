import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const sharedSource = await readFile(new URL('../../app/web/assets/generation-resource-shared.js', import.meta.url), 'utf8');
const loraFormValuesSource = await readFile(new URL('../../app/web/assets/lora-form-values.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../../app/web/assets/lora-management.js', import.meta.url), 'utf8');
const httpClientSource = await readFile(new URL('../../app/web/assets/http-client.js', import.meta.url), 'utf8');
const paginationSource = await readFile(new URL('../../app/web/assets/pagination.js', import.meta.url), 'utf8');
const executableSharedSource = sharedSource.replace(/^export .*?;\n/gmu, '');
const executableLoraFormValuesSource = loraFormValuesSource.replace(/^export /gmu, '');
const executablePageSource = pageSource.replace(/^import .*?;\n/gmu, '');

function element() {
  const listeners = new Map();
  return {
    id: '', innerHTML: '', textContent: '', hidden: false, disabled: false, open: false, value: '', dataset: {},
    showCalls: 0, showModalCalls: 0,
    listeners, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name] ?? null; }, removeAttribute(name) { delete this[name]; },
    addEventListener(type, listener) { listeners.set(type, listener); }, querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return { contains() { return false; } }; }, dispatchEvent() {}, focus() {}, scrollIntoView() {},
    close() { this.open = false; },
    show() { this.open = true; this.showCalls += 1; },
    showModal() { this.open = true; this.showModalCalls += 1; },
    reset() {}
  };
}

function loadPage() {
  const ids = [
    'lora-status', 'lora-error', 'lora-list', 'lora-pagination', 'lora-search', 'lora-filter-base-model', 'lora-filter-model',
    'lora-filter-file-format', 'lora-filter-file-format-listbox', 'lora-filter-precision', 'lora-filter-precision-listbox',
    'lora-file-format', 'lora-file-format-listbox', 'lora-precision', 'lora-precision-listbox',
    'lora-editor', 'lora-editor-title', 'lora-editor-subtitle', 'lora-editor-error', 'lora-form', 'lora-media-section', 'lora-image-list',
    'lora-media-status', 'lora-image-upload', 'lora-editor-delete', 'lora-editor-submit'
  ];
  const elements = new Map(ids.map((id) => [id, element()]));
  for (const [id, value] of elements) value.id = id;
  const fields = new Map([
    ['base_model_id', Object.assign(element(), { value: '1' })],
    ['model_id', Object.assign(element(), { value: '2' })],
    ['file_name', Object.assign(element(), { value: 'issue-72-empty-weight.safetensors' })],
    ['file_format', Object.assign(element(), { value: 'safetensors' })],
    ['precision_or_quantization', Object.assign(element(), { value: 'fp16' })],
    ['author', element()],
    ['version', element()],
    ['release_url', element()],
    ['description', Object.assign(element(), { value: 'Issue 72 description' })],
    ['usage', Object.assign(element(), { value: 'Issue 72 usage' })],
    ['trigger_words', Object.assign(element(), { value: 'issue 72 trigger' })],
    ['weight', element()]
  ]);
  const form = elements.get('lora-form');
  form.elements = { namedItem(name) { return fields.get(name); } };
  fields.get('file_format').id = 'lora-file-format';
  fields.get('precision_or_quantization').id = 'lora-precision';
  elements.set('lora-file-format', fields.get('file_format'));
  elements.set('lora-precision', fields.get('precision_or_quantization'));
  const listeners = new Map();
  const calls = [];
  const document = {
    querySelector(selector) { return selector.startsWith('#') ? elements.get(selector.slice(1)) : element(); },
    querySelectorAll() { return []; },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  const sandbox = {
    MANAGEMENT_LIST_PAGE_CONFIG: { loras: { pageSize: 16 } },
    bindManagementFilterForm() {},
    __NOOBAI_URLS__: Object.freeze({ config: Object.freeze({ http_request_timeout_ms: 15000 }), api: (path) => new URL(path, 'https://app.example.test/api/') }),
    __NOOBAI_HTTP__: undefined, document, URL, URLSearchParams, Headers, AbortController, Date, Math, Object, Array, Set, Promise, Error, FormData,
    setTimeout() { return 1; }, clearTimeout() {}, console
  };
  sandbox.globalThis = sandbox;
  sandbox.fetch = (path, options) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
  vm.runInNewContext(httpClientSource, sandbox, { filename: 'app/web/assets/http-client.js' });
  vm.runInNewContext(paginationSource, sandbox, { filename: 'app/web/assets/pagination.js' });
  vm.runInNewContext(`${executableSharedSource}\n${executableLoraFormValuesSource}\n${executablePageSource}`, sandbox, { filename: 'app/web/assets/lora-management.js' });
  elements.get('lora-editor').open = true;
  return { calls, elements, fields, sandbox, listeners };
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function success(call, data) {
  call.resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, request_id: call.options.headers.get('x-request-id'), data }) });
}

function failure(call, status, code) {
  call.resolve({
    status,
    ok: false,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: false, error: { code, message: `fixture ${code}` } })
  });
}

test('LoRA 管理页点击卡片详情后打开模态编辑器', () => {
  const { elements, listeners } = loadPage();
  const editor = elements.get('lora-editor');
  editor.open = false;

  listeners.get('click')({
    target: {
      closest() { return { disabled: false, dataset: { action: 'open-lora-detail', id: '803' } }; }
    }
  });

  assert.equal(editor.showCalls, 0);
  assert.equal(editor.showModalCalls, 1);
});

test('LoRA 空默认模型权重在提交前显示字段校验错误并且不发送 POST 请求', async () => {
  const { calls, elements, fields } = loadPage();
  await flush();
  assert.equal(calls.length, 4);
  for (const call of calls) {
    const pathname = new URL(call.path).pathname;
    if (pathname === '/manage/generation-resource-options') {
      success(call, { file_format_suggestions: [], precision_or_quantization_suggestions: [] });
    } else {
      success(call, { items: [], page: 1, page_size: pathname === '/manage/loras' ? 16 : 100, total_count: 0 });
    }
  }
  await flush();

  elements.get('lora-form').listeners.get('submit')({ preventDefault() {} });
  await flush();

  assert.equal(elements.get('lora-editor-error').hidden, false);
  assert.equal(elements.get('lora-editor-error').textContent, '默认模型权重不能为空。');
  assert.equal(fields.get('weight').disabled, false);
  assert.equal(fields.get('file_name').disabled, false);
  assert.equal(fields.get('file_name').value, 'issue-72-empty-weight.safetensors');
  assert.equal(calls.some((call) => call.options.method === 'POST' && new URL(call.path).pathname === '/manage/loras'), false);
});

test('LoRA 和画师串共享四类管理写入模型错误中文文案', () => {
  const { sandbox } = loadPage();
  const expectedFragments = new Map([
    ['EMBEDDING_UNAVAILABLE', 'Embedding 服务暂时不可用'],
    ['MODEL_RATE_LIMITED', '请求受到限制'],
    ['EMBEDDING_TIMEOUT', '响应超时'],
    ['MODEL_PROTOCOL_ERROR', '无法识别的数据']
  ]);
  for (const [code, fragment] of expectedFragments) {
    const loraMessage = sandbox.friendlyManagementError('保存 LoRA', { code });
    const artistMessage = sandbox.friendlyManagementError('保存画师串', { code });
    assert.match(loraMessage, new RegExp(fragment, 'u'), code);
    assert.equal(loraMessage.slice(loraMessage.indexOf('：') + 1), artistMessage.slice(artistMessage.indexOf('：') + 1), code);
  }
});

test('LoRA 提交模型错误后保留编辑器和当前表单内容', async () => {
  const { calls, elements, fields } = loadPage();
  await flush();
  success(calls[0], { items: [], page: 1, page_size: 100, total_count: 0 });
  success(calls[1], { items: [], page: 1, page_size: 100, total_count: 0 });
  success(calls[2], { items: [], page: 1, page_size: 20, total_count: 0 });
  await flush();

  fields.get('weight').value = '0.75';
  fields.get('file_name').value = 'keep-after-model-error.safetensors';
  elements.get('lora-form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  const writeCall = calls.find((call) => call.options.method === 'POST' && new URL(call.path).pathname === '/manage/loras');
  assert.ok(writeCall);
  failure(writeCall, 504, 'EMBEDDING_TIMEOUT');
  await flush();

  assert.equal(elements.get('lora-editor').open, true);
  assert.equal(fields.get('file_name').value, 'keep-after-model-error.safetensors');
  assert.equal(fields.get('description').value, 'Issue 72 description');
  assert.equal(elements.get('lora-editor-error').hidden, false);
  assert.match(elements.get('lora-editor-error').textContent, /响应超时/u);
});
