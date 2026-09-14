import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const paginationSource = await readFile(new URL('../../app/web/assets/pagination.js', import.meta.url), 'utf8');

function loadPagination() {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(paginationSource, sandbox, { filename: 'app/web/assets/pagination.js' });
  return sandbox.__NOOBAI_PAGINATION__;
}

function createHarness(responses) {
  const pagination = loadPagination();
  const state = { items: [], page: 1, totalCount: 0, totalPages: 1, loading: false, listView: 'loading' };
  const events = [];
  const controller = pagination.createListController({
    state,
    fetchPage: async (page) => {
      events.push(['fetch', page]);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    render: () => events.push(['render', state.page, state.listView, state.loading]),
    setStatus: (message, busy) => events.push(['status', message, busy]),
    setError: (message) => events.push(['error', message]),
    loadingMessage: '正在载入模板……',
    emptyMessage: '暂无模板。',
    readyMessage: ({ page, totalPages, totalCount }) => `第 ${page} / ${totalPages} 页 · 共 ${totalCount} 个模板`,
    failureMessage: '模板列表读取失败。',
    errorMessage: (error) => `失败：${error.message}`
  });
  return { controller, events, pagination, state };
}

test('shared pagination commits a requested page only after a valid response', async () => {
  const { controller, state } = createHarness([
    { items: ['first'], page: 1, page_size: 20, total_count: 36 },
    { items: ['second'], page: 2, page_size: 20, total_count: 36 }
  ]);
  assert.equal(await controller.load(1), true);
  assert.deepEqual(state, { items: ['first'], page: 1, totalCount: 36, totalPages: 2, loading: false, listView: 'ready' });
  assert.equal(await controller.load(2), true);
  assert.deepEqual(state, { items: ['second'], page: 2, totalCount: 36, totalPages: 2, loading: false, listView: 'ready' });
});

test('shared pagination preserves the committed page and items after a failed page request and allows retry', async () => {
  const { controller, events, state } = createHarness([
    { items: ['first'], page: 1, page_size: 20, total_count: 36 },
    new Error('network unavailable'),
    { items: ['second'], page: 2, page_size: 20, total_count: 36 }
  ]);
  await controller.load(1);
  assert.equal(await controller.load(2), false);
  assert.deepEqual(state, { items: ['first'], page: 1, totalCount: 36, totalPages: 2, loading: false, listView: 'ready' });
  assert.equal(events.some((event) => event[0] === 'error' && event[1] === '失败：network unavailable'), true);
  assert.equal(await controller.load(2), true);
  assert.deepEqual(state.items, ['second']);
  assert.equal(state.page, 2);
});

test('shared pagination rejects malformed responses without destroying the committed page', async () => {
  const { controller, state } = createHarness([
    { items: ['first'], page: 1, page_size: 20, total_count: 36 },
    { items: [], page: 2, page_size: 0, total_count: 36 }
  ]);
  await controller.load(1);
  assert.equal(await controller.load(2), false);
  assert.deepEqual(state.items, ['first']);
  assert.equal(state.page, 1);
  assert.equal(state.totalPages, 2);
});

test('shared pagination retries the last valid page after deletion makes the requested page empty', async () => {
  const { controller, events, state } = createHarness([
    { items: [], page: 3, page_size: 20, total_count: 39 },
    { items: ['last'], page: 2, page_size: 20, total_count: 39 }
  ]);
  assert.equal(await controller.load(3, { fallbackToLastPage: true }), true);
  assert.deepEqual(events.filter(([kind]) => kind === 'fetch'), [['fetch', 3], ['fetch', 2]]);
  assert.equal(state.page, 2);
  assert.deepEqual(state.items, ['last']);
});

test('shared pagination renderer uses the committed state for previous, next and numbered controls', () => {
  const { pagination } = createHarness([]);
  const html = pagination.renderControls({
    page: 2,
    totalPages: 4,
    totalCount: 61,
    loading: false,
    previousAction: 'previous-template-page',
    nextAction: 'next-template-page',
    pageAction: 'go-template-page'
  });
  assert.match(html, /共 61 项 \/ 4 页/u);
  assert.match(html, /data-action="previous-template-page"/u);
  assert.match(html, /data-action="go-template-page" data-page="2"[^>]*disabled aria-current="page"/u);
  assert.match(html, /data-action="next-template-page"/u);
});
