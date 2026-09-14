import { escapeHtml, friendlyManagementError, http, managementListReadyStatus, paginationTools, renderManagementListStatus, showError, urls } from './generation-resource-shared.js';
import { MANAGEMENT_LIST_PAGE_CONFIG } from './management-list-page-config.mjs';
import { bindManagementFilterForm } from './management-list-layout.js';

const PAGE_CONFIG = MANAGEMENT_LIST_PAGE_CONFIG.baseModels;
const state = { items: [], page: 1, totalCount: 0, totalPages: 1, query: '', editing: null, deleting: null, loading: false, listView: 'loading', pending: new Set(), listGeneration: 0, editorGeneration: 0, editorInputGeneration: 0, editorLoading: false, deleteGeneration: 0, deleteRequestToken: 0 };
const $ = (selector) => document.querySelector(selector);
const requestId = () => `base-model-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function open(dialog) { if (!dialog.open) dialog.showModal(); }
function close(dialog) { if (dialog.open) dialog.close(); }
function status(message, busy = false) { renderManagementListStatus($('#base-model-status'), message, busy); }
function setEditorLoading(loading) {
  state.editorLoading = loading;
  $('#base-model-name').disabled = loading;
  $('#base-model-editor-submit').disabled = loading;
}
function setEditorMode(id, record = null) {
  const editing = id !== null;
  $('#base-model-editor-title').textContent = editing ? '编辑底模' : '新增底模';
  $('#base-model-editor-subtitle').textContent = editing ? (record?.name ?? `#${id}`) : '';
  $('#base-model-editor-delete').hidden = !editing;
  $('#base-model-editor-delete').dataset.id = editing ? String(id) : '';
  $('#base-model-editor-submit').textContent = editing ? '保存更改' : '创建底模';
  $('#base-model-record-panel').hidden = !editing;
  if (record) $('#base-model-record-meta').innerHTML = `<div><dt>记录编号</dt><dd>#${record.id}</dd></div><div><dt>关联模型</dt><dd>${record.model_count}</dd></div><div><dt>关联 LoRA</dt><dd>${record.lora_count}</dd></div><div><dt>关联画风</dt><dd>${record.style_count}</dd></div><div><dt>创建时间</dt><dd>${escapeHtml(record.created_at)}</dd></div><div><dt>最后更新</dt><dd>${escapeHtml(record.updated_at)}</dd></div>`;
}
function resetEditorForm() {
  $('#base-model-form').querySelectorAll('button').forEach((button) => { button.disabled = false; });
  setEditorLoading(false);
}
function errorMessage(error) { return friendlyManagementError('读取底模', error); }
function writeErrorMessage(error, action) {
  if (error?.code === 'DUPLICATE_RESOURCE') return `${action}失败：底模名称已存在，请修改名称后重试。`;
  if (error?.code === 'RELATION_CONFLICT' && action === '删除') return '删除失败：该文生图底模仍被聊天会话引用，不能删除；请保留该底模或先删除相关聊天会话。';
  if (error?.code === 'WRITE_FORBIDDEN') return `${action}失败：当前应用不允许写入，请检查应用的写入权限后重试。`;
  if (error?.code === 'DATABASE_BUSY') return `${action}暂时无法完成：数据库繁忙，请稍后重试。`;
  return friendlyManagementError(action, error);
}
function pendingKey(name, scope = null) { return scope === null ? name : `${name}:${scope}`; }
function startPending(name, scope = null) {
  const key = pendingKey(name, scope);
  if (state.pending.has(key)) return false;
  state.pending.add(key);
  return true;
}
function finishPending(name, scope = null) { state.pending.delete(pendingKey(name, scope)); }

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-request-id', requestId());
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return await http.requestJson({ path: urls.api(path), options: { ...options, headers }, requestId: headers.get('x-request-id'), timeoutMs: http.DEFAULT_TIMEOUT_MS });
}

