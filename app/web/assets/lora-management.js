import { createEditableCombobox, createPendingMediaCollection, escapeHtml, friendlyManagementError, http, imageManagerEmptySlots, installDialogFocusReturn, installModelImageFailureHandlers, managementListReadyStatus, mediaRangeLabel, mediaWindow, paginationTools, renderManagementListStatus, showError, urls } from './generation-resource-shared.js';
import { parseLoraTriggerWords, parseLoraWeight } from './lora-form-values.js';
import { MANAGEMENT_LIST_PAGE_CONFIG } from './management-list-page-config.mjs';
import { bindManagementFilterForm } from './management-list-layout.js';

const PAGE_CONFIG = MANAGEMENT_LIST_PAGE_CONFIG.loras;
const loraState = {
  items: [], page: 1, totalCount: 0, totalPages: 1, query: '', baseModelId: '', modelId: '', fileFormat: '', precision: '', listView: 'loading', loading: false,
  editing: null, editorGeneration: 0, editorLoading: false, media: null, deleting: null, imageDeleting: null,
  listGeneration: 0, deleteGeneration: 0, deleteRequestToken: 0, imageDeleteGeneration: 0, imageDeleteRequestToken: 0,
  imageDeleteTarget: null, pending: new Set(), mediaPage: 0, managerPage: 0, previewIndex: 0, managerTrigger: null, previewTrigger: null
};

