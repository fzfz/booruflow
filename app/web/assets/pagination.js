(function installPagination(globalObject) {
  function fail(message) {
    const error = new Error(message);
    error.code = 'RESPONSE_INVALID';
    throw error;
  }

  function validateResponse(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('分页响应必须是对象。');
    if (!Array.isArray(data.items)) fail('分页响应 items 必须是数组。');
    if (!Number.isSafeInteger(data.total_count) || data.total_count < 0) fail('分页响应 total_count 必须是非负整数。');
    if (!Number.isSafeInteger(data.page) || data.page < 1) fail('分页响应 page 必须是正整数。');
    if (!Number.isSafeInteger(data.page_size) || data.page_size < 1) fail('分页响应 page_size 必须是正整数。');
    return Object.freeze({
      items: data.items,
      page: data.page,
      pageSize: data.page_size,
      totalCount: data.total_count,
      totalPages: Math.max(1, Math.ceil(data.total_count / data.page_size))
    });
  }

  function pageNumbers(page, totalPages) {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_unused, index) => index + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, '…', totalPages];
    if (page >= totalPages - 3) return [1, '…', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, '…', page - 1, page, page + 1, '…', totalPages];
  }

  function renderControls({
    page,
    totalPages,
    totalCount,
    loading,
    previousAction,
    nextAction,
    pageAction = null
  }) {
    const previous = `<button class="secondary-button" data-action="${previousAction}" ${page <= 1 || loading ? 'disabled' : ''}>上一页</button>`;
    const next = `<button class="secondary-button" data-action="${nextAction}" ${page >= totalPages || loading ? 'disabled' : ''}>下一页</button>`;
    const pages = pageAction === null ? `<span aria-current="page">第 ${page} 页</span>` : pageNumbers(page, totalPages).map((value) => {
      if (value === '…') return '<span class="pagination-ellipsis" aria-hidden="true">…</span>';
      const label = value === page ? `第 ${value} 页` : String(value);
      return `<button class="secondary-button${value === page ? ' is-current' : ''}" data-action="${pageAction}" data-page="${value}" ${value === page || loading ? 'disabled aria-current="page"' : ''}>${label}</button>`;
    }).join('');
    return `<span class="pagination-summary">共 ${totalCount} 项 / ${totalPages} 页</span>${previous}${pages}${next}`;
  }

  function createListController({
    state,
    fetchPage,
    render,
    setStatus,
    setError,
    loadingMessage,
    emptyMessage,
    readyMessage,
    failureMessage,
    errorMessage
  }) {
    let generation = 0;

    async function load(page = 1, { fallbackToLastPage = false } = {}) {
      if (!Number.isSafeInteger(page) || page < 1) return false;
      const requestGeneration = ++generation;
      const committedView = state.listView;
      state.loading = true;
      if (state.items.length === 0) state.listView = 'loading';
      setError('');
      setStatus(loadingMessage, true);
      render();
      try {
        let requestedPage = page;
        while (true) {
          const response = validateResponse(await fetchPage(requestedPage));
          if (requestGeneration !== generation) return false;
          if (fallbackToLastPage && response.page > response.totalPages) {
            requestedPage = response.totalPages;
            fallbackToLastPage = false;
            continue;
          }
          state.items = response.items;
          state.page = response.page;
          state.totalCount = response.totalCount;
          state.totalPages = response.totalPages;
          state.listView = 'ready';
          setStatus(response.totalCount === 0 ? emptyMessage : readyMessage(response), false);
          return true;
        }
      } catch (error) {
        if (requestGeneration !== generation) return false;
        state.listView = committedView === 'ready' ? 'ready' : 'error';
        setError(errorMessage(error));
        setStatus(failureMessage, false);
        return false;
      } finally {
        if (requestGeneration === generation) {
          state.loading = false;
          render();
        }
      }
    }

    return Object.freeze({ load });
  }

  globalObject.__NOOBAI_PAGINATION__ = Object.freeze({
    createListController,
    renderControls,
    validateResponse
  });
}(globalThis));
