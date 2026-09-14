import { imageManagerEmptySlots, managementListReadyStatus, mediaRangeLabel, mediaWindow, renderManagementListStatus } from './generation-resource-shared.js';
import { MANAGEMENT_LIST_PAGE_CONFIG } from './management-list-page-config.mjs';
import { bindManagementFilterForm } from './management-list-layout.js';

const state = {
  catalog: [], get items() { return this.catalog; }, set items(value) { this.catalog = value; },
  filter: 'all', query: '', baseModelId: '', availability: '', totalCount: 0, totalPages: 1, page: 1,
  loading: false, listView: 'loading', pending: new Set(), readOnly: false,
  detail: null, detailGeneration: 0, editorTrigger: null, editorLoading: false, confirm: null,
  baseModels: [], works: [], selectedWorkId: null, workPanelOpen: false, workSearch: '',
  pendingImages: [], pendingCoverId: null, nextPendingImageId: 1,
  mediaPage: 0, managerPage: 0, previewIndex: 0, managerTrigger: null, previewTrigger: null
};

const PAGE_CONFIG = MANAGEMENT_LIST_PAGE_CONFIG.catalog;
const DEFAULT_LIMIT = PAGE_CONFIG.pageSize;
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const urlTools = globalThis.__NOOBAI_URLS__;
if (!urlTools) throw new Error('runtime URL resolver is missing from the HTML document');
const httpClient = globalThis.__NOOBAI_HTTP__;
const paginationTools = globalThis.__NOOBAI_PAGINATION__;
if (!httpClient || !paginationTools) throw new Error('HTTP and pagination clients are missing from the HTML document');
const apiUrl = (path) => urlTools.api(path);
const mediaUrl = (path) => urlTools.media(path);
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const itemKey = (item) => `${item.kind}:${item.id}`;
const kindLabel = (kind) => ({ work: '作品', character: '角色', style: '画风' }[kind] ?? kind);
const pendingKey = (action, target = '') => `${action}:${target}`;
const requestId = () => `manage-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function setMessage(text, busy = false) {
  const element = $('#manage-status');
  renderManagementListStatus(element, text, busy);
}
function showError(text = '') { const element = $('#manage-error'); element.hidden = !text; element.textContent = text; }
function editorError(text = '') { const element = $('#manage-editor-error'); element.hidden = !text; element.textContent = text; }
function friendlyError(operation, error) {
  const definition = httpClient.TRANSPORT_ERROR_UI[error?.code];
  if (definition) return `${operation}：${definition.message} 下一步：${definition.next}`;
  if (error?.code === 'DUPLICATE_RESOURCE') return `${operation}：同一关系范围内已经存在该名称，请修改名称后重试。`;
  if (error?.code === 'RELATION_CONFLICT') return `${operation}：所选作品或底模不存在，请刷新选项后重试。`;
  return `${operation}：${error?.message || '服务暂时无法完成此操作'}。当前页面内容保持不变，请检查后重试。`;
}
function lock(action, target = '') { const key = pendingKey(action, target); if (state.pending.has(key)) return false; state.pending.add(key); return true; }
function unlock(action, target = '') { state.pending.delete(pendingKey(action, target)); }
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-request-id', requestId());
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return httpClient.requestJson({ path, options: { ...options, headers }, requestId: headers.get('x-request-id'), timeoutMs: httpClient.DEFAULT_TIMEOUT_MS });
}
function openDialog(dialog) { if (!dialog.open) dialog.showModal(); }
function closeDialog(dialog) { if (dialog?.open) dialog.close(); }
function imageSource(image) { return image.local_url ?? mediaUrl(image.media_path); }
function imageMarkup(mediaPath, label) {
  if (!mediaPath) return `<div class="card-cover image-placeholder"><span>${escapeHtml(label)}</span></div>`;
  return `<div class="card-cover image-frame"><img src="${escapeHtml(mediaUrl(mediaPath))}" alt="${escapeHtml(label)}" data-media-image><span class="image-placeholder-label">图片加载失败</span></div>`;
}
function installImageFailureHandlers() {
  document.querySelectorAll('[data-media-image]').forEach((image) => image.addEventListener('error', () => { image.hidden = true; image.parentElement.classList.add('is-broken'); }, { once: true }));
}

function render() {
  const list = $('#manage-list');
  list.innerHTML = state.listView === 'loading'
    ? '<div class="base-model-skeleton" aria-busy="true" aria-label="正在载入角色画师目录"><span></span><span></span><span></span></div>'
    : state.listView === 'error'
      ? '<p class="state-line error">角色画师目录读取失败。</p>'
      : state.catalog.length === 0
        ? '<p class="state-line">暂无匹配档案。</p>'
        : state.catalog.map((item) => {
          const unavailable = item.is_available === false;
          const summary = item.kind === 'work'
            ? [...(item.aliases ?? []), item.category_name].filter(Boolean).join(' · ')
            : item.kind === 'character' ? item.prompt_text : item.style_description;
          const metadata = item.kind === 'character' ? `所属作品：${item.work_name ?? '未识别'}` : item.kind === 'style' ? `底模：${item.base_model_name ?? '未识别'}` : item.category_name ?? '作品';
          return `<article class="manage-card${unavailable ? ' is-unavailable' : ''}" data-item="${escapeHtml(itemKey(item))}"><header><span class="type-tag">${kindLabel(item.kind)}</span></header>${imageMarkup(item.cover_media_path, `${kindLabel(item.kind)}封面`)}<strong class="card-name">${escapeHtml(item.name)}</strong><span class="card-summary">${escapeHtml(summary || '暂无说明')}</span><div class="card-footer"><span class="card-footer-tag">${escapeHtml(metadata)}</span><span>${unavailable ? '停用' : '可用'}</span></div><div class="manage-actions"><button class="secondary-button" data-action="open-detail" data-item="${escapeHtml(itemKey(item))}">编辑</button></div></article>`;
        }).join('');
  $('#manage-pagination').innerHTML = paginationTools.renderControls({ page: state.page, totalPages: state.totalPages, totalCount: state.totalCount, loading: state.loading, previousAction: 'previous-page', nextAction: 'next-page', pageAction: 'go-page' });
  installImageFailureHandlers();
}
function catalogRequestUrl(page) {
  const url = new URL(apiUrl('/manage/items'));
  url.searchParams.set('kind', state.filter);
  url.searchParams.set('limit', String(DEFAULT_LIMIT));
  url.searchParams.set('page', String(page));
  if (state.query) url.searchParams.set('q', state.query);
  if (state.baseModelId) url.searchParams.set('base_model_id', state.baseModelId);
  if (state.availability) url.searchParams.set('availability', state.availability);
  return url;
}
const catalogPagination = paginationTools.createListController({
  state,
  fetchPage: (page) => api(catalogRequestUrl(page)), render,
  setStatus: setMessage, setError: showError,
  loadingMessage: '正在载入角色画师目录……', emptyMessage: '暂无可用档案。',
  readyMessage: (response) => managementListReadyStatus(response, PAGE_CONFIG.pageSize),
  failureMessage: '角色画师目录加载失败。', errorMessage: (error) => friendlyError('角色画师目录加载失败', error)
});
function loadCatalog({ page = 1, reset = false, fallbackToLastPage = false } = {}) { return catalogPagination.load(reset ? 1 : page, { fallbackToLastPage }); }

function clearPendingImages() {
  for (const image of state.pendingImages) globalThis.URL?.revokeObjectURL?.(image.local_url);
  state.pendingImages = []; state.pendingCoverId = null;
}
function createEmptyItem(kind) {
  return { kind, id: null, name: '', aliases: [], category_name: null, is_available: true, work_id: null, prompt_text: '', base_model_id: null, style_description: null, cover_media_path: null, created_at: null, updated_at: null };
}
function normalizeWrittenItem(record) { return { ...record, aliases: record.aliases_json ?? record.aliases ?? [] }; }
function currentItem() { return state.detail?.item ?? null; }
function currentImages() { return currentItem()?.id === null ? state.pendingImages : state.detail?.snapshot?.images ?? []; }
function currentCoverPath() {
  if (currentItem()?.id === null) return state.pendingImages.find((image) => image.pending_id === state.pendingCoverId)?.local_url ?? null;
  return state.detail?.snapshot?.cover_media_path ?? currentItem()?.cover_media_path ?? null;
}
function setEditorMode() {
  const item = currentItem(); const creating = item.id === null;
  $('#detail-title').textContent = creating ? `新增${kindLabel(item.kind)}` : `编辑${kindLabel(item.kind)}`;
  $('#detail-subtitle').textContent = creating ? '' : item.name;
  $('#manage-create-kind-field').hidden = !creating; $('#manage-create-kind').value = item.kind;
  $('#manage-editor-delete').hidden = creating;
  $('#manage-editor-submit').textContent = creating ? `创建${kindLabel(item.kind)}` : '保存更改';
}
function aliasText(item) { return (item.aliases ?? item.aliases_json ?? []).join('\n'); }
function renderWorkControl() {
  const root = $('#manage-work-combobox'); if (!root) return;
  const selected = state.works.find((work) => work.id === state.selectedWorkId);
  const query = state.workSearch.trim().toLocaleLowerCase('zh-CN');
  const options = state.works.filter((work) => work.name.toLocaleLowerCase('zh-CN').includes(query));
  $('#manage-work-trigger').textContent = selected?.name ?? '请选择所属作品';
  $('#manage-work-trigger').setAttribute('aria-expanded', String(state.workPanelOpen));
  $('#manage-work-panel').hidden = !state.workPanelOpen;
  $('#manage-work-options').innerHTML = options.length === 0 ? '<p class="searchable-multi-empty">没有匹配的作品</p>' : options.map((work) => `<button type="button" role="option" aria-selected="${work.id === state.selectedWorkId}" data-action="select-work" data-work-id="${work.id}">${escapeHtml(work.name)}</button>`).join('');
  root.querySelector('[name="work_id"]').value = state.selectedWorkId ?? '';
}
function renderEditorFields() {
  const item = currentItem(); const aliases = escapeHtml(aliasText(item));
  if (item.kind === 'work') {
    $('#manage-editor-fields').innerHTML = `<section class="editor-section"><h3>作品信息</h3><label>作品名称<input name="name" required maxlength="200" value="${escapeHtml(item.name)}"></label><div class="model-form-grid"><label>分类名称<input name="category_name" maxlength="200" value="${escapeHtml(item.category_name ?? '')}"></label><label class="checkbox-field"><input name="is_available" type="checkbox" ${item.is_available ? 'checked' : ''}>可在目录中使用</label></div><label>别名，每行一个<textarea name="aliases_json" rows="5">${aliases}</textarea></label></section>`;
  } else if (item.kind === 'character') {
    state.selectedWorkId = item.work_id;
    $('#manage-editor-fields').innerHTML = `<section class="editor-section"><h3>角色信息</h3><div class="model-form-grid"><div id="manage-work-combobox" class="relation-combobox"><span class="field-label">所属作品</span><button id="manage-work-trigger" type="button" role="combobox" aria-expanded="false" aria-controls="manage-work-panel" aria-autocomplete="list" data-action="toggle-work-panel">请选择所属作品</button><div id="manage-work-panel" class="relation-combobox-panel" hidden><label>搜索作品名称<input id="manage-work-search" type="search" placeholder="搜索作品名称" autocomplete="off"></label><div id="manage-work-options" role="listbox"></div></div><input type="hidden" name="work_id" value=""></div><label>角色名称<input name="name" required maxlength="200" value="${escapeHtml(item.name)}"></label></div><label>角色别名，每行一个<textarea name="aliases_json" rows="3">${aliases}</textarea></label><label>角色提示词<textarea name="prompt_text" required rows="5">${escapeHtml(item.prompt_text ?? '')}</textarea></label><label class="checkbox-field"><input name="is_available" type="checkbox" ${item.is_available ? 'checked' : ''}>可在目录中使用</label></section>`;
    renderWorkControl();
  } else {
    const options = state.baseModels.map((base) => `<option value="${base.id}" ${base.id === item.base_model_id ? 'selected' : ''}>${escapeHtml(base.name)}</option>`).join('');
    $('#manage-editor-fields').innerHTML = `<section class="editor-section"><h3>画风信息</h3><div class="model-form-grid"><label>底模<select name="base_model_id" required><option value="">请选择底模</option>${options}</select></label><label>画风名称<input name="name" required maxlength="200" value="${escapeHtml(item.name)}"></label></div><label>画风别名，每行一个<textarea name="aliases_json" rows="3">${aliases}</textarea></label><label>画风提示词<textarea name="prompt_text" required rows="4">${escapeHtml(item.prompt_text ?? '')}</textarea></label><label>画风说明<textarea name="style_description" rows="5">${escapeHtml(item.style_description ?? '')}</textarea></label></section>`;
  }
}
function renderRecordInfo() {
  const item = currentItem(); const panel = $('#manage-record-info'); panel.hidden = item.id === null;
  panel.innerHTML = item.id === null ? '' : `<div class="record-info-row"><span>记录编号</span><strong>#${item.id}</strong></div><div class="record-info-row"><span>资源类型</span><strong>${kindLabel(item.kind)}</strong></div>${item.created_at ? `<div class="record-info-row"><span>创建时间</span><strong>${escapeHtml(item.created_at)}</strong></div>` : ''}${item.updated_at ? `<div class="record-info-row"><span>最后更新</span><strong>${escapeHtml(item.updated_at)}</strong></div>` : ''}`;
}
function setEditorLoading(loading) {
  state.editorLoading = loading;
  $('#manage-editor-form').querySelectorAll('input,select,textarea,button').forEach((element) => { element.disabled = loading; });
  $('#manage-editor-submit').disabled = loading;
}
function markDirty() { if (currentItem()) $('#manage-editor-status').textContent = '更改尚未保存'; }