function render() {
  const list = $('#base-model-list');
  list.innerHTML = state.listView === 'loading'
    ? '<div class="base-model-skeleton" aria-busy="true" aria-label="正在载入底模列表"><span></span><span></span><span></span></div>'
    : state.listView === 'error'
      ? '<p class="state-line error">底模列表读取失败。</p>'
      : state.items.length === 0
        ? '<p class="state-line">暂无匹配底模。</p>'
        : state.items.map((item) => `<article class="manage-card" data-id="${item.id}"><header><span class="type-tag">底模</span></header><div class="card-cover image-placeholder"><span>文生图底模</span></div><strong class="card-name">${escapeHtml(item.name)}</strong><div class="card-footer"><span class="card-footer-tag">${item.model_count} 个模型</span><span>${item.lora_count} 个 LoRA · ${item.style_count} 个画风</span></div><div class="manage-actions"><button class="secondary-button" data-action="open-detail" data-id="${item.id}">编辑</button></div></article>`).join('');
  const pagination = $('#base-model-pagination');
  pagination.innerHTML = paginationTools.renderControls({ page: state.page, totalPages: state.totalPages, totalCount: state.totalCount, loading: state.loading, previousAction: 'previous-page', nextAction: 'next-page', pageAction: 'go-base-model-page' });
}

const baseModelPagination = paginationTools.createListController({
  state,
  fetchPage: async (page) => {
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_CONFIG.pageSize), q: state.query });
    return api(`/manage/base-models?${query}`);
  },
  render,
  setStatus: status,
  setError: (message) => showError($('#base-model-error'), message),
  loadingMessage: '正在载入底模……',
  emptyMessage: '暂无底模。',
  readyMessage: (response) => managementListReadyStatus(response, PAGE_CONFIG.pageSize),
  failureMessage: '底模列表读取失败。',
  errorMessage
});

function load(page = 1, options = {}) { return baseModelPagination.load(page, options); }

async function openEditor(id = null) {
  const generation = ++state.editorGeneration;
  const inputGeneration = ++state.editorInputGeneration;
  state.editing = id;
  showError($('#base-model-form-error'));
  setEditorMode(id);
  $('#base-model-name').value = '';
  open($('#base-model-editor'));
  resetEditorForm();
  setEditorLoading(id !== null);
  if (id === null) return;
  try {
    const data = await api(`/manage/base-models/${id}`);
    if (generation !== state.editorGeneration || inputGeneration !== state.editorInputGeneration || state.editing !== id || !$('#base-model-editor').open) return;
    $('#base-model-name').value = data.name;
    setEditorMode(id, data);
    setEditorLoading(false);
  } catch (error) {
    if (generation !== state.editorGeneration || state.editing !== id || !$('#base-model-editor').open) return;
    showError($('#base-model-form-error'), errorMessage(error));
  }
}

function closeEditor() {
  state.editorGeneration += 1;
  state.editorInputGeneration += 1;
  resetEditorForm();
  close($('#base-model-editor'));
}

async function saveEditor() {
  const generation = state.editorGeneration;
  if (state.editorLoading || !startPending('save-editor', generation)) return;
  const editing = state.editing;
  const name = $('#base-model-name').value;
  const buttons = [...$('#base-model-form').querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (editing === null) await api('/manage/base-models', { method: 'POST', body: JSON.stringify({ name }) });
    else await api(`/manage/base-models/${editing}`, { method: 'PUT', body: JSON.stringify({ name }) });
    if (generation !== state.editorGeneration || state.editing !== editing || !$('#base-model-editor').open) return;
    close($('#base-model-editor'));
    await load(editing === null ? 1 : state.page);
  } catch (error) {
    if (generation !== state.editorGeneration || state.editing !== editing || !$('#base-model-editor').open) return;
    showError($('#base-model-form-error'), writeErrorMessage(error, '保存'));
  } finally {
    if (generation === state.editorGeneration) buttons.forEach((button) => { button.disabled = false; });
    finishPending('save-editor', generation);
  }
}

function impactItem(item) {
  const label = ({ model: '模型', lora: 'LoRA', template: '模板', image: '图片', artist_prompt_string: '画师串' }[item.kind] ?? item.kind);
  return `<li>${label}：${escapeHtml(item.name ?? item.media_path ?? `#${item.id}`)}</li>`;
}

