import { escapeHtml, friendlyManagementError, http, installDialogFocusReturn, managementListReadyStatus, paginationTools, renderManagementListStatus, showError, urls } from './generation-resource-shared.js';
import { MANAGEMENT_LIST_PAGE_CONFIG } from './management-list-page-config.mjs';
import { bindManagementFilterForm } from './management-list-layout.js';

const PAGE_CONFIG = MANAGEMENT_LIST_PAGE_CONFIG.comfyuiInstances;
const comfyuiInstanceState = {
  items: [], page: 1, totalCount: 0, totalPages: 1, query: '', credentialType: '', isValid: '', isEnabled: '', listView: 'loading', loading: false,
  editing: null, editorGeneration: 0, editorLoading: false, instance: null, credentialChanged: false, deleting: null,
  listGeneration: 0, deleteGeneration: 0, deleteRequestToken: 0, pending: new Set()
};

const comfyuiInstance$ = (selector) => document.querySelector(selector);
const comfyuiInstanceField = (name) => comfyuiInstance$('#comfyui-instance-form').elements.namedItem(name);
const comfyuiInstanceRequestId = () => `generation-comfyui-instance-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const comfyuiInstancePendingKey = (action, target = '') => `${action}:${target}`;
const rememberComfyuiInstanceEditorTrigger = installDialogFocusReturn(comfyuiInstance$('#comfyui-instance-editor'));

function comfyuiInstanceOpen(dialog) { if (!dialog.open) dialog.showModal(); }
function comfyuiInstanceClose(dialog) { if (dialog.open) dialog.close(); }
function comfyuiInstanceEditorError(message = '') { showError(comfyuiInstance$('#comfyui-instance-editor-error'), message); }
function comfyuiInstanceStatus(message, busy = false) {
  renderManagementListStatus(comfyuiInstance$('#comfyui-instance-status'), message, busy);
}
function comfyuiInstanceStartPending(action, target = '') {
  const key = comfyuiInstancePendingKey(action, target);
  if (comfyuiInstanceState.pending.has(key)) return false;
  comfyuiInstanceState.pending.add(key);
  return true;
}
function comfyuiInstanceFinishPending(action, target = '') { comfyuiInstanceState.pending.delete(comfyuiInstancePendingKey(action, target)); }
function comfyuiInstanceFriendlyError(action, error) {
  if (error?.code === 'DUPLICATE_RESOURCE') return `${action}失败：ComfyUI 服务地址已存在，请修改后重试。`;
  if (error?.code === 'WRITE_FORBIDDEN') return `${action}失败：当前应用不允许写入，请检查应用的写入权限后重试。`;
  if (error?.code === 'DATABASE_BUSY') return `${action}暂时无法完成：数据库繁忙，请稍后重试。`;
  if (error?.code === 'COMFYUI_CREDENTIAL_ERROR') return `${action}失败：已保存的凭据无法使用，请重新填写凭据后重试。`;
  return friendlyManagementError(action, error);
}
async function comfyuiInstanceApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-request-id', comfyuiInstanceRequestId());
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return await http.requestJson({ path: urls.api(path), options: { ...options, headers }, requestId: headers.get('x-request-id'), timeoutMs: http.DEFAULT_TIMEOUT_MS });
}
function comfyuiInstanceCredentialLabel(type) {
  return ({ none: '无凭据', http_basic: 'HTTP Basic', bearer: 'Bearer Token' }[type] ?? '未知凭据');
}
function comfyuiInstanceValidityLabel(item) {
  if (!item.is_valid) return '连接未通过检测';
  return item.is_enabled ? '已启用' : '连接有效，未启用';
}
function renderComfyuiInstanceList() {
  const list = comfyuiInstance$('#comfyui-instance-list');
  list.innerHTML = comfyuiInstanceState.listView === 'loading'
    ? '<div class="base-model-skeleton" aria-busy="true" aria-label="正在载入 ComfyUI 实例列表"><span></span><span></span><span></span></div>'
    : comfyuiInstanceState.listView === 'error'
      ? '<p class="state-line error">ComfyUI 实例列表读取失败。</p>'
      : comfyuiInstanceState.items.length === 0
        ? '<p class="state-line">暂无匹配 ComfyUI 实例。</p>'
        : comfyuiInstanceState.items.map((item) => `<article class="manage-card" data-id="${item.id}">
          <header><span class="type-tag">ComfyUI</span></header>
          <div class="card-cover image-placeholder"><span>ComfyUI 实例</span></div>
          <strong class="card-name">${escapeHtml(item.title)}</strong>
          <span class="card-summary">${escapeHtml(item.url)}</span>
          <div class="card-footer"><span class="card-footer-tag">${comfyuiInstanceCredentialLabel(item.credential_type)}</span><span>${comfyuiInstanceValidityLabel(item)}</span></div>
          <div class="manage-actions"><button class="secondary-button" data-action="open-comfyui-instance-detail" data-id="${item.id}">编辑</button></div>
        </article>`).join('');
  const pagination = comfyuiInstance$('#comfyui-instance-pagination');
  pagination.innerHTML = paginationTools.renderControls({ page: comfyuiInstanceState.page, totalPages: comfyuiInstanceState.totalPages, totalCount: comfyuiInstanceState.totalCount, loading: comfyuiInstanceState.loading, previousAction: 'previous-comfyui-instance-page', nextAction: 'next-comfyui-instance-page', pageAction: 'go-comfyui-instance-page' });
}
const comfyuiInstancePagination = paginationTools.createListController({
  state: comfyuiInstanceState,
  fetchPage: (page) => {
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_CONFIG.pageSize), q: comfyuiInstanceState.query });
    if (comfyuiInstanceState.credentialType !== '') query.set('credential_type', comfyuiInstanceState.credentialType);
    if (comfyuiInstanceState.isValid !== '') query.set('is_valid', comfyuiInstanceState.isValid);
    if (comfyuiInstanceState.isEnabled !== '') query.set('is_enabled', comfyuiInstanceState.isEnabled);
    return comfyuiInstanceApi(`/manage/comfyui-instances?${query}`);
  },
  render: renderComfyuiInstanceList,
  setStatus: comfyuiInstanceStatus,
  setError: (message) => showError(comfyuiInstance$('#comfyui-instance-error'), message),
  loadingMessage: '正在载入 ComfyUI 实例……',
  emptyMessage: '暂无 ComfyUI 实例。',
  readyMessage: (response) => managementListReadyStatus(response, PAGE_CONFIG.pageSize),
  failureMessage: 'ComfyUI 实例列表读取失败。',
  errorMessage: (error) => comfyuiInstanceFriendlyError('读取 ComfyUI 实例列表', error)
});
function loadComfyuiInstances(page = 1, options = {}) { return comfyuiInstancePagination.load(page, options); }
function renderComfyuiInstanceCredentialFields() {
  const type = comfyuiInstanceField('credential_type').value;
  const fields = comfyuiInstance$('#comfyui-instance-credential-fields');
  if (type === 'http_basic') fields.innerHTML = '<div class="model-form-grid"><label>用户名<input name="username" autocomplete="username"></label><label>密码<input name="password" type="password" autocomplete="new-password"></label></div>';
  else if (type === 'bearer') fields.innerHTML = '<label>Bearer Token<input name="token" type="password" autocomplete="new-password"></label>';
  else fields.innerHTML = '<p class="field-help">不发送认证信息。</p>';
}
function setComfyuiInstanceEnabledGate() {
  const enabled = comfyuiInstanceField('is_enabled');
  const instance = comfyuiInstanceState.instance;
  const isValid = instance?.is_valid === true;
  const canEnable = isValid && !comfyuiInstanceState.editorLoading;
  enabled.disabled = !canEnable;
  if (!isValid) enabled.checked = false;
  comfyuiInstance$('#comfyui-instance-validation-status').textContent = instance === null
    ? '保存后可检测连接。'
    : instance.is_valid ? '连接检测成功，可以启用实例。' : '连接尚未通过检测，不能启用实例。';
}
function setComfyuiInstanceEditorLoading(loading) {
  comfyuiInstanceState.editorLoading = loading;
  comfyuiInstance$('#comfyui-instance-form').querySelectorAll('input, select, button').forEach((element) => { element.disabled = loading; });
  comfyuiInstance$('#comfyui-instance-editor-submit').disabled = loading;
  if (!loading) setComfyuiInstanceEnabledGate();
}
function setComfyuiInstanceEditorMode(id, record = null) {
  const editing = id !== null;
  comfyuiInstance$('#comfyui-instance-editor-title').textContent = editing ? '编辑 ComfyUI 实例' : '新增 ComfyUI 实例';
  comfyuiInstance$('#comfyui-instance-editor-subtitle').textContent = editing ? (record?.title ?? `#${id}`) : '';
  comfyuiInstance$('#comfyui-instance-editor-delete').hidden = !editing;
  comfyuiInstance$('#comfyui-instance-editor-delete').dataset.id = editing ? String(id) : '';
  comfyuiInstance$('#comfyui-instance-editor-submit').textContent = editing ? '保存更改' : '创建 ComfyUI 实例';
  comfyuiInstance$('#comfyui-instance-record-panel').hidden = !editing;
  if (record) comfyuiInstance$('#comfyui-instance-record-meta').innerHTML = `<div><dt>记录编号</dt><dd>#${record.id}</dd></div><div><dt>验证状态</dt><dd>${record.is_valid ? '有效' : '未验证或无效'}</dd></div><div><dt>启用状态</dt><dd>${record.is_enabled ? '已启用' : '未启用'}</dd></div><div><dt>创建时间</dt><dd>${escapeHtml(record.created_at)}</dd></div><div><dt>最后更新</dt><dd>${escapeHtml(record.updated_at)}</dd></div>`;
}
function resetComfyuiInstanceForm() {
  comfyuiInstance$('#comfyui-instance-form').reset();
  comfyuiInstanceField('credential_type').value = 'none';
  renderComfyuiInstanceCredentialFields();
  comfyuiInstanceState.credentialChanged = false;
  comfyuiInstanceState.instance = null;
  setComfyuiInstanceEnabledGate();
}
function populateComfyuiInstanceForm(item) {
  comfyuiInstanceField('title').value = item.title;
  comfyuiInstanceField('url').value = item.url;
  comfyuiInstanceField('credential_type').value = item.credential_type;
  renderComfyuiInstanceCredentialFields();
  comfyuiInstanceField('is_enabled').checked = item.is_enabled;
  comfyuiInstanceState.credentialChanged = false;
  comfyuiInstanceState.instance = item;
  setComfyuiInstanceEnabledGate();
}
function comfyuiInstanceWriteFromForm() {
  const type = comfyuiInstanceField('credential_type').value;
  let credential;
  if (comfyuiInstanceState.editing !== null && !comfyuiInstanceState.credentialChanged) credential = { action: 'keep' };
  else if (type === 'http_basic') credential = { action: 'replace', type, username: comfyuiInstanceField('username').value, password: comfyuiInstanceField('password').value };
  else if (type === 'bearer') credential = { action: 'replace', type, token: comfyuiInstanceField('token').value };
  else credential = comfyuiInstanceState.editing === null ? { type: 'none' } : { action: 'clear' };
  return Object.freeze({
    title: comfyuiInstanceField('title').value.trim(),
    url: comfyuiInstanceField('url').value.trim(),
    credential,
    is_enabled: comfyuiInstanceField('is_enabled').checked
  });
}
function clearComfyuiInstanceCredentialInputs() {
  const fields = comfyuiInstance$('#comfyui-instance-credential-fields');
  fields.querySelectorAll('input').forEach((field) => { field.value = ''; });
}
async function openComfyuiInstanceEditor(id = null, trigger = null) {
  const generation = ++comfyuiInstanceState.editorGeneration;
  rememberComfyuiInstanceEditorTrigger(trigger);
  comfyuiInstanceState.editing = id;
  comfyuiInstanceEditorError();
  resetComfyuiInstanceForm();
  setComfyuiInstanceEditorMode(id);
  comfyuiInstanceOpen(comfyuiInstance$('#comfyui-instance-editor'));
  setComfyuiInstanceEditorLoading(true);
  try {
    const item = id === null ? null : await comfyuiInstanceApi(`/manage/comfyui-instances/${id}`);
    if (generation !== comfyuiInstanceState.editorGeneration || comfyuiInstanceState.editing !== id || !comfyuiInstance$('#comfyui-instance-editor').open) return;
    if (item !== null) { populateComfyuiInstanceForm(item); setComfyuiInstanceEditorMode(id, item); }
    setComfyuiInstanceEditorLoading(false);
  } catch (error) {
    if (generation !== comfyuiInstanceState.editorGeneration || !comfyuiInstance$('#comfyui-instance-editor').open) return;
    comfyuiInstanceEditorError(comfyuiInstanceFriendlyError(id === null ? '读取实例' : '读取 ComfyUI 实例详情', error));
    setComfyuiInstanceEditorLoading(false);
  }
}
function closeComfyuiInstanceEditor() {
  comfyuiInstanceState.editorGeneration += 1;
  comfyuiInstanceState.editing = null;
  comfyuiInstanceState.instance = null;
  clearComfyuiInstanceCredentialInputs();
  comfyuiInstanceClose(comfyuiInstance$('#comfyui-instance-editor'));
}
async function saveComfyuiInstanceEditor() {
  const generation = comfyuiInstanceState.editorGeneration;
  const id = comfyuiInstanceState.editing;
  if (comfyuiInstanceState.editorLoading || !comfyuiInstanceStartPending('save', generation)) return;
  setComfyuiInstanceEditorLoading(true);
  comfyuiInstanceEditorError();
  try {
    const record = id === null
      ? await comfyuiInstanceApi('/manage/comfyui-instances', { method: 'POST', body: JSON.stringify(comfyuiInstanceWriteFromForm()) })
      : await comfyuiInstanceApi(`/manage/comfyui-instances/${id}`, { method: 'PUT', body: JSON.stringify(comfyuiInstanceWriteFromForm()) });
    if (generation !== comfyuiInstanceState.editorGeneration || !comfyuiInstance$('#comfyui-instance-editor').open) return;
    comfyuiInstanceState.editing = record.id;
    comfyuiInstanceState.instance = record;
    comfyuiInstanceState.credentialChanged = false;
    comfyuiInstanceField('credential_type').value = record.credential_type;
    clearComfyuiInstanceCredentialInputs();
    setComfyuiInstanceEnabledGate();
    setComfyuiInstanceEditorMode(record.id, record);
    if (id === null) await loadComfyuiInstances(1);
    else {
      const itemIndex = comfyuiInstanceState.items.findIndex((item) => item.id === record.id);
      if (itemIndex >= 0) comfyuiInstanceState.items[itemIndex] = record;
      renderComfyuiInstanceList();
    }
  } catch (error) {
    if (generation === comfyuiInstanceState.editorGeneration && comfyuiInstance$('#comfyui-instance-editor').open) comfyuiInstanceEditorError(comfyuiInstanceFriendlyError('保存 ComfyUI 实例', error));
  } finally {
    if (generation === comfyuiInstanceState.editorGeneration && comfyuiInstance$('#comfyui-instance-editor').open) setComfyuiInstanceEditorLoading(false);
    comfyuiInstanceFinishPending('save', generation);
  }
}
async function validateComfyuiInstance() {
  const id = comfyuiInstanceState.editing;
  const generation = comfyuiInstanceState.editorGeneration;
  if (id === null || comfyuiInstanceState.editorLoading || !comfyuiInstanceStartPending('validate', id)) return;
  setComfyuiInstanceEditorLoading(true);
  comfyuiInstanceEditorError();
  try {
    const record = await comfyuiInstanceApi(`/manage/comfyui-instances/${id}/validate`, { method: 'POST' });
    if (generation !== comfyuiInstanceState.editorGeneration || comfyuiInstanceState.editing !== id || !comfyuiInstance$('#comfyui-instance-editor').open) return;
    comfyuiInstanceState.instance = record;
    comfyuiInstanceField('is_enabled').checked = record.is_enabled;
    setComfyuiInstanceEnabledGate();
    const itemIndex = comfyuiInstanceState.items.findIndex((item) => item.id === record.id);
    if (itemIndex >= 0) comfyuiInstanceState.items[itemIndex] = record;
    renderComfyuiInstanceList();
  } catch (error) {
    if (generation === comfyuiInstanceState.editorGeneration && comfyuiInstance$('#comfyui-instance-editor').open) comfyuiInstanceEditorError(comfyuiInstanceFriendlyError('检测连接', error));
  } finally {
    if (generation === comfyuiInstanceState.editorGeneration && comfyuiInstance$('#comfyui-instance-editor').open) setComfyuiInstanceEditorLoading(false);
    comfyuiInstanceFinishPending('validate', id);
  }
}
async function openComfyuiInstanceDelete(id) {
  const generation = ++comfyuiInstanceState.deleteGeneration;
  const dialog = comfyuiInstance$('#comfyui-instance-delete');
  comfyuiInstanceState.deleting = null;
  showError(dialog.querySelector('#comfyui-instance-delete-error'));
  dialog.querySelector('#comfyui-instance-delete-target').textContent = '正在读取 ComfyUI 实例删除影响预览……';
  dialog.querySelector('[data-action="confirm-comfyui-instance-delete"]').disabled = true;
  comfyuiInstanceOpen(dialog);
  try {
    const impact = await comfyuiInstanceApi(`/manage/comfyui-instances/${id}/delete-impact`);
    if (generation !== comfyuiInstanceState.deleteGeneration || !dialog.open) return;
    comfyuiInstanceState.deleting = impact;
    dialog.querySelector('#comfyui-instance-delete-target').textContent = `将删除 ComfyUI 实例“${impact.target.name}”。`;
  } catch (error) {
    if (generation === comfyuiInstanceState.deleteGeneration && dialog.open) showError(dialog.querySelector('#comfyui-instance-delete-error'), comfyuiInstanceFriendlyError('读取删除影响预览', error));
  } finally {
    if (generation !== comfyuiInstanceState.deleteGeneration || !dialog.open) return;
    dialog.querySelector('[data-action="confirm-comfyui-instance-delete"]').disabled = comfyuiInstanceState.deleting === null;
  }
}
function closeComfyuiInstanceDelete() {
  comfyuiInstanceState.deleteGeneration += 1;
  comfyuiInstanceState.deleting = null;
  comfyuiInstanceClose(comfyuiInstance$('#comfyui-instance-delete'));
}
async function confirmComfyuiInstanceDelete() {
  const impact = comfyuiInstanceState.deleting;
  const targetId = impact?.target?.id;
  const generation = comfyuiInstanceState.deleteGeneration;
  if (!impact || !comfyuiInstanceStartPending('delete-instance', targetId)) return;
  const requestToken = ++comfyuiInstanceState.deleteRequestToken;
  const dialog = comfyuiInstance$('#comfyui-instance-delete');
  const button = dialog.querySelector('[data-action="confirm-comfyui-instance-delete"]');
  const isCurrentRequest = () => requestToken === comfyuiInstanceState.deleteRequestToken && generation === comfyuiInstanceState.deleteGeneration
    && comfyuiInstanceState.deleting === impact && comfyuiInstanceState.deleting?.target?.id === targetId && dialog.open;
  button.disabled = true;
  try {
    await comfyuiInstanceApi(`/manage/comfyui-instances/${targetId}`, { method: 'DELETE', body: JSON.stringify({ impact_token: impact.impact_token }) });
    await loadComfyuiInstances(comfyuiInstanceState.page, { fallbackToLastPage: true });
    if (isCurrentRequest()) closeComfyuiInstanceDelete();
  } catch (error) {
    if (!isCurrentRequest()) return;
    if (error?.code === 'DELETE_IMPACT_STALE') {
      showError(dialog.querySelector('#comfyui-instance-delete-error'), '影响预览已过期，正在重新读取。请确认新的删除范围。');
      await openComfyuiInstanceDelete(targetId);
    } else {
      showError(dialog.querySelector('#comfyui-instance-delete-error'), comfyuiInstanceFriendlyError('删除 ComfyUI 实例', error));
    }
  } finally {
    comfyuiInstanceFinishPending('delete-instance', targetId);
    if (isCurrentRequest()) button.disabled = comfyuiInstanceState.deleting === null;
  }
}

