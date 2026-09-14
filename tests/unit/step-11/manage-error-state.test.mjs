import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const manageSource = await readFile(new URL('../../../app/web/assets/manage.js', import.meta.url), 'utf8');
const manageHtml = await readFile(new URL('../../../app/web/manage.html', import.meta.url), 'utf8');
const sharedSource = await readFile(new URL('../../../app/web/assets/generation-resource-shared.js', import.meta.url), 'utf8');
const executableManageSource = manageSource.replace(/^import .*?;\n/gmu, '');
const httpClientSource = await readFile(new URL('../../../app/web/assets/http-client.js', import.meta.url), 'utf8');
const paginationSource = await readFile(new URL('../../../app/web/assets/pagination.js', import.meta.url), 'utf8');

function element() {
  return {
    innerHTML: '', textContent: '', hidden: false, disabled: false, open: false, value: '', checked: false, files: [], dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, addEventListener() {}, focus() {}, click() {},
    querySelectorAll() { return []; },
    close() { this.open = false; }, showModal() { this.open = true; }
  };
}

function loadManage() {
  const ids = [
    'manage-status', 'manage-error', 'manage-list', 'manage-pagination', 'manage-search', 'manage-kind', 'manage-base-model',
    'manage-availability', 'manage-filter-form', 'manage-detail', 'manage-confirm', 'confirm-title', 'confirm-copy',
    'detail-title', 'detail-subtitle', 'manage-create-kind-field', 'manage-create-kind', 'manage-editor-delete',
    'manage-editor-submit', 'manage-editor-form', 'manage-editor-fields', 'manage-record-info', 'manage-editor-status',
    'manage-editor-error', 'manage-editor-media', 'manage-image-list', 'manage-image-manager', 'manage-image-manager-range',
    'manage-image-manager-grid', 'manage-image-preview', 'manage-image-preview-image', 'manage-image-preview-count',
    'manage-cover-upload', 'manage-image-upload', 'manage-media-status'
  ];
  const elements = new Map(ids.map((id) => [id, element()]));
  elements.get('manage-kind').value = 'all';
  elements.get('manage-editor-form').elements = { namedItem: () => element() };
  const actionElements = new Map();
  const listeners = new Map();
  const calls = [];
  let filterBinding = null;
  const document = {
    querySelector(selector) {
      if (selector.startsWith('#')) return elements.get(selector.slice(1));
      if (selector.startsWith('[data-action=')) {
        if (!actionElements.has(selector)) actionElements.set(selector, element());
        return actionElements.get(selector);
      }
      return element();
    },
    querySelectorAll() { return []; },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  const sandbox = {
    MANAGEMENT_LIST_PAGE_CONFIG: { catalog: { pageSize: 16 } },
    mediaRangeLabel: ({ start, end, total }) => total === 0 ? '暂无图片' : `图片 ${start + 1}–${end} / ${total}`,
    mediaWindow: (items, page = 0) => {
      const totalPages = Math.max(1, Math.ceil(items.length / 3));
      const safePage = Math.max(0, Math.min(page, totalPages - 1));
      const start = safePage * 3; const values = items.slice(start, start + 3);
      return { items: values, start, end: start + values.length, total: items.length, totalPages, page: safePage };
    },
    imageManagerEmptySlots: () => '<button class="image-manager-add">添加图片</button>',
    managementListReadyStatus: ({ page, totalPages, totalCount }, pageSize) => ({ page, totalPages, totalCount, pageSize }),
    renderManagementListStatus(element, status, busy = false) {
      element.setAttribute('aria-busy', String(busy));
      if (typeof status === 'string') element.textContent = status;
      else element.innerHTML = `<strong>共 ${status.totalCount} 条记录</strong><span>第 ${status.page} / ${status.totalPages} 页 · 每页 ${status.pageSize} 条</span>`;
    },
    bindManagementFilterForm(options) { filterBinding = options; },
    __NOOBAI_URLS__: Object.freeze({ config: Object.freeze({ http_request_timeout_ms: 15000 }), api: (path) => new URL(path, 'https://app.example.test/api/'), media: (path) => new URL(path, 'https://app.example.test/media/') }),
    __NOOBAI_HTTP__: undefined, document, URL, URLSearchParams, Headers, FormData, AbortController, Date, Math, Object, Array, Set, Promise, Error,
    setTimeout, clearTimeout, console
  };
  sandbox.globalThis = sandbox;
  sandbox.fetch = (path, options) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
  vm.runInNewContext(httpClientSource, sandbox, { filename: 'app/web/assets/http-client.js' });
  vm.runInNewContext(paginationSource, sandbox, { filename: 'app/web/assets/pagination.js' });
  vm.runInNewContext(executableManageSource, sandbox, { filename: 'app/web/assets/manage.js' });
  return { calls, elements, listeners, get filterBinding() { return filterBinding; } };
}

async function flush() {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function success(call, data) {
  call.resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, request_id: call.options.headers.get('x-request-id'), data }) });
}