const lora$ = (selector) => document.querySelector(selector);
const loraRequestId = () => `generation-lora-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const loraField = (name) => lora$('#lora-form').elements.namedItem(name);
const loraPendingKey = (action, target = '') => `${action}:${target}`;
const loraFileFormatComboboxes = [
  createEditableCombobox({ input: lora$('#lora-filter-file-format'), listbox: lora$('#lora-filter-file-format-listbox') }),
  createEditableCombobox({ input: lora$('#lora-file-format'), listbox: lora$('#lora-file-format-listbox') })
];
const loraPrecisionComboboxes = [
  createEditableCombobox({ input: lora$('#lora-filter-precision'), listbox: lora$('#lora-filter-precision-listbox') }),
  createEditableCombobox({ input: lora$('#lora-precision'), listbox: lora$('#lora-precision-listbox') })
];
const pendingLoraMedia = createPendingMediaCollection();
const rememberLoraEditorTrigger = installDialogFocusReturn(lora$('#lora-editor'));

function loraOpen(dialog) { if (!dialog.open) dialog.showModal(); }
function loraClose(dialog) { if (dialog.open) dialog.close(); }
function loraError(message = '') { showError(lora$('#lora-editor-error'), message); }
function loraStatus(message, busy = false) {
  renderManagementListStatus(lora$('#lora-status'), message, busy);
}
function loraStartPending(action, target = '') {
  const key = loraPendingKey(action, target);
  if (loraState.pending.has(key)) return false;
  loraState.pending.add(key);
  return true;
}
function loraFinishPending(action, target = '') { loraState.pending.delete(loraPendingKey(action, target)); }
function loraOptional(value) {
  const text = String(value ?? '').trim();
  return text.length === 0 ? null : text;
}
function loraFriendlyError(action, error) {
  if (error?.code === 'DUPLICATE_RESOURCE') return `${action}失败：LoRA 已存在，请修改文件名、模型或底模后重试。`;
  if (error?.code === 'RELATION_CONFLICT') return `${action}失败：所选底模或模型不存在，或模型不属于该底模，请刷新后重试。`;
  if (error?.code === 'UPLOAD_TYPE_UNSUPPORTED') return `${action}失败：请选择有效的 JPEG、PNG 或 WebP 图片。`;
  if (error?.code === 'WRITE_FORBIDDEN') return `${action}失败：当前应用不允许写入，请检查应用的写入权限后重试。`;
  if (error?.code === 'DATABASE_BUSY') return `${action}暂时无法完成：数据库繁忙，请稍后重试。`;
  return friendlyManagementError(action, error);
}
async function loraApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-request-id', loraRequestId());
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return await http.requestJson({ path: urls.api(path), options: { ...options, headers }, requestId: headers.get('x-request-id'), timeoutMs: http.DEFAULT_TIMEOUT_MS });
}
function loraImageMarkup(mediaPath, label) {
  if (!mediaPath) return '<div class="card-cover image-placeholder"><span>暂无封面</span></div>';
  return `<div class="card-cover image-frame"><img src="${escapeHtml(urls.media(mediaPath))}" alt="${escapeHtml(label)}" data-media-image><span class="image-placeholder-label">图片加载失败</span></div>`;
}
function loraMediaSource(image) { return image.local_url ?? urls.media(image.media_path); }
function renderLoraList() {
  const list = lora$('#lora-list');
  list.innerHTML = loraState.listView === 'loading'
    ? '<div class="base-model-skeleton" aria-busy="true" aria-label="正在载入 LoRA 列表"><span></span><span></span><span></span></div>'
    : loraState.listView === 'error'
      ? '<p class="state-line error">LoRA 列表读取失败。</p>'
      : loraState.items.length === 0
        ? '<p class="state-line">暂无匹配 LoRA。</p>'
        : loraState.items.map((item) => `<article class="manage-card" data-id="${item.id}">
          <header><span class="type-tag">LoRA</span></header>
          ${loraImageMarkup(item.cover_media_path, `${item.file_name}封面`)}
          <strong class="card-name">${escapeHtml(item.file_name)}</strong>
          <span class="card-summary">${escapeHtml(item.description || '暂无 LoRA 说明')}</span>
          <div class="card-footer"><span class="card-footer-tag">权重 ${item.weight}</span><span>触发词 ${escapeHtml(item.trigger_words[0] ?? '无')}</span></div>
          <div class="manage-actions"><button class="secondary-button" data-action="open-lora-detail" data-id="${item.id}">编辑</button></div>
        </article>`).join('');
  const pagination = lora$('#lora-pagination');
  pagination.innerHTML = paginationTools.renderControls({ page: loraState.page, totalPages: loraState.totalPages, totalCount: loraState.totalCount, loading: loraState.loading, previousAction: 'previous-lora-page', nextAction: 'next-lora-page', pageAction: 'go-lora-page' });
  installModelImageFailureHandlers();
}
const loraPagination = paginationTools.createListController({
  state: loraState,
  fetchPage: async (page) => {
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_CONFIG.pageSize), q: loraState.query });
    if (loraState.baseModelId !== '') query.set('base_model_id', loraState.baseModelId);
    if (loraState.modelId !== '') query.set('model_id', loraState.modelId);
    if (loraState.fileFormat !== '') query.set('file_format', loraState.fileFormat);
    if (loraState.precision !== '') query.set('precision_or_quantization', loraState.precision);
    return loraApi(`/manage/loras?${query}`);
  },
  render: renderLoraList,
  setStatus: loraStatus,
  setError: (message) => showError(lora$('#lora-error'), message),
  loadingMessage: '正在载入 LoRA……',
  emptyMessage: '暂无 LoRA。',
  readyMessage: (response) => managementListReadyStatus(response, PAGE_CONFIG.pageSize),
  failureMessage: 'LoRA 列表读取失败。',
  errorMessage: (error) => loraFriendlyError('读取 LoRA 列表', error)
});

function loadLoras(page = 1, options = {}) { return loraPagination.load(page, options); }
function fillLoraFilterOptions(select, items, emptyLabel, selectedId, labelField) {
  select.innerHTML = `<option value="">${emptyLabel}</option>${items.map((item) => `<option value="${item.id}">${escapeHtml(item[labelField])}</option>`).join('')}`;
  if (selectedId !== '') select.value = selectedId;
}
async function loadLoraFilterOptions(baseModelId = loraState.baseModelId) {
  try {
    const modelQuery = new URLSearchParams({ page: '1', page_size: '100', q: '' });
    if (baseModelId !== '') modelQuery.set('base_model_id', baseModelId);
    const [baseModels, models, options] = await Promise.all([
      loraApi('/manage/base-models?page=1&page_size=100&q='),
      loraApi(`/manage/models?${modelQuery}`),
      loraApi('/manage/generation-resource-options')
    ]);
    fillLoraFilterOptions(lora$('#lora-filter-base-model'), baseModels.items, '全部底模', baseModelId, 'name');
    fillLoraFilterOptions(lora$('#lora-filter-model'), models.items, '全部模型', baseModelId === loraState.baseModelId ? loraState.modelId : '', 'file_name');
    loraFileFormatComboboxes.forEach((combobox) => combobox.setSuggestions(options.file_format_suggestions));
    loraPrecisionComboboxes.forEach((combobox) => combobox.setSuggestions(options.precision_or_quantization_suggestions));
  } catch (error) {
    showError(lora$('#lora-error'), loraFriendlyError('读取 LoRA 筛选选项', error));
  }
}
async function loadLoraBaseOptions(selectedId = null) {
  const data = await loraApi('/manage/base-models?page=1&page_size=100&q=');
  const select = loraField('base_model_id');
  select.innerHTML = `<option value="">请选择底模</option>${data.items.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
  if (selectedId !== null) select.value = String(selectedId);
}
async function loadLoraModelOptions(baseModelId = null, selectedId = null) {
  const query = new URLSearchParams({ page: '1', page_size: '100', q: '' });
  if (baseModelId !== null && baseModelId !== '') query.set('base_model_id', String(baseModelId));
  const data = await loraApi(`/manage/models?${query}`);
  const select = loraField('model_id');
  select.innerHTML = `<option value="">请选择模型</option>${data.items.map((item) => `<option value="${item.id}">${escapeHtml(item.file_name)}</option>`).join('')}`;
  if (selectedId !== null) select.value = String(selectedId);
}
function setLoraEditorLoading(loading) {
  loraState.editorLoading = loading;
  lora$('#lora-form').querySelectorAll('input, select, textarea, button').forEach((element) => { element.disabled = loading; });
  lora$('#lora-editor-submit').disabled = loading;
}
function setLoraEditorMode(id, record = null) {
  const editing = id !== null;
  lora$('#lora-editor-title').textContent = editing ? '编辑 LoRA' : '新增 LoRA';
  lora$('#lora-editor-subtitle').textContent = editing ? (record?.file_name ?? `#${id}`) : '';
  lora$('#lora-editor-delete').hidden = !editing;
  lora$('#lora-editor-delete').dataset.id = editing ? String(id) : '';
  lora$('#lora-editor-submit').textContent = editing ? '保存更改' : '创建 LoRA';
}
function resetLoraForm() {
  lora$('#lora-form').reset();
  [...loraFileFormatComboboxes, ...loraPrecisionComboboxes].forEach((combobox) => combobox.close());
  pendingLoraMedia.clear();
  loraField('base_model_id').innerHTML = '<option value="">正在读取底模……</option>';
  loraField('model_id').innerHTML = '<option value="">正在读取模型……</option>';
  lora$('#lora-media-section').hidden = loraState.editing !== null;
  lora$('#lora-image-list').innerHTML = '';
  lora$('#lora-media-status').textContent = '';
  lora$('#lora-image-upload').value = '';
  loraState.media = loraState.editing === null ? pendingLoraMedia.snapshot() : null;
  Object.assign(loraState, { mediaPage: 0, managerPage: 0, previewIndex: 0 });
  if (loraState.media) renderLoraMedia();
}
function loraWriteFromForm() {
  const weight = parseLoraWeight(loraField('weight').value);
  const triggerWords = parseLoraTriggerWords(loraField('trigger_words').value);
  return Object.freeze({
    base_model_id: Number(loraField('base_model_id').value),
    model_id: Number(loraField('model_id').value),
    file_name: loraField('file_name').value.trim(),
    file_format: loraField('file_format').value,
    precision_or_quantization: loraField('precision_or_quantization').value,
    author: loraOptional(loraField('author').value),
    version: loraOptional(loraField('version').value),
    release_url: loraOptional(loraField('release_url').value),
    description: loraField('description').value.trim(),
    usage: loraField('usage').value.trim(),
    trigger_words: Object.freeze(triggerWords),
    weight
  });
}
function populateLoraForm(item) {
  for (const name of ['base_model_id', 'model_id', 'file_name', 'file_format', 'precision_or_quantization', 'author', 'version', 'release_url', 'description', 'usage']) {
    loraField(name).value = item[name] ?? '';
  }
  loraField('trigger_words').value = item.trigger_words.join('\n');
  loraField('weight').value = String(item.weight);
}
function renderLoraMedia() {
  const list = lora$('#lora-image-list');
  const media = loraState.media;
  if (!media) { list.innerHTML = '<p class="detail-loading">正在读取资源图片……</p>'; return; }
  const coverIndex = media.images.findIndex((image) => image.media_path === media.cover_media_path);
  const window = mediaWindow(media.images, loraState.mediaPage);
  loraState.mediaPage = window.page;
  const cover = coverIndex < 0 ? '<div class="editor-cover image-placeholder"><span>暂无封面</span></div>' : `<button type="button" class="editor-cover image-frame" data-action="open-lora-image-preview" data-image-index="${coverIndex}" aria-label="查看 LoRA 封面原图"><img src="${escapeHtml(loraMediaSource(media.images[coverIndex]))}" alt="LoRA 封面" data-media-image><span class="image-placeholder-label">图片加载失败</span></button>`;
  const thumbnails = window.items.map((image, offset) => `<button type="button" class="editor-media-thumbnail${media.cover_media_path === image.media_path ? ' is-cover' : ''}" data-action="open-lora-image-preview" data-image-index="${window.start + offset}" aria-label="查看 LoRA 资源图片 ${window.start + offset + 1} 原图"><img src="${escapeHtml(loraMediaSource(image))}" alt="LoRA 资源图片 ${window.start + offset + 1}" data-media-image></button>`).join('');
  list.innerHTML = `${cover}<div class="editor-media-pager"><span>${mediaRangeLabel(window)}</span><button type="button" data-action="previous-lora-media-group" aria-label="显示前 3 张图片" ${window.page === 0 ? 'disabled' : ''}>←</button><button type="button" data-action="next-lora-media-group" aria-label="显示后 3 张图片" ${window.page >= window.totalPages - 1 ? 'disabled' : ''}>→</button></div><div class="editor-media-thumbnails">${thumbnails || '<span class="detail-empty">暂无资源图片</span>'}</div>`;
  renderLoraImageManager();
  if (lora$('#lora-image-preview')?.open) renderLoraImagePreview();
  installModelImageFailureHandlers();
}
function renderLoraImageManager() {
  const grid = lora$('#lora-image-manager-grid');
  if (!grid || !loraState.media) return;
  const window = mediaWindow(loraState.media.images, loraState.managerPage);
  loraState.managerPage = window.page;
  lora$('#lora-image-manager-range').textContent = mediaRangeLabel(window);
  const previous = lora$('[data-action="previous-lora-image-group"]');
  const next = lora$('[data-action="next-lora-image-group"]');
  if (previous) previous.disabled = window.page === 0;
  if (next) next.disabled = window.page >= window.totalPages - 1;
  const cards = window.items.map((image, offset) => { const index = window.start + offset; return `<article class="image-manager-card${loraState.media.cover_media_path === image.media_path ? ' is-cover' : ''}"><button type="button" class="image-manager-preview" data-action="open-lora-image-preview" data-image-index="${index}"><img src="${escapeHtml(loraMediaSource(image))}" alt="LoRA 资源图片 ${index + 1}" data-media-image></button><strong>资源图片 ${index + 1}</strong><span>${loraState.media.cover_media_path === image.media_path ? '当前封面' : ''}</span><div class="image-manager-card-actions"><button type="button" data-action="set-lora-cover" data-image-id="${image.id}" ${loraState.media.cover_media_path === image.media_path ? 'disabled' : ''}>设为封面</button><button type="button" data-action="move-lora-image-up" data-image-id="${image.id}" ${index === 0 ? 'disabled' : ''}>前移</button><button type="button" data-action="move-lora-image-down" data-image-id="${image.id}" ${index === loraState.media.images.length - 1 ? 'disabled' : ''}>后移</button><button type="button" class="danger-button" data-action="delete-lora-image" data-image-id="${image.id}">删除</button></div></article>`; }).join('');
  const remaining = 3 - window.items.length;
  grid.innerHTML = `${cards}${imageManagerEmptySlots(remaining, 'choose-lora-images', window.total)}`;
  installModelImageFailureHandlers();
}
function renderLoraImagePreview() {
  const images = loraState.media?.images ?? [];
  if (images.length === 0) return;
  loraState.previewIndex = ((loraState.previewIndex % images.length) + images.length) % images.length;
  const image = images[loraState.previewIndex];
  lora$('#lora-image-preview-image').src = loraMediaSource(image);
  lora$('#lora-image-preview-image').alt = `LoRA 资源原图 ${loraState.previewIndex + 1}`;
  lora$('#lora-image-preview-count').textContent = `图片 ${loraState.previewIndex + 1} / ${images.length}`;
  for (const action of ['previous-lora-preview', 'next-lora-preview']) lora$(`[data-action="${action}"]`).disabled = images.length <= 1;
}
function openLoraImageManager(trigger) { loraState.managerTrigger = trigger; loraState.managerPage = loraState.mediaPage; renderLoraImageManager(); loraOpen(lora$('#lora-image-manager')); lora$('[data-action="close-lora-image-manager"]').focus(); }
function closeLoraImageManager() { const dialog = lora$('#lora-image-manager'); if (dialog) loraClose(dialog); loraState.managerTrigger?.focus?.(); loraState.managerTrigger = null; }
function openLoraImagePreview(index, trigger) { loraState.previewTrigger = trigger; loraState.previewIndex = index; renderLoraImagePreview(); loraOpen(lora$('#lora-image-preview')); lora$('[data-action="close-lora-image-preview"]').focus(); }
function closeLoraImagePreview() { const dialog = lora$('#lora-image-preview'); if (dialog) loraClose(dialog); loraState.previewTrigger?.focus?.(); loraState.previewTrigger = null; }
function updateLoraCardCover() {
  if (loraState.editing === null || !loraState.media) return;
  const item = loraState.items.find((candidate) => candidate.id === loraState.editing);
  if (!item) return;
  item.cover_media_path = loraState.media.cover_media_path;
  renderLoraList();
}
async function loadLoraMedia(id, generation) {
  const snapshot = await loraApi(`/items/lora/${id}/images`);
  if (generation !== loraState.editorGeneration || loraState.editing !== id || !lora$('#lora-editor').open) return false;
  loraState.media = snapshot;
  lora$('#lora-media-section').hidden = false;
  renderLoraMedia();
  updateLoraCardCover();
  return true;
}
async function openLoraEditor(id = null, trigger = null) {
  const generation = ++loraState.editorGeneration;
  rememberLoraEditorTrigger(trigger);
  loraState.editing = id;
  loraError();
  resetLoraForm();
  setLoraEditorMode(id);
  loraOpen(lora$('#lora-editor'));
  setLoraEditorLoading(true);
  try {
    const [, , item] = await Promise.all([
      loadLoraBaseOptions(),
      loadLoraModelOptions(),
      id === null ? Promise.resolve(null) : loraApi(`/manage/loras/${id}`)
    ]);
    if (generation !== loraState.editorGeneration || loraState.editing !== id || !lora$('#lora-editor').open) return;
    if (item !== null) {
      await loadLoraBaseOptions(item.base_model_id);
      await loadLoraModelOptions(item.base_model_id, item.model_id);
      if (generation !== loraState.editorGeneration || loraState.editing !== id || !lora$('#lora-editor').open) return;
      populateLoraForm(item);
      setLoraEditorMode(id, item);
      await loadLoraMedia(id, generation);
    }
    setLoraEditorLoading(false);
  } catch (error) {
    if (generation !== loraState.editorGeneration || !lora$('#lora-editor').open) return;
    loraError(loraFriendlyError(id === null ? '读取底模和模型选项' : '读取 LoRA 详情', error));
    setLoraEditorLoading(false);
  }
}
function closeLoraEditor() {
  loraState.editorGeneration += 1;
  loraState.editing = null;
  loraState.media = null;
  closeLoraImagePreview();
  closeLoraImageManager();
  pendingLoraMedia.clear();
  loraClose(lora$('#lora-editor'));
}
async function uploadPendingLoraMedia(id) {
  if (pendingLoraMedia.size === 0) return true;
  const form = new FormData(); pendingLoraMedia.files().forEach((file) => form.append('files', file));
  try {
    const coverIndex = pendingLoraMedia.coverIndex();
    let snapshot = await loraApi(`/items/lora/${id}/images`, { method: 'POST', body: form });
    pendingLoraMedia.clear();
    const cover = snapshot.images[coverIndex];
    if (cover) {
      try { snapshot = await loraApi(`/items/lora/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: cover.id }) }); }
      catch (error) { loraState.media = snapshot; loraError(`LoRA #${id} 已创建且图片已上传，但设置封面失败。${loraFriendlyError('设置封面', error)}`); return false; }
    }
    loraState.media = snapshot; lora$('#lora-media-section').hidden = false; renderLoraMedia(); return true;
  } catch (error) { loraError(`LoRA #${id} 已创建，但图片上传失败。${loraFriendlyError('上传图片', error)}`); return false; }
}
async function saveLoraEditor() {
  const generation = loraState.editorGeneration;
  const id = loraState.editing;
  let write;
  try {
    write = loraWriteFromForm();
  } catch (error) {
    loraError(error.message);
    return;
  }
  if (loraState.editorLoading || !loraStartPending('save', generation)) return;
  setLoraEditorLoading(true);
  loraError();
  try {
    const record = id === null
      ? await loraApi('/manage/loras', { method: 'POST', body: JSON.stringify(write) })
      : await loraApi(`/manage/loras/${id}`, { method: 'PUT', body: JSON.stringify(write) });
    if (generation !== loraState.editorGeneration || loraState.editing !== id || !lora$('#lora-editor').open) return;
    if (id === null) {
      loraState.editing = record.id;
      setLoraEditorMode(record.id, record);
      if (pendingLoraMedia.size > 0) await uploadPendingLoraMedia(record.id);
      else await loadLoraMedia(record.id, generation);
    } else if (pendingLoraMedia.size > 0) {
      await uploadPendingLoraMedia(record.id);
    }
    await loadLoras(id === null ? 1 : loraState.page);
  } catch (error) {
    if (generation === loraState.editorGeneration && lora$('#lora-editor').open) loraError(loraFriendlyError('保存 LoRA', error));
  } finally {
    if (generation === loraState.editorGeneration && lora$('#lora-editor').open) setLoraEditorLoading(false);
    loraFinishPending('save', generation);
  }
}
function setLoraMediaPending(pending) {
  lora$('#lora-media-section').querySelectorAll('input, button').forEach((element) => { element.disabled = pending; });
  lora$('#lora-image-manager')?.querySelectorAll('button').forEach((element) => { element.disabled = pending; });
}
function validateLoraImageFiles(files) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (files.length > 10) throw new Error('每批最多添加 10 张图片。');
  for (const file of files) {
    if (!allowed.has(file.type)) throw new Error(`文件“${file.name}”不是 JPEG、PNG 或 WebP 图片。`);
    if (file.size > 10 * 1024 * 1024) throw new Error(`文件“${file.name}”超过 10 MiB。`);
  }
}
async function uploadLoraImages() {
  const id = loraState.editing;
  const files = [...lora$('#lora-image-upload').files];
  if (files.length === 0) return;
  try { validateLoraImageFiles(files); } catch (error) { loraError(error.message); return; }
  if (id === null || pendingLoraMedia.size > 0) {
    pendingLoraMedia.add(files); loraState.media = pendingLoraMedia.snapshot(); loraState.managerPage = Math.max(0, Math.ceil(loraState.media.images.length / 3) - 1);
    lora$('#lora-image-upload').value = ''; lora$('#lora-media-status').textContent = `已选择 ${files.length} 张图片，创建 LoRA 后上传。`; renderLoraMedia(); return;
  }
  if (!loraStartPending('upload-images', id)) return;
  setLoraMediaPending(true);
  loraError();
  try {
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    const snapshot = await loraApi(`/items/lora/${id}/images`, { method: 'POST', body: form });
    if (loraState.editing !== id || !lora$('#lora-editor').open) return;
    loraState.media = snapshot;
    loraState.managerPage = Math.max(0, Math.ceil(snapshot.images.length / 3) - 1);
    lora$('#lora-image-upload').value = '';
    lora$('#lora-media-status').textContent = `已上传 ${files.length} 张图片。`;
    renderLoraMedia();
    updateLoraCardCover();
  } catch (error) {
    if (loraState.editing === id && lora$('#lora-editor').open) loraError(loraFriendlyError('上传', error));
  } finally {
    if (loraState.editing === id && lora$('#lora-editor').open) setLoraMediaPending(false);
    loraFinishPending('upload-images', id);
  }
}
async function replaceLoraCover() {
  const id = loraState.editing;
  const input = lora$('#lora-cover-upload');
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try { validateLoraImageFiles([file]); } catch (error) { loraError(error.message); return; }
  if (id === null || pendingLoraMedia.size > 0) {
    pendingLoraMedia.add([file], { selectLastAsCover: true }); loraState.media = pendingLoraMedia.snapshot(); lora$('#lora-media-status').textContent = '已选择待上传封面，创建 LoRA 后上传。'; renderLoraMedia(); return;
  }
  if (!loraStartPending('replace-cover', id)) return;
  setLoraMediaPending(true);
  loraError();
  const existingIds = new Set(loraState.media?.images.map((image) => image.id) ?? []);
  try {
    const form = new FormData(); form.append('files', file);
    const uploaded = await loraApi(`/items/lora/${id}/images`, { method: 'POST', body: form });
    if (loraState.editing !== id || !lora$('#lora-editor').open) return;
    loraState.media = uploaded;
    const added = uploaded.images.find((image) => !existingIds.has(image.id));
    renderLoraMedia();
    if (!added) throw new Error('已上传图片，但无法识别新图片记录。');
    try {
      loraState.media = await loraApi(`/items/lora/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: added.id }) });
      lora$('#lora-media-status').textContent = '已更换封面。';
      renderLoraMedia(); updateLoraCardCover();
    } catch (error) { loraError(`图片已上传，但设置封面失败。${loraFriendlyError('设置封面', error)}`); }
  } catch (error) {
    if (loraState.editing === id && lora$('#lora-editor').open) loraError(loraFriendlyError('上传封面', error));
  } finally {
    if (loraState.editing === id && lora$('#lora-editor').open) setLoraMediaPending(false);
    loraFinishPending('replace-cover', id);
  }
}
async function reorderLoraImage(imageId, delta) {
  const id = loraState.editing;
  const media = loraState.media;
  if (pendingLoraMedia.has(imageId)) {
    const nextIndex = pendingLoraMedia.move(imageId, delta); if (nextIndex < 0) return;
    loraState.media = pendingLoraMedia.snapshot(); loraState.managerPage = Math.floor(nextIndex / 3); renderLoraMedia(); return;
  }
  if (id === null || !media || !loraStartPending('reorder-images', id)) return;
  const index = media.images.findIndex((image) => image.id === imageId);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= media.images.length) { loraFinishPending('reorder-images', id); return; }
  setLoraMediaPending(true);
  loraError();
  const ids = media.images.map((image) => image.id);
  [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
  try {
    const snapshot = await loraApi(`/items/lora/${id}/images/order`, { method: 'PUT', body: JSON.stringify({ ids }) });
    if (loraState.editing !== id || !lora$('#lora-editor').open) return;
    loraState.media = snapshot;
    loraState.managerPage = Math.floor(nextIndex / 3);
    renderLoraMedia();
    updateLoraCardCover();
  } catch (error) {
    if (loraState.editing === id && lora$('#lora-editor').open) loraError(loraFriendlyError('调整图片顺序', error));
  } finally {
    if (loraState.editing === id && lora$('#lora-editor').open) setLoraMediaPending(false);
    loraFinishPending('reorder-images', id);
  }
}
async function setLoraCover(imageId) {
  const id = loraState.editing;
  if (pendingLoraMedia.has(imageId)) { pendingLoraMedia.setCover(imageId); loraState.media = pendingLoraMedia.snapshot(); renderLoraMedia(); return; }
  if (id === null || !loraStartPending('set-cover', id)) return;
  setLoraMediaPending(true);
  loraError();
  try {
    const snapshot = await loraApi(`/items/lora/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: imageId }) });
    if (loraState.editing !== id || !lora$('#lora-editor').open) return;
    loraState.media = snapshot;
    renderLoraMedia();
    updateLoraCardCover();
  } catch (error) {
    if (loraState.editing === id && lora$('#lora-editor').open) loraError(loraFriendlyError('设置封面', error));
  } finally {
    if (loraState.editing === id && lora$('#lora-editor').open) setLoraMediaPending(false);
    loraFinishPending('set-cover', id);
  }
}
function openLoraImageDelete(imageId) {
  const image = loraState.media?.images.find((candidate) => candidate.id === imageId);
  const ownerLoraId = loraState.editing;
  if (!image || (ownerLoraId === null && !pendingLoraMedia.has(imageId))) return;
  loraState.imageDeleteGeneration += 1;
  loraState.imageDeleting = image;
  loraState.imageDeleteTarget = Object.freeze({ ownerLoraId, imageId: image.id });
  lora$('#lora-image-delete-target').textContent = `将删除图片“${image.media_path}”。`;
  lora$('#lora-image-delete [data-action="confirm-lora-image-delete"]').disabled = false;
  loraOpen(lora$('#lora-image-delete'));
}
function closeLoraImageDelete() {
  loraState.imageDeleteGeneration += 1;
  loraState.imageDeleteTarget = null;
  loraState.imageDeleting = null;
  lora$('#lora-image-delete [data-action="confirm-lora-image-delete"]').disabled = false;
  loraClose(lora$('#lora-image-delete'));
}
async function confirmLoraImageDelete() {
  const ownerLoraId = loraState.editing;
  const image = loraState.imageDeleting;
  const imageId = image?.id;
  const generation = loraState.imageDeleteGeneration;
  const editorGeneration = loraState.editorGeneration;
  const target = loraState.imageDeleteTarget;
  const dialog = lora$('#lora-image-delete');
  if (image && pendingLoraMedia.has(imageId)) {
    pendingLoraMedia.remove(imageId); loraState.media = pendingLoraMedia.snapshot(); loraState.managerPage = mediaWindow(loraState.media.images, loraState.managerPage).page;
    closeLoraImageDelete(); renderLoraMedia(); return;
  }
  if (ownerLoraId === null || !image || target?.ownerLoraId !== ownerLoraId || target.imageId !== imageId || !loraStartPending('delete-image', imageId)) return;
  const requestToken = ++loraState.imageDeleteRequestToken;
  const button = dialog.querySelector('[data-action="confirm-lora-image-delete"]');
  const isCurrentRequest = () => requestToken === loraState.imageDeleteRequestToken
    && generation === loraState.imageDeleteGeneration && editorGeneration === loraState.editorGeneration
    && loraState.editing === ownerLoraId && loraState.imageDeleting === image && loraState.imageDeleteTarget === target
    && target.ownerLoraId === ownerLoraId && target.imageId === imageId && lora$('#lora-editor').open && dialog.open;
  button.disabled = true;
  try {
    const snapshot = await loraApi(`/items/lora/${ownerLoraId}/images/${imageId}`, { method: 'DELETE' });
    if (!isCurrentRequest()) return;
    loraState.media = snapshot;
    loraState.managerPage = mediaWindow(snapshot.images, loraState.managerPage).page;
    closeLoraImageDelete();
    renderLoraMedia();
    updateLoraCardCover();
  } catch (error) {
    if (isCurrentRequest()) loraError(loraFriendlyError('删除图片', error));
  } finally {
    loraFinishPending('delete-image', imageId);
    if (isCurrentRequest()) button.disabled = false;
  }
}
function loraImpactItem(item) {
  const label = ({ model: '模型', lora: 'LoRA', template: '模板', image: '图片', artist_prompt_string: '画师串' }[item.kind] ?? item.kind);
  return `<li>${label}：${escapeHtml(item.name ?? item.media_path ?? `#${item.id}`)}</li>`;
}
async function openLoraDelete(id) {
  const generation = ++loraState.deleteGeneration;
  const dialog = lora$('#lora-delete');
  loraState.deleting = null;
  showError(dialog.querySelector('#lora-delete-error'));
  dialog.querySelector('#lora-delete-target').textContent = '正在读取 LoRA 删除影响预览……';
  dialog.querySelector('#lora-cascade-list').innerHTML = '<li>正在读取影响预览……</li>';
  dialog.querySelector('#lora-retained-list').innerHTML = '';
  dialog.querySelector('[data-action="confirm-lora-delete"]').disabled = true;
  loraOpen(dialog);
  try {
    const impact = await loraApi(`/manage/loras/${id}/delete-impact`);
    if (generation !== loraState.deleteGeneration || !dialog.open) return;
    loraState.deleting = impact;
    dialog.querySelector('#lora-delete-target').textContent = `将删除 LoRA“${impact.target.name}”。`;
    dialog.querySelector('#lora-cascade-list').innerHTML = impact.cascade_deleted.length ? impact.cascade_deleted.map(loraImpactItem).join('') : '<li>没有需要级联删除的对象。</li>';
    dialog.querySelector('#lora-retained-list').innerHTML = impact.retained.length ? impact.retained.map(loraImpactItem).join('') : '<li>没有需要解除关联的对象。</li>';
  } catch (error) {
    if (generation === loraState.deleteGeneration && dialog.open) showError(dialog.querySelector('#lora-delete-error'), loraFriendlyError('读取删除影响预览', error));
  } finally {
    if (generation !== loraState.deleteGeneration || !dialog.open) return;
    dialog.querySelector('[data-action="confirm-lora-delete"]').disabled = loraState.deleting === null;
  }
}
function closeLoraDelete() {
  loraState.deleteGeneration += 1;
  loraState.deleting = null;
  loraClose(lora$('#lora-delete'));
}
async function confirmLoraDelete() {
  const impact = loraState.deleting;
  const targetId = impact?.target?.id;
  const generation = loraState.deleteGeneration;
  if (!impact || !loraStartPending('delete-lora', targetId)) return;
  const requestToken = ++loraState.deleteRequestToken;
  const dialog = lora$('#lora-delete');
  const button = dialog.querySelector('[data-action="confirm-lora-delete"]');
  const isCurrentRequest = () => requestToken === loraState.deleteRequestToken && generation === loraState.deleteGeneration
    && loraState.deleting === impact && loraState.deleting?.target?.id === targetId && dialog.open;
  button.disabled = true;
  try {
    const result = await loraApi(`/manage/loras/${targetId}`, { method: 'DELETE', body: JSON.stringify({ impact_token: impact.impact_token }) });
    await loadLoras(loraState.page, { fallbackToLastPage: true });
    if (!isCurrentRequest()) return;
    closeLoraDelete();
    if (result.cleanup_warning) showError(lora$('#lora-error'), 'LoRA 记录已删除，但部分资源图片文件等待后续清理。');
  } catch (error) {
    if (!isCurrentRequest()) return;
    if (error?.code === 'DELETE_IMPACT_STALE') {
      showError(dialog.querySelector('#lora-delete-error'), '影响预览已过期，正在重新读取。请确认新的删除范围。');
      await openLoraDelete(targetId);
    } else {
      showError(dialog.querySelector('#lora-delete-error'), loraFriendlyError('删除 LoRA', error));
    }
  } finally {
    loraFinishPending('delete-lora', targetId);
    if (isCurrentRequest()) button.disabled = loraState.deleting === null;
  }
}

