import { escapeHtml, friendlyManagementError, http, managementListReadyStatus, paginationTools, renderManagementListStatus, showError, urls } from './generation-resource-shared.js';
import { MANAGEMENT_LIST_PAGE_CONFIG } from './management-list-page-config.mjs';
import { bindManagementFilterForm } from './management-list-layout.js';

const state = { items: [], categories: [], page: 1, totalCount: 0, totalPages: 1, loading: false, listView: 'loading', query: '', category: '', min: '', max: '', editing: null, deleting: null, listGeneration: 0 };
const PAGE_CONFIG = MANAGEMENT_LIST_PAGE_CONFIG.promptTerms;
const $ = (selector) => document.querySelector(selector);
const field = (name) => $('#prompt-term-form').elements.namedItem(name);
const requestId = () => `prompt-term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-request-id', requestId());
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return http.requestJson({ path: urls.api(path), options: { ...options, headers }, requestId: headers.get('x-request-id'), timeoutMs: http.DEFAULT_TIMEOUT_MS });
}
function categoryLabel(code) { return state.categories.find((category) => category.code === code)?.label_zh ?? `类别 ${code}`; }
function status(message, busy = false) { renderManagementListStatus($('#prompt-term-status'), message, busy); }
function errorMessage(action, error) { return friendlyManagementError(action, error); }
function render() {
  $('#prompt-term-list').innerHTML = state.listView === 'loading' ? '<div class="base-model-skeleton" aria-busy="true"><span></span><span></span><span></span></div>'
    : state.listView === 'error' ? '<p class="state-line error">Prompt Tag 列表读取失败。</p>'
      : state.items.length === 0 ? '<p class="state-line">暂无匹配 Prompt Tag。</p>'
        : state.items.map((item) => `<article class="manage-card" data-id="${item.id}">
          <header><span class="type-tag">Prompt Tag</span></header><div class="card-cover image-placeholder"><span>TAG</span></div>
          <strong class="card-name">${escapeHtml(item.canonical_tag)}</strong>
          <span class="card-summary">${escapeHtml(item.aliases_json.join('、') || '暂无别名')}</span>
          <div class="card-footer"><span class="card-footer-tag">${escapeHtml(categoryLabel(item.category))}</span><span>${item.post_count} 张关联图片</span></div>
          <div class="manage-actions"><button type="button" data-action="open-edit" data-id="${item.id}">编辑</button></div></article>`).join('');
  $('#prompt-term-pagination').innerHTML = paginationTools.renderControls({ page: state.page, totalPages: state.totalPages, totalCount: state.totalCount, loading: state.loading, previousAction: 'previous-page', nextAction: 'next-page', pageAction: 'go-page' });
}
const controller = paginationTools.createListController({
  state,
  fetchPage(page) {
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_CONFIG.pageSize), q: state.query });
    if (state.category !== '') query.set('category', state.category);
    if (state.min !== '') query.set('post_count_min', state.min);
    if (state.max !== '') query.set('post_count_max', state.max);
    return api(`/manage/prompt-terms?${query}`);
  },
  render,
  setStatus: status,
  setError: (message) => showError($('#prompt-term-error'), message),
  loadingMessage: '正在载入 Prompt Tag……', emptyMessage: '暂无 Prompt Tag。',
  readyMessage: (response) => managementListReadyStatus(response, PAGE_CONFIG.pageSize),
  failureMessage: 'Prompt Tag 列表读取失败。', errorMessage: (error) => errorMessage('读取 Prompt Tag 列表', error)
});
function load(page = 1, options = {}) { return controller.load(page, options); }
function writeFromForm() {
  return { canonical_tag: field('canonical_tag').value.trim(), category: Number(field('category').value), aliases_json: field('aliases').value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean), post_count: Number(field('post_count').value) };
}
function closeEditor() { if ($('#prompt-term-editor').open) $('#prompt-term-editor').close(); state.editing = null; }
async function openEditor(id = null) {
  state.editing = id;
  $('#prompt-term-form').reset();
  field('category').innerHTML = state.categories.map((category) => `<option value="${category.code}">${escapeHtml(category.label_zh)}</option>`).join('');
  $('#prompt-term-editor-title').textContent = id === null ? '新增 Prompt Tag' : '编辑 Prompt Tag';
  $('#prompt-term-editor-subtitle').textContent = '';
  $('#prompt-term-delete-button').hidden = id === null;
  $('#prompt-term-editor-submit').textContent = id === null ? '创建 Prompt Tag' : '保存更改';
  $('#prompt-term-editor-status').textContent = '';
  showError($('#prompt-term-editor-error'));
  $('#prompt-term-editor').showModal();
  $('#prompt-term-editor [data-action="close-editor"]').focus();
  if (id === null) return;
  try {
    const item = await api(`/manage/prompt-terms/${id}`);
    if (state.editing !== id || !$('#prompt-term-editor').open) return;
    $('#prompt-term-editor-title').textContent = '编辑 Prompt Tag'; $('#prompt-term-editor-subtitle').textContent = item.canonical_tag; field('canonical_tag').value = item.canonical_tag; field('category').value = String(item.category); field('post_count').value = String(item.post_count); field('aliases').value = item.aliases_json.join('\n');
  } catch (error) { showError($('#prompt-term-editor-error'), errorMessage('读取 Prompt Tag', error)); }
}
async function save(event) {
  event.preventDefault();
  const id = state.editing;
  try {
    const item = await api(id === null ? '/manage/prompt-terms' : `/manage/prompt-terms/${id}`, { method: id === null ? 'POST' : 'PUT', body: JSON.stringify(writeFromForm()) });
    state.editing = item.id; $('#prompt-term-editor-title').textContent = '编辑 Prompt Tag'; $('#prompt-term-editor-subtitle').textContent = item.canonical_tag; $('#prompt-term-delete-button').hidden = false; $('#prompt-term-editor-submit').textContent = '保存更改'; $('#prompt-term-editor-status').textContent = '更改已保存';
    await load(state.page, { fallbackToLastPage: true });
  } catch (error) { showError($('#prompt-term-editor-error'), errorMessage(id === null ? '新增 Prompt Tag' : '保存 Prompt Tag', error)); }
}
async function remove() {
  const id = state.deleting;
  if (id === null) return;
  try { await api(`/manage/prompt-terms/${id}`, { method: 'DELETE' }); if ($('#prompt-term-delete').open) $('#prompt-term-delete').close(); closeEditor(); await load(state.page, { fallbackToLastPage: true }); }
  catch (error) { showError($('#prompt-term-editor-error'), errorMessage('删除 Prompt Tag', error)); }
}
async function loadOptions() {
  const data = await api('/manage/prompt-term-options'); state.categories = data.categories;
  $('#prompt-term-filter-category').innerHTML = `<option value="">全部类别</option>${state.categories.map((category) => `<option value="${category.code}">${escapeHtml(category.label_zh)}</option>`).join('')}`;
}

bindManagementFilterForm({ config: PAGE_CONFIG, form: $('#prompt-term-filter-form'), keyword: $('#prompt-term-search'), onApply() { state.query = $('#prompt-term-search').value; state.category = $('#prompt-term-filter-category').value; state.min = $('#prompt-term-filter-min').value; state.max = $('#prompt-term-filter-max').value; return load(1); }, onReset() { Object.assign(state, { query: '', category: '', min: '', max: '' }); return load(1); } });
$('#prompt-term-form').addEventListener('submit', save);
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]'); if (!target) return;
  if (target.dataset.action === 'open-create') void openEditor();
  if (target.dataset.action === 'open-edit') void openEditor(Number(target.dataset.id));
  if (target.dataset.action === 'close-editor') closeEditor();
  if (target.dataset.action === 'open-delete') { state.deleting = state.editing; $('#prompt-term-delete-copy').textContent = `确认删除 Prompt Tag“${field('canonical_tag').value}”吗？`; $('#prompt-term-delete').showModal(); }
  if (target.dataset.action === 'close-delete') { state.deleting = null; if ($('#prompt-term-delete').open) $('#prompt-term-delete').close(); }
  if (target.dataset.action === 'confirm-delete') void remove();
  if (target.dataset.action === 'previous-page') void load(state.page - 1); if (target.dataset.action === 'next-page') void load(state.page + 1); if (target.dataset.action === 'go-page') void load(Number(target.dataset.page));
});
render();
await loadOptions();
void load();