async function bootstrap(manage, catalog) {
  await flush();
  assert.equal(manage.calls.length, 3, '关系选项和目录必须并行读取');
  success(manage.calls[0], { items: [], page: 1, page_size: 100, total_count: 0 });
  success(manage.calls[1], { items: [], page: 1, page_size: 100, total_count: 0 });
  success(manage.calls[2], catalog);
  await flush();
}

test('管理目录的下一页失败时保留当前页目录并显示可恢复的传输错误', async () => {
  const manage = loadManage();
  await bootstrap(manage, { items: [{ kind: 'work', id: 1, name: '已加载作品', aliases: [], category_name: null, image_count: 0, is_available: true }], total_count: 60, page: 1, page_size: 16 });
  assert.match(manage.elements.get('manage-pagination').innerHTML, /共 60 项 \/ 4 页/u);
  manage.listeners.get('click')({ target: { disabled: false, dataset: { action: 'next-page' }, closest() { return this; } } });
  await flush();
  manage.calls[3].reject(new Error('offline'));
  await flush();
  assert.match(manage.elements.get('manage-list').innerHTML, /已加载作品/u);
  assert.match(manage.elements.get('manage-error').textContent, /页面内容已经保留/u);
  assert.match(manage.elements.get('manage-error').textContent, /下一步：/u);
});

test('管理目录按总页数渲染省略号，并允许页码、上一页和下一页直接跳转', async () => {
  const manage = loadManage();
  await bootstrap(manage, { items: [{ kind: 'work', id: 1, name: '第一页', aliases: [], category_name: null, image_count: 0, is_available: true }], total_count: 128, page: 1, page_size: 16 });
  assert.match(manage.elements.get('manage-pagination').innerHTML, />第 1 页<.*>2<.*>3<.*>4<.*>5<.*>…<.*>8</u);
  const event = (action, data = {}) => manage.listeners.get('click')({ target: { disabled: false, dataset: { action, ...data }, closest() { return this; } } });
  event('go-page', { page: '4' }); await flush();
  assert.equal(new URL(manage.calls[3].path).searchParams.get('page'), '4');
  success(manage.calls[3], { items: [{ kind: 'work', id: 4, name: '第四页', aliases: [], category_name: null, image_count: 0, is_available: true }], total_count: 128, page: 4, page_size: 16 });
  await flush();
  event('next-page'); await flush();
  assert.equal(new URL(manage.calls[4].path).searchParams.get('page'), '5');
  success(manage.calls[4], { items: [], total_count: 128, page: 5, page_size: 16 });
  await flush();
  event('previous-page'); await flush();
  assert.equal(new URL(manage.calls[5].path).searchParams.get('page'), '4');
});

test('管理目录只在搜索表单提交后请求，读取失败时不清空旧目录', async () => {
  const manage = loadManage();
  await bootstrap(manage, { items: [{ kind: 'work', id: 1, name: '已有目录', aliases: [], category_name: null, image_count: 0, is_available: true }], total_count: 60, page: 2, page_size: 16 });
  manage.elements.get('manage-search').value = '下一次查询';
  await flush();
  assert.equal(manage.calls.length, 3, '输入搜索文本不得自动请求');
  const search = manage.filterBinding.onApply(); await flush();
  assert.equal(manage.calls.length, 4);
  assert.equal(new URL(manage.calls[3].path).searchParams.get('q'), '下一次查询');
  manage.calls[3].reject(new Error('offline'));
  await search;
  assert.match(manage.elements.get('manage-list').innerHTML, /已有目录/u);
  assert.match(manage.elements.get('manage-pagination').innerHTML, /aria-current="page"[^>]*>第 2 页/u);
});

test('角色画师管理页面使用新增编辑弹窗和完整图片交互，不再暴露批量删除控件', () => {
  assert.match(manageHtml, /id="manage-detail"[\s\S]*id="manage-editor-form"/u);
  assert.match(manageHtml, /id="manage-create-kind"[\s\S]*value="work"[\s\S]*value="character"[\s\S]*value="style"/u);
  assert.match(manageHtml, /data-action="close-detail"[\s\S]*id="manage-editor-delete"[\s\S]*id="manage-editor-submit"/u);
  assert.match(manageHtml, /id="manage-cover-upload"[^>]*accept="image\/jpeg,image\/png,image\/webp"/u);
  assert.match(manageHtml, /id="manage-image-manager"[\s\S]*id="manage-image-preview"/u);
  assert.doesNotMatch(manageHtml, /batch-delete|data-action="select"/u);
  assert.match(manageSource, /\/manage\/items\/\$\{item\.kind\}/u);
  assert.match(manageSource, /mediaWindow\(images, state\.managerPage\)/u);
  assert.match(manageSource, /imageManagerEmptySlots\(remaining/u);
  assert.match(sharedSource, /image-manager-add/u);
  assert.match(manageSource, /previous-image-preview[\s\S]*next-image-preview/u);
});
