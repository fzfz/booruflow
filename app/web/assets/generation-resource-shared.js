const urls = globalThis.__NOOBAI_URLS__;
const http = globalThis.__NOOBAI_HTTP__;
const paginationTools = globalThis.__NOOBAI_PAGINATION__;
if (!urls || !http || !paginationTools) throw new Error('runtime URL, HTTP and pagination clients are required');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const MANAGEMENT_MODEL_ERROR_MESSAGES = Object.freeze({
  EMBEDDING_UNAVAILABLE: 'Embedding 服务暂时不可用。请检查模型服务后重试；当前页面内容保持不变。',
  MODEL_RATE_LIMITED: '模型服务请求受到限制。请稍后重试；当前页面内容保持不变。',
  EMBEDDING_TIMEOUT: 'Embedding 服务响应超时。请稍后重试；当前页面内容保持不变。',
  MODEL_PROTOCOL_ERROR: '模型服务返回了无法识别的数据。请检查模型服务后重试；当前页面内容保持不变。'
});
function showError(element, message = '') { element.hidden = message.length === 0; element.textContent = message; }
function friendlyManagementError(action, error) {
  const prefix = `${action}未完成`;
  if (error?.code === 'NETWORK_ERROR') return `${prefix}：无法连接应用服务。请检查本机网络后重试；当前页面内容保持不变。`;
  if (error?.code === 'TIMEOUT') return `${prefix}：应用服务响应超时。请稍后重试；当前页面内容保持不变。`;
  if (error?.code === 'CANCELED') return `${prefix}：请求已取消。请确认当前页面内容后重新操作。`;
  if (['RESPONSE_INVALID', 'RESPONSE_JSON_INVALID'].includes(error?.code)) return `${prefix}：应用返回了无法读取的数据。请重新载入页面；如果仍然出现，请检查应用日志。`;
  if (error?.code === 'VALIDATION_ERROR') return `${prefix}：填写内容不能使用。请检查当前表单中标出的内容后重试。`;
  if (error?.code === 'NOT_FOUND') return `${prefix}：目标已经不存在。请返回列表并重新选择。`;
  if (error?.code === 'WRITE_FORBIDDEN') return `${prefix}：当前应用不允许写入。请检查应用的写入权限后重试。`;
  if (error?.code === 'DATABASE_BUSY') return `${prefix}：数据暂时被占用。请稍后重试。`;
  if (Object.hasOwn(MANAGEMENT_MODEL_ERROR_MESSAGES, error?.code)) return `${prefix}：${MANAGEMENT_MODEL_ERROR_MESSAGES[error.code]}`;
  if (error?.code === 'INTERNAL_ERROR') return `${prefix}：应用没有完成本次操作。请重试；如果仍然出现，请检查应用日志。`;
  return `${prefix}：应用没有返回可识别的原因。请重新载入页面后重试。`;
}
function installModelImageFailureHandlers() {
  document.querySelectorAll('[data-media-image]').forEach((image) => {
    if (image.dataset.failureHandlerInstalled === 'true') return;
    image.dataset.failureHandlerInstalled = 'true';
    image.addEventListener('error', () => {
      image.hidden = true;
      image.parentElement?.classList.add('is-broken');
    }, { once: true });
  });
}

function installDialogFocusReturn(dialog) {
  let trigger = null;
  let action = null;
  let id = null;
  dialog.addEventListener('close', () => {
    const currentTrigger = trigger?.isConnected === false
      ? [...document.querySelectorAll('[data-action]')].find((candidate) => candidate.dataset.action === action && candidate.dataset.id === id)
      : trigger;
    currentTrigger?.focus?.();
    trigger = null;
    action = null;
    id = null;
  });
  return (candidate) => {
    trigger = candidate ?? document.activeElement;
    action = trigger?.dataset?.action ?? null;
    id = trigger?.dataset?.id ?? null;
  };
}

function mediaWindow(images, requestedPage, pageSize = 3) {
  const total = images.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Number.isSafeInteger(requestedPage) ? requestedPage : 0, 0), totalPages - 1);
  const start = page * pageSize;
  const items = images.slice(start, start + pageSize);
  return Object.freeze({ items, page, total, totalPages, start, end: start + items.length });
}

function mediaRangeLabel(window) {
  return window.total === 0 ? '图片 0 / 0' : `图片 ${window.start + 1}–${window.end} / ${window.total}`;
}

function imageManagerEmptySlots(remaining, action, total) {
  if (remaining <= 0) return '';
  const addLabel = total === 0 ? '添加第一张图片' : '添加图片';
  const placeholders = Array.from({ length: remaining - 1 }, () => '<div class="image-manager-empty" aria-hidden="true"><span class="image-manager-placeholder-mark">—</span><strong>暂无图片</strong><small>添加后在此显示</small></div>').join('');
  return `<button type="button" class="image-manager-add" data-action="${action}"><span class="image-manager-placeholder-mark" aria-hidden="true">+</span><strong>${addLabel}</strong><small>JPEG、PNG 或 WebP</small></button>${placeholders}`;
}

function managementListReadyStatus({ page, totalPages, totalCount }, pageSize) {
  return Object.freeze({ page, totalPages, totalCount, pageSize });
}