function renderMedia() {
  const images = currentImages(); const coverPath = currentCoverPath(); const window = mediaWindow(images, state.mediaPage); state.mediaPage = window.page;
  const coverIndex = images.findIndex((image) => (image.local_url ?? image.media_path) === coverPath);
  const cover = coverIndex < 0 ? '<div class="editor-cover image-placeholder"><span>暂无封面</span></div>' : `<button type="button" class="editor-cover image-frame" data-action="open-image-preview" data-image-index="${coverIndex}" aria-label="查看${kindLabel(currentItem().kind)}封面原图"><img src="${escapeHtml(imageSource(images[coverIndex]))}" alt="${kindLabel(currentItem().kind)}封面" data-media-image><span class="image-placeholder-label">图片加载失败</span></button>`;
  const thumbnails = window.items.map((image, offset) => `<button type="button" class="editor-media-thumbnail${(image.local_url ?? image.media_path) === coverPath ? ' is-cover' : ''}" data-action="open-image-preview" data-image-index="${window.start + offset}" aria-label="查看资源图片 ${window.start + offset + 1} 原图"><img src="${escapeHtml(imageSource(image))}" alt="资源图片 ${window.start + offset + 1}" data-media-image></button>`).join('');
  $('#manage-image-list').innerHTML = `${cover}<div class="editor-media-pager"><span>${mediaRangeLabel(window)}</span><button type="button" data-action="previous-media-group" aria-label="显示前 3 张图片" ${window.page === 0 ? 'disabled' : ''}>←</button><button type="button" data-action="next-media-group" aria-label="显示后 3 张图片" ${window.page >= window.totalPages - 1 ? 'disabled' : ''}>→</button></div><div class="editor-media-thumbnails">${thumbnails || '<span class="detail-empty">暂无资源图片</span>'}</div>`;
  renderImageManager(); if ($('#manage-image-preview').open) renderImagePreview(); installImageFailureHandlers();
}
function renderImageManager() {
  const images = currentImages(); const window = mediaWindow(images, state.managerPage); state.managerPage = window.page;
  $('#manage-image-manager-range').textContent = mediaRangeLabel(window);
  $('[data-action="previous-image-group"]').disabled = window.page === 0; $('[data-action="next-image-group"]').disabled = window.page >= window.totalPages - 1;
  const coverPath = currentCoverPath();
  const cards = window.items.map((image, offset) => {
    const index = window.start + offset; const isCover = (image.local_url ?? image.media_path) === coverPath;
    return `<article class="image-manager-card${isCover ? ' is-cover' : ''}"><button type="button" class="image-manager-preview" data-action="open-image-preview" data-image-index="${index}"><img src="${escapeHtml(imageSource(image))}" alt="资源图片 ${index + 1}" data-media-image></button><strong>资源图片 ${index + 1}</strong><span>${isCover ? '当前封面' : ''}</span><div class="image-manager-card-actions"><button type="button" data-action="set-cover" data-image-index="${index}" ${isCover ? 'disabled' : ''}>设为封面</button><button type="button" data-action="move-image-up" data-image-index="${index}" ${index === 0 ? 'disabled' : ''}>前移</button><button type="button" data-action="move-image-down" data-image-index="${index}" ${index === images.length - 1 ? 'disabled' : ''}>后移</button><button type="button" class="danger-button" data-action="delete-image" data-image-index="${index}">删除</button></div></article>`;
  }).join('');
  const remaining = 3 - window.items.length;
  $('#manage-image-manager-grid').innerHTML = `${cards}${imageManagerEmptySlots(remaining, 'choose-images', window.total)}`;
  installImageFailureHandlers();
}
function renderImagePreview() {
  const images = currentImages(); if (images.length === 0) return;
  state.previewIndex = ((state.previewIndex % images.length) + images.length) % images.length;
  const image = images[state.previewIndex]; $('#manage-image-preview-image').src = imageSource(image);
  $('#manage-image-preview-image').alt = `${kindLabel(currentItem().kind)}资源原图 ${state.previewIndex + 1}`;
  $('#manage-image-preview-count').textContent = `资源图片 ${state.previewIndex + 1} / ${images.length}`;
  $('[data-action="previous-image-preview"]').disabled = images.length <= 1; $('[data-action="next-image-preview"]').disabled = images.length <= 1;
}
function renderEditor() { setEditorMode(); renderEditorFields(); renderRecordInfo(); renderMedia(); }