const comfyuiInstanceSearch = comfyuiInstance$('#comfyui-instance-search');
if (comfyuiInstanceSearch) {
  bindManagementFilterForm({
    config: PAGE_CONFIG,
    form: comfyuiInstance$('#comfyui-instance-filter-form'),
    keyword: comfyuiInstanceSearch,
    onApply() {
      comfyuiInstanceState.query = comfyuiInstanceSearch.value;
      comfyuiInstanceState.credentialType = comfyuiInstance$('#comfyui-instance-filter-credential').value;
      comfyuiInstanceState.isValid = comfyuiInstance$('#comfyui-instance-filter-valid').value;
      comfyuiInstanceState.isEnabled = comfyuiInstance$('#comfyui-instance-filter-enabled').value;
      return loadComfyuiInstances(1);
    },
    onReset() {
      Object.assign(comfyuiInstanceState, { query: '', credentialType: '', isValid: '', isEnabled: '' });
      return loadComfyuiInstances(1);
    }
  });
  comfyuiInstance$('#comfyui-instance-form').addEventListener('submit', (event) => { event.preventDefault(); void saveComfyuiInstanceEditor(); });
  comfyuiInstanceField('credential_type').addEventListener('change', () => {
  comfyuiInstanceState.credentialChanged = true;
  renderComfyuiInstanceCredentialFields();
  });
  document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const id = Number(target.dataset.id);
  if (target.dataset.action === 'open-comfyui-instance-create') void openComfyuiInstanceEditor(null, target);
  if (target.dataset.action === 'open-comfyui-instance-detail') void openComfyuiInstanceEditor(id, target);
  if (target.dataset.action === 'close-comfyui-instance-editor') closeComfyuiInstanceEditor();
  if (target.dataset.action === 'validate-comfyui-instance') void validateComfyuiInstance();
  if (target.dataset.action === 'open-comfyui-instance-delete') void openComfyuiInstanceDelete(id);
  if (target.dataset.action === 'close-comfyui-instance-delete') closeComfyuiInstanceDelete();
  if (target.dataset.action === 'confirm-comfyui-instance-delete') void confirmComfyuiInstanceDelete();
  if (target.dataset.action === 'previous-comfyui-instance-page') void loadComfyuiInstances(comfyuiInstanceState.page - 1);
  if (target.dataset.action === 'next-comfyui-instance-page') void loadComfyuiInstances(comfyuiInstanceState.page + 1);
  if (target.dataset.action === 'go-comfyui-instance-page') void loadComfyuiInstances(Number(target.dataset.page));
  });

  renderComfyuiInstanceList();
  void loadComfyuiInstances();
}