const loraSearch = lora$('#lora-search');
if (loraSearch) {
  bindManagementFilterForm({
    config: PAGE_CONFIG,
    form: lora$('#lora-filter-form'),
    keyword: loraSearch,
    onApply() {
      loraState.query = loraSearch.value;
      loraState.baseModelId = lora$('#lora-filter-base-model').value;
      loraState.modelId = lora$('#lora-filter-model').value;
      loraState.fileFormat = lora$('#lora-filter-file-format').value.trim();
      loraState.precision = lora$('#lora-filter-precision').value.trim();
      return loadLoras(1);
    },
    onReset() {
      Object.assign(loraState, { query: '', baseModelId: '', modelId: '', fileFormat: '', precision: '' });
      void loadLoraFilterOptions();
      return loadLoras(1);
    }
  });
  lora$('#lora-filter-base-model').addEventListener('change', async (event) => {
    lora$('#lora-filter-model').value = '';
    await loadLoraFilterOptions(event.target.value);
  });
  loraField('base_model_id').addEventListener('change', () => {
  const selectedBaseModelId = loraField('base_model_id').value;
  void loadLoraModelOptions(selectedBaseModelId).catch((error) => loraError(loraFriendlyError('读取关联模型选项', error)));
  });
  lora$('#lora-form').addEventListener('submit', (event) => { event.preventDefault(); void saveLoraEditor(); });
  lora$('#lora-cover-upload')?.addEventListener('change', () => { void replaceLoraCover(); });
  lora$('#lora-image-upload').addEventListener('change', () => { void uploadLoraImages(); });
  document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const id = Number(target.dataset.id);
  const imageId = target.dataset.imageId?.startsWith('pending-') ? target.dataset.imageId : Number(target.dataset.imageId);
  const imageIndex = Number(target.dataset.imageIndex);
  if (target.dataset.action === 'choose-lora-cover') lora$('#lora-cover-upload').click();
  if (target.dataset.action === 'choose-lora-images') lora$('#lora-image-upload').click();
  if (target.dataset.action === 'open-lora-image-manager') openLoraImageManager(target);
  if (target.dataset.action === 'close-lora-image-manager') closeLoraImageManager();
  if (target.dataset.action === 'previous-lora-image-group') { loraState.managerPage -= 1; renderLoraImageManager(); }
  if (target.dataset.action === 'next-lora-image-group') { loraState.managerPage += 1; renderLoraImageManager(); }
  if (target.dataset.action === 'previous-lora-media-group') { loraState.mediaPage -= 1; renderLoraMedia(); }
  if (target.dataset.action === 'next-lora-media-group') { loraState.mediaPage += 1; renderLoraMedia(); }
  if (target.dataset.action === 'open-lora-image-preview') openLoraImagePreview(imageIndex, target);
  if (target.dataset.action === 'close-lora-image-preview') closeLoraImagePreview();
  if (target.dataset.action === 'previous-lora-preview') { loraState.previewIndex -= 1; renderLoraImagePreview(); }
  if (target.dataset.action === 'next-lora-preview') { loraState.previewIndex += 1; renderLoraImagePreview(); }
  if (target.dataset.action === 'open-lora-create') void openLoraEditor(null, target);
  if (target.dataset.action === 'open-lora-detail') void openLoraEditor(id, target);
  if (target.dataset.action === 'close-lora-editor') closeLoraEditor();
  if (target.dataset.action === 'cancel-lora-editor') closeLoraEditor();
  if (target.dataset.action === 'upload-lora-images') void uploadLoraImages();
  if (target.dataset.action === 'move-lora-image-up') void reorderLoraImage(imageId, -1);
  if (target.dataset.action === 'move-lora-image-down') void reorderLoraImage(imageId, 1);
  if (target.dataset.action === 'set-lora-cover') void setLoraCover(imageId);
  if (target.dataset.action === 'delete-lora-image') openLoraImageDelete(imageId);
  if (target.dataset.action === 'close-lora-image-delete') closeLoraImageDelete();
  if (target.dataset.action === 'confirm-lora-image-delete') void confirmLoraImageDelete();
  if (target.dataset.action === 'open-lora-delete') void openLoraDelete(id);
  if (target.dataset.action === 'close-lora-delete') closeLoraDelete();
  if (target.dataset.action === 'confirm-lora-delete') void confirmLoraDelete();
  if (target.dataset.action === 'previous-lora-page') void loadLoras(loraState.page - 1);
  if (target.dataset.action === 'next-lora-page') void loadLoras(loraState.page + 1);
  if (target.dataset.action === 'go-lora-page') void loadLoras(Number(target.dataset.page));
  });
  document.addEventListener('keydown', (event) => {
    if (!lora$('#lora-image-preview')?.open) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); loraState.previewIndex -= 1; renderLoraImagePreview(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); loraState.previewIndex += 1; renderLoraImagePreview(); }
    if (event.key === 'Escape') { event.preventDefault(); closeLoraImagePreview(); }
  });

  renderLoraList();
  void loadLoraFilterOptions();
  void loadLoras();
}