async function openEditor(rawKey = null, trigger = null) {
  const generation = ++state.detailGeneration; state.editorTrigger = trigger;
  Object.assign(state, { mediaPage: 0, managerPage: 0, previewIndex: 0, workPanelOpen: false, workSearch: '' });
  clearPendingImages(); editorError(); $('#manage-editor-status').textContent = '';
  if (rawKey === null) {
    state.detail = { item: createEmptyItem('work'), snapshot: { images: [], cover_media_path: null } };
    renderEditor(); openDialog($('#manage-detail')); $('[data-action="close-detail"]').focus?.(); return;
  }
  const [kind, idText] = rawKey.split(':'); const id = Number(idText); const listItem = state.catalog.find((item) => item.kind === kind && item.id === id);
  state.detail = { item: { ...(listItem ?? createEmptyItem(kind)), id, kind }, snapshot: { images: [], cover_media_path: listItem?.cover_media_path ?? null } };
  openDialog($('#manage-detail')); setEditorLoading(true); $('#manage-image-list').innerHTML = '<p class="detail-loading">正在读取表单和资源图片……</p>';
  try {
    const [item, media] = await Promise.all([api(apiUrl(`/manage/items/${kind}/${id}`)), api(apiUrl(`/items/${kind}/${id}/images`))]);
    if (generation !== state.detailGeneration || !$('#manage-detail').open) return;
    state.detail = { item: { ...item, id, kind }, snapshot: media }; renderEditor();
  } catch (error) { if (generation === state.detailGeneration && $('#manage-detail').open) editorError(friendlyError('读取编辑内容失败', error)); }
  finally { if (generation === state.detailGeneration && $('#manage-detail').open) { setEditorLoading(false); $('[data-action="close-detail"]').focus?.(); } }
}
function closeEditor() {
  state.detailGeneration += 1; closeImagePreview(); closeImageManager(); closeDialog($('#manage-detail')); clearPendingImages(); state.detail = null;
  state.editorTrigger?.focus?.(); state.editorTrigger = null;
}
function switchCreateKind(kind) {
  clearPendingImages(); state.detail = { item: createEmptyItem(kind), snapshot: { images: [], cover_media_path: null } };
  Object.assign(state, { mediaPage: 0, managerPage: 0, selectedWorkId: null, workPanelOpen: false, workSearch: '' });
  editorError(); $('#manage-editor-status').textContent = ''; renderEditor();
}
function parseAliases(value) { return value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean); }
function field(name) { return $('#manage-editor-form').elements.namedItem(name); }
function editorPayload() {
  const item = currentItem(); const common = { name: field('name').value.trim(), aliases_json: parseAliases(field('aliases_json').value) };
  if (item.kind === 'work') return { ...common, category_name: field('category_name').value.trim() || null, is_available: field('is_available').checked };
  if (item.kind === 'character') return { work_id: Number(field('work_id').value), ...common, prompt_text: field('prompt_text').value.trim(), is_available: field('is_available').checked };
  return { base_model_id: Number(field('base_model_id').value), ...common, prompt_text: field('prompt_text').value.trim(), style_description: field('style_description').value.trim() || null };
}
function updateCardFromEditor() {
  const item = currentItem(); const index = state.catalog.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id); if (index < 0) return;
  state.catalog[index] = { ...state.catalog[index], ...item, aliases: item.aliases ?? item.aliases_json ?? [], cover_media_path: state.detail.snapshot.cover_media_path }; render();
}
async function uploadPendingAfterCreate(item) {
  if (state.pendingImages.length === 0) return true;
  const form = new FormData(); state.pendingImages.forEach((image) => form.append('files', image.file));
  try {
    let snapshot = await api(apiUrl(`/items/${item.kind}/${item.id}/images`), { method: 'POST', body: form });
    const coverIndex = Math.max(0, state.pendingImages.findIndex((image) => image.pending_id === state.pendingCoverId)); const cover = snapshot.images[coverIndex];
    state.detail.snapshot = snapshot; clearPendingImages();
    if (cover) {
      try { snapshot = await api(apiUrl(`/items/${item.kind}/${item.id}/cover`), { method: 'PUT', body: JSON.stringify({ id: cover.id }) }); }
      catch (error) { state.detail.snapshot = snapshot; editorError(`图片已上传，但设置封面失败。${friendlyError('设置封面失败', error)}`); return false; }
    }
    state.detail.snapshot = snapshot; return true;
  } catch (error) { editorError(`记录 #${item.id} 已创建，但图片上传失败。${friendlyError('上传图片失败', error)}`); return false; }
}
async function saveEditor() {
  const item = currentItem(); const pendingTarget = `${item?.kind}:${item?.id ?? 'new'}`;
  if (!item || state.editorLoading || !lock('save', pendingTarget)) return;
  const generation = state.detailGeneration; setEditorLoading(true); editorError();
  try {
    const payload = editorPayload();
    const record = await api(apiUrl(item.id === null ? `/manage/items/${item.kind}` : `/manage/items/${item.kind}/${item.id}`), { method: item.id === null ? 'POST' : 'PUT', body: JSON.stringify(payload) });
    if (generation !== state.detailGeneration || !$('#manage-detail').open) return;
    const wasCreating = item.id === null; state.detail.item = normalizeWrittenItem(record);
    if (wasCreating) await uploadPendingAfterCreate(state.detail.item);
    if (state.detail.snapshot?.owner_id !== state.detail.item.id) state.detail.snapshot = await api(apiUrl(`/items/${state.detail.item.kind}/${state.detail.item.id}/images`));
    renderEditor(); $('#manage-editor-status').textContent = wasCreating ? `已创建记录 #${state.detail.item.id}` : '更改已保存'; await loadCatalog({ page: wasCreating ? 1 : state.page });
  } catch (error) { if (generation === state.detailGeneration && $('#manage-detail').open) editorError(friendlyError(item.id === null ? `创建${kindLabel(item.kind)}失败` : `保存${kindLabel(item.kind)}失败`, error)); }
  finally { if (generation === state.detailGeneration && $('#manage-detail').open) setEditorLoading(false); unlock('save', pendingTarget); }
}