async function openDelete(id) {
  const generation = ++state.deleteGeneration;
  state.deleting = null;
  showError($('#base-model-delete-error'));
  $('#base-model-cascade-list').innerHTML = '<li>正在读取影响预览……</li>';
  $('#base-model-retained-list').innerHTML = '';
  $('#base-model-delete [data-action="confirm-delete"]').disabled = true;
  open($('#base-model-delete'));
  try {
    const impact = await api(`/manage/base-models/${id}/delete-impact`);
    if (generation !== state.deleteGeneration || !$('#base-model-delete').open) return;
    state.deleting = impact;
    $('#base-model-delete-target').textContent = `将删除底模“${impact.target.name}”。`;
    $('#base-model-cascade-list').innerHTML = impact.cascade_deleted.length ? impact.cascade_deleted.map(impactItem).join('') : '<li>没有关联模型、LoRA、模板或资源图片。</li>';
    $('#base-model-retained-list').innerHTML = impact.retained.length ? impact.retained.map(impactItem).join('') : '<li>没有需要解除关联的画师串。</li>';
  } catch (error) {
    if (generation !== state.deleteGeneration || !$('#base-model-delete').open) return;
    showError($('#base-model-delete-error'), errorMessage(error));
  } finally {
    if (generation !== state.deleteGeneration || !$('#base-model-delete').open) return;
    $('#base-model-delete [data-action="confirm-delete"]').disabled = state.deleting === null;
  }
}

function closeDelete() {
  state.deleteGeneration += 1;
  state.deleting = null;
  close($('#base-model-delete'));
}

async function confirmDelete() {
  if (!state.deleting || !startPending('confirm-delete')) return;
  const deleting = state.deleting;
  const requestToken = ++state.deleteRequestToken;
  const button = $('#base-model-delete [data-action="confirm-delete"]');
  button.disabled = true;
  try {
    const result = await api(`/manage/base-models/${deleting.target.id}`, { method: 'DELETE', body: JSON.stringify({ impact_token: deleting.impact_token }) });
    await load(state.page, { fallbackToLastPage: true });
    if (requestToken === state.deleteRequestToken && state.deleting === deleting) close($('#base-model-delete'));
    if (result.cleanup_warning) {
      const failureCount = Array.isArray(result.cleanup_failures) ? result.cleanup_failures.length : 0;
      const auditFailed = Array.isArray(result.cleanup_failures) && result.cleanup_failures.some((failure) => typeof failure.audit_error === 'string' && failure.audit_error.length > 0);
      showError($('#base-model-error'), auditFailed
        ? '底模记录已删除，但资源图片清理审计未能持久化；请立即检查运行维护日志。'
        : `底模记录已删除，但 ${failureCount || '部分'}资源图片文件等待后续清理。`);
    }
  } catch (error) {
    showError($('#base-model-error'), writeErrorMessage(error, '删除'));
    if (error?.code === 'DELETE_IMPACT_STALE') {
      if (requestToken === state.deleteRequestToken && state.deleting === deleting) {
        showError($('#base-model-delete-error'), '影响预览已过期，已重新读取。请确认新的删除范围。');
        await openDelete(deleting.target.id);
      }
      return;
    }
    if (requestToken === state.deleteRequestToken && state.deleting === deleting) showError($('#base-model-delete-error'), writeErrorMessage(error, '删除'));
  } finally {
    finishPending('confirm-delete');
    if ($('#base-model-delete').open) button.disabled = state.deleting === null;
  }
}

bindManagementFilterForm({
  config: PAGE_CONFIG,
  form: $('#base-model-filter-form'),
  keyword: $('#base-model-search'),
  onApply() { state.query = $('#base-model-search').value; return load(1); },
  onReset() { state.query = ''; return load(1); }
});
$('#base-model-name').addEventListener('input', () => { state.editorInputGeneration += 1; });
$('#base-model-form').addEventListener('submit', (event) => { event.preventDefault(); void saveEditor(); });
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  if (target.dataset.action === 'open-create') void openEditor();
  if (target.dataset.action === 'open-detail') void openEditor(Number(target.dataset.id));
  if (target.dataset.action === 'open-delete') void openDelete(Number(target.dataset.id));
  if (target.dataset.action === 'close-editor') closeEditor();
  if (target.dataset.action === 'close-delete') closeDelete();
  if (target.dataset.action === 'confirm-delete') void confirmDelete();
  if (target.dataset.action === 'previous-page') void load(state.page - 1);
  if (target.dataset.action === 'next-page') void load(state.page + 1);
  if (target.dataset.action === 'go-base-model-page') void load(Number(target.dataset.page));
});

render();
void load();