function renderManagementListStatus(element, status, busy = false) {
  if (!element) throw new TypeError('management list status element is required');
  element.setAttribute('aria-busy', String(busy));
  if (typeof status === 'string') {
    element.textContent = status;
    return;
  }
  element.innerHTML = `<strong class="list-status-total">共 ${status.totalCount} 条记录</strong><span class="list-status-page">第 ${status.page} / ${status.totalPages} 页 · 每页 ${status.pageSize} 条</span>`;
}

function createEditableCombobox({ input, listbox }) {
  if (!input || !listbox) throw new TypeError('editable combobox input and listbox are required');
  let suggestions = Object.freeze([]);
  let activeIndex = -1;
  const root = input.closest('.editable-combobox');

  function visibleSuggestions() {
    const query = input.value.trim().toLocaleLowerCase('zh-CN');
    return query.length === 0 ? suggestions : suggestions.filter((value) => value.toLocaleLowerCase('zh-CN').includes(query));
  }
  function renderOptions() {
    const values = visibleSuggestions();
    activeIndex = Math.min(activeIndex, values.length - 1);
    listbox.innerHTML = values.length === 0
      ? '<p class="editable-combobox-empty">没有匹配建议，可以直接保存当前输入。</p>'
      : values.map((value, index) => `<button id="${escapeHtml(listbox.id)}-option-${index}" type="button" role="option" aria-selected="${index === activeIndex}" data-combobox-option="${escapeHtml(value)}" class="${index === activeIndex ? 'is-active' : ''}">${escapeHtml(value)}</button>`).join('');
    const active = activeIndex >= 0 ? `${listbox.id}-option-${activeIndex}` : '';
    if (active) input.setAttribute('aria-activedescendant', active); else input.removeAttribute('aria-activedescendant');
  }
  function open() {
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    renderOptions();
  }
  function close() {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }
  function choose(value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    input.focus();
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', () => { activeIndex = -1; open(); });
  input.addEventListener('keydown', (event) => {
    const values = visibleSuggestions();
    if (event.key === 'Escape' && input.getAttribute('aria-expanded') === 'true') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); open();
      if (values.length === 0) return;
      activeIndex = event.key === 'ArrowDown' ? (activeIndex + 1 + values.length) % values.length : (activeIndex - 1 + values.length) % values.length;
      renderOptions(); listbox.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); return;
    }
    if (event.key === 'Enter' && activeIndex >= 0 && values[activeIndex] !== undefined) { event.preventDefault(); choose(values[activeIndex]); }
  });
  listbox.addEventListener('mousedown', (event) => event.preventDefault());
  listbox.addEventListener('click', (event) => {
    const option = event.target.closest('[data-combobox-option]');
    if (option) choose(option.dataset.comboboxOption);
  });
  document.addEventListener('pointerdown', (event) => { if (!root?.contains(event.target)) close(); });

  return Object.freeze({
    close,
    setSuggestions(values) {
      suggestions = Object.freeze([...new Set(values)]);
      activeIndex = -1;
      if (!listbox.hidden) renderOptions();
    }
  });
}

function createPendingMediaCollection() {
  let images = [];
  let coverId = null;
  let nextId = 1;
  function imageUrl(file, id) { return globalThis.URL?.createObjectURL?.(file) ?? `pending:${id}`; }
  return Object.freeze({
    get size() { return images.length; },
    add(files, { selectLastAsCover = false } = {}) {
      const added = files.map((file) => {
        const id = `pending-${nextId++}`;
        const localUrl = imageUrl(file, id);
        return { id, file, local_url: localUrl, media_path: localUrl };
      });
      images.push(...added);
      if (coverId === null || selectLastAsCover) coverId = added.at(-1)?.id ?? coverId;
    },
    clear() {
      images.forEach((image) => globalThis.URL?.revokeObjectURL?.(image.local_url));
      images = []; coverId = null;
    },
    files() { return images.map((image) => image.file); },
    has(id) { return images.some((image) => image.id === id); },
    coverIndex() { return Math.max(0, images.findIndex((image) => image.id === coverId)); },
    setCover(id) { if (images.some((image) => image.id === id)) coverId = id; },
    move(id, delta) {
      const index = images.findIndex((image) => image.id === id); const next = index + delta;
      if (index < 0 || next < 0 || next >= images.length) return -1;
      [images[index], images[next]] = [images[next], images[index]];
      return next;
    },
    remove(id) {
      const index = images.findIndex((image) => image.id === id); if (index < 0) return false;
      const [removed] = images.splice(index, 1); globalThis.URL?.revokeObjectURL?.(removed.local_url);
      if (coverId === id) coverId = images[0]?.id ?? null;
      return true;
    },
    snapshot() {
      const cover = images.find((image) => image.id === coverId);
      return { owner_id: null, cover_media_path: cover?.local_url ?? null, images: images.map((image, sortOrder) => ({ ...image, sort_order: sortOrder })) };
    }
  });
}

export { createEditableCombobox, createPendingMediaCollection, escapeHtml, friendlyManagementError, http, imageManagerEmptySlots, installDialogFocusReturn, installModelImageFailureHandlers, managementListReadyStatus, mediaRangeLabel, mediaWindow, paginationTools, renderManagementListStatus, showError, urls };