function validateImageFiles(files) {
  if (files.length > 10) throw new Error('每批最多添加 10 张图片。');
  for (const file of files) {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) throw new Error(`文件“${file.name}”不是 JPEG、PNG 或 WebP 图片。`);
    if (file.size > 10 * 1024 * 1024) throw new Error(`文件“${file.name}”超过 10 MiB。`);
  }
}
function addPendingImages(files, selectCover = false) {
  validateImageFiles(files);
  for (const file of files) {
    const pendingId = state.nextPendingImageId++; const localUrl = globalThis.URL?.createObjectURL?.(file) ?? `pending:${pendingId}`;
    state.pendingImages.push({ pending_id: pendingId, file, local_url: localUrl, media_path: localUrl });
    if (selectCover || state.pendingCoverId === null) state.pendingCoverId = pendingId;
  }
  state.managerPage = Math.max(0, Math.ceil(state.pendingImages.length / 3) - 1); renderMedia(); markDirty();
}
function setMediaPending(pending) {
  $('#manage-editor-media').querySelectorAll('input,button').forEach((element) => { element.disabled = pending; });
  $('#manage-image-manager').querySelectorAll('button').forEach((element) => { element.disabled = pending; });
}
async function uploadRemoteImages(files) {
  const item = currentItem(); if (!lock('upload-images', item.id)) return; setMediaPending(true); editorError();
  try {
    validateImageFiles(files); const form = new FormData(); files.forEach((file) => form.append('files', file));
    state.detail.snapshot = await api(apiUrl(`/items/${item.kind}/${item.id}/images`), { method: 'POST', body: form });
    state.managerPage = Math.max(0, Math.ceil(state.detail.snapshot.images.length / 3) - 1); $('#manage-media-status').textContent = `已添加 ${files.length} 张图片。`; renderMedia(); updateCardFromEditor();
  } catch (error) { editorError(friendlyError('添加图片失败', error)); }
  finally { setMediaPending(false); unlock('upload-images', item.id); }
}
async function replaceCover(file) {
  const item = currentItem(); if (item.id === null) { addPendingImages([file], true); return; }
  if (!lock('replace-cover', item.id)) return; setMediaPending(true); editorError(); const existing = new Set(currentImages().map(({ id }) => id));
  try {
    validateImageFiles([file]); const form = new FormData(); form.append('files', file);
    const uploaded = await api(apiUrl(`/items/${item.kind}/${item.id}/images`), { method: 'POST', body: form }); state.detail.snapshot = uploaded; renderMedia();
    const added = uploaded.images.find((image) => !existing.has(image.id)); if (!added) throw new Error('无法识别新上传的图片记录');
    try { state.detail.snapshot = await api(apiUrl(`/items/${item.kind}/${item.id}/cover`), { method: 'PUT', body: JSON.stringify({ id: added.id }) }); $('#manage-media-status').textContent = '已更换封面。'; renderMedia(); updateCardFromEditor(); }
    catch (error) { editorError(`图片已上传，但设置封面失败。${friendlyError('设置封面失败', error)}`); }
  } catch (error) { editorError(friendlyError('上传封面失败', error)); }
  finally { setMediaPending(false); unlock('replace-cover', item.id); }
}
async function setCoverAt(index) {
  const item = currentItem(); const image = currentImages()[index]; if (!image) return;
  if (item.id === null) { state.pendingCoverId = image.pending_id; renderMedia(); markDirty(); return; }
  if (!lock('set-cover', item.id)) return; setMediaPending(true); editorError();
  try { state.detail.snapshot = await api(apiUrl(`/items/${item.kind}/${item.id}/cover`), { method: 'PUT', body: JSON.stringify({ id: image.id }) }); renderMedia(); updateCardFromEditor(); }
  catch (error) { editorError(friendlyError('设置封面失败', error)); }
  finally { setMediaPending(false); unlock('set-cover', item.id); }
}
async function moveImage(index, delta) {
  const item = currentItem(); const images = currentImages(); const nextIndex = index + delta; if (nextIndex < 0 || nextIndex >= images.length) return;
  if (item.id === null) { [state.pendingImages[index], state.pendingImages[nextIndex]] = [state.pendingImages[nextIndex], state.pendingImages[index]]; state.managerPage = Math.floor(nextIndex / 3); renderMedia(); markDirty(); return; }
  if (!lock('reorder-images', item.id)) return; setMediaPending(true); editorError(); const ids = images.map(({ id }) => id); [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
  try { state.detail.snapshot = await api(apiUrl(`/items/${item.kind}/${item.id}/images/order`), { method: 'PUT', body: JSON.stringify({ ids }) }); state.managerPage = Math.floor(nextIndex / 3); renderMedia(); }
  catch (error) { editorError(friendlyError('调整图片顺序失败', error)); }
  finally { setMediaPending(false); unlock('reorder-images', item.id); }
}
function showConfirm(kind, payload) { state.confirm = { kind, ...payload }; $('#confirm-title').textContent = kind === 'image' ? '确认删除图片' : `确认删除${kindLabel(currentItem()?.kind)}`; $('#confirm-copy').textContent = payload.copy; openDialog($('#manage-confirm')); }
async function deleteConfirmedImage() {
  const item = currentItem(); const { index } = state.confirm; const image = currentImages()[index]; if (!image) return;
  if (item.id === null) {
    globalThis.URL?.revokeObjectURL?.(image.local_url); state.pendingImages.splice(index, 1); if (state.pendingCoverId === image.pending_id) state.pendingCoverId = state.pendingImages[0]?.pending_id ?? null;
    state.managerPage = mediaWindow(state.pendingImages, state.managerPage).page; closeDialog($('#manage-confirm')); state.confirm = null; renderMedia(); markDirty(); return;
  }
  if (!lock('delete-image', image.id)) return;
  try { state.detail.snapshot = await api(apiUrl(`/items/${item.kind}/${item.id}/images/${image.id}`), { method: 'DELETE' }); state.managerPage = mediaWindow(state.detail.snapshot.images, state.managerPage).page; renderMedia(); updateCardFromEditor(); }
  catch (error) { editorError(friendlyError('删除图片失败', error)); }
  finally { unlock('delete-image', image.id); closeDialog($('#manage-confirm')); state.confirm = null; }
}
async function deleteCurrentItem() {
  const item = currentItem(); if (!item?.id || !lock('delete-item', itemKey(item))) return;
  try {
    const result = await api(apiUrl('/items/batch-delete'), { method: 'POST', body: JSON.stringify({ items: [{ kind: item.kind, id: item.id }] }) }); closeDialog($('#manage-confirm')); state.confirm = null; closeEditor();
    await loadCatalog({ page: state.page, fallbackToLastPage: true }); if (result.cleanup_warnings?.length) showError('记录已删除，但部分图片文件正在等待清理。');
  } catch (error) { editorError(friendlyError('删除记录失败', error)); }
  finally { unlock('delete-item', itemKey(item)); }
}
function openImageManager(trigger) { state.managerTrigger = trigger; state.managerPage = state.mediaPage; renderImageManager(); openDialog($('#manage-image-manager')); $('[data-action="close-image-manager"]').focus?.(); }
function closeImageManager() { closeDialog($('#manage-image-manager')); state.managerTrigger?.focus?.(); state.managerTrigger = null; }
function openImagePreview(index, trigger) { state.previewTrigger = trigger; state.previewIndex = index; renderImagePreview(); openDialog($('#manage-image-preview')); $('[data-action="close-image-preview"]').focus?.(); }
function closeImagePreview() { closeDialog($('#manage-image-preview')); state.previewTrigger?.focus?.(); state.previewTrigger = null; }

async function submitSearch() {
  const query = $('#manage-search').value.trim().replace(/\s+/gu, ' '); const target = `${$('#manage-kind').value}:${query}:${$('#manage-base-model').value}:${$('#manage-availability').value}`;
  if (!lock('search', target)) return false;
  state.query = query; state.filter = $('#manage-kind').value; state.baseModelId = $('#manage-base-model').value; state.availability = $('#manage-availability').value;
  try { return await loadCatalog({ reset: true }); } finally { unlock('search', target); }
}
bindManagementFilterForm({ config: PAGE_CONFIG, form: $('#manage-filter-form'), keyword: $('#manage-search'), onApply: submitSearch, onReset() { Object.assign(state, { query: '', filter: 'all', baseModelId: '', availability: '' }); return loadCatalog({ reset: true }); } });
$('#manage-editor-form').addEventListener('submit', (event) => { event.preventDefault(); void saveEditor(); });
$('#manage-create-kind').addEventListener('change', (event) => switchCreateKind(event.target.value));
$('#manage-cover-upload').addEventListener('change', (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void replaceCover(file); });
$('#manage-image-upload').addEventListener('change', (event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (!files.length) return; try { if (currentItem().id === null) addPendingImages(files); else void uploadRemoteImages(files); } catch (error) { editorError(error.message); } });
document.addEventListener('input', (event) => { if (event.target.id === 'manage-work-search') { state.workSearch = event.target.value; renderWorkControl(); return; } if (event.target.closest('#manage-editor-form')) markDirty(); });
document.addEventListener('change', (event) => { if (event.target.closest('#manage-editor-form') && event.target.id !== 'manage-create-kind') markDirty(); });
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]'); if (!target || target.disabled) return; const action = target.dataset.action; const index = Number(target.dataset.imageIndex);
  if (action === 'open-create') void openEditor(null, target);
  if (action === 'open-detail') void openEditor(target.dataset.item, target);
  if (action === 'close-detail') closeEditor();
  if (action === 'previous-page') void loadCatalog({ page: state.page - 1 });
  if (action === 'next-page') void loadCatalog({ page: state.page + 1 });
  if (action === 'go-page') void loadCatalog({ page: Number(target.dataset.page) });
  if (action === 'toggle-work-panel') { state.workPanelOpen = !state.workPanelOpen; renderWorkControl(); if (state.workPanelOpen) $('#manage-work-search').focus(); }
  if (action === 'select-work') { state.selectedWorkId = Number(target.dataset.workId); state.workPanelOpen = false; state.workSearch = ''; renderWorkControl(); markDirty(); $('#manage-work-trigger').focus(); }
  if (action === 'choose-cover') $('#manage-cover-upload').click();
  if (action === 'choose-images') $('#manage-image-upload').click();
  if (action === 'open-image-manager') openImageManager(target);
  if (action === 'close-image-manager') closeImageManager();
  if (action === 'previous-image-group') { state.managerPage -= 1; renderImageManager(); }
  if (action === 'next-image-group') { state.managerPage += 1; renderImageManager(); }
  if (action === 'previous-media-group') { state.mediaPage -= 1; renderMedia(); }
  if (action === 'next-media-group') { state.mediaPage += 1; renderMedia(); }
  if (action === 'open-image-preview') openImagePreview(index, target);
  if (action === 'close-image-preview') closeImagePreview();
  if (action === 'previous-image-preview') { state.previewIndex -= 1; renderImagePreview(); }
  if (action === 'next-image-preview') { state.previewIndex += 1; renderImagePreview(); }
  if (action === 'set-cover') void setCoverAt(index);
  if (action === 'move-image-up') void moveImage(index, -1);
  if (action === 'move-image-down') void moveImage(index, 1);
  if (action === 'delete-image') showConfirm('image', { index, copy: `将删除资源图片 ${index + 1}。` });
  if (action === 'delete-current') showConfirm('object', { copy: `将删除${kindLabel(currentItem().kind)}“${currentItem().name}”及其资源图片。` });
  if (action === 'cancel-confirm') { closeDialog($('#manage-confirm')); state.confirm = null; }
  if (action === 'confirm-delete') { if (state.confirm?.kind === 'image') void deleteConfirmedImage(); else void deleteCurrentItem(); }
});
document.addEventListener('keydown', (event) => {
  if (state.workPanelOpen && event.key === 'Escape') { event.preventDefault(); state.workPanelOpen = false; state.workSearch = ''; renderWorkControl(); $('#manage-work-trigger').focus(); return; }
  if (!$('#manage-image-preview').open) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); state.previewIndex -= 1; renderImagePreview(); }
  if (event.key === 'ArrowRight') { event.preventDefault(); state.previewIndex += 1; renderImagePreview(); }
  if (event.key === 'Escape') { event.preventDefault(); closeImagePreview(); }
});
for (const [selector, close] of [['#manage-image-preview', closeImagePreview], ['#manage-image-manager', closeImageManager], ['#manage-detail', closeEditor], ['#manage-confirm', () => { closeDialog($('#manage-confirm')); state.confirm = null; }]]) {
  $(selector).addEventListener('cancel', (event) => { event.preventDefault(); close(); });
}

render();
Promise.all([api(apiUrl('/manage/base-models?page=1&page_size=100&q=')), api(apiUrl('/manage/items?kind=work&limit=100&page=1'))]).then(([bases, works]) => {
  state.baseModels = bases.items; state.works = works.items;
  $('#manage-base-model').innerHTML = `<option value="">全部底模</option>${bases.items.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
}).catch((error) => showError(friendlyError('读取关系选项失败', error)));
void loadCatalog();
