import { createEditableCombobox, createPendingMediaCollection, escapeHtml, friendlyManagementError, http, imageManagerEmptySlots, installModelImageFailureHandlers, managementListReadyStatus, mediaRangeLabel, mediaWindow, paginationTools, renderManagementListStatus, showError, urls } from './generation-resource-shared.js';
import { MANAGEMENT_LIST_PAGE_CONFIG } from './management-list-page-config.mjs';
import { bindManagementFilterForm } from './management-list-layout.js';

const PAGE_CONFIG = MANAGEMENT_LIST_PAGE_CONFIG.models;
const modelState = {
  items: [], page: 1, totalCount: 0, totalPages: 1, query: '', baseModelId: '', fileFormat: '', precision: '', listView: 'loading', loading: false,
  editing: null, editorGeneration: 0, editorLoading: false, media: null, deleting: null, imageDeleting: null,
  runtimeTestInstances: [], runtimeTestResult: null,
  workflowManagement: null, repairPreview: null, activePanel: 'basic',
  listGeneration: 0, deleteGeneration: 0, deleteRequestToken: 0, imageDeleteGeneration: 0, imageDeleteRequestToken: 0,
  imageDeleteTarget: null, pending: new Set(), mediaPage: 0, managerPage: 0, previewIndex: 0, managerTrigger: null, previewTrigger: null
};

const model$ = (selector) => document.querySelector(selector);
const modelRequestId = () => `generation-model-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const modelField = (name) => model$('#model-form').elements.namedItem(name);
const modelPendingKey = (action, target = '') => `${action}:${target}`;
const modelFileFormatComboboxes = [
  createEditableCombobox({ input: model$('#model-filter-file-format'), listbox: model$('#model-filter-file-format-listbox') }),
  createEditableCombobox({ input: model$('#model-file-format'), listbox: model$('#model-file-format-listbox') })
];
const modelPrecisionComboboxes = [
  createEditableCombobox({ input: model$('#model-filter-precision'), listbox: model$('#model-filter-precision-listbox') }),
  createEditableCombobox({ input: model$('#model-precision'), listbox: model$('#model-precision-listbox') })
];
const pendingModelMedia = createPendingMediaCollection();

function modelOpen(dialog) { if (!dialog.open) dialog.showModal(); }
function modelClose(dialog) { if (dialog.open) dialog.close(); }
function modelError(message = '') { showError(model$('#model-editor-error'), message); }
function modelStatus(message, busy = false) {
  renderManagementListStatus(model$('#model-status'), message, busy);
}
function modelStartPending(action, target = '') {
  const key = modelPendingKey(action, target);
  if (modelState.pending.has(key)) return false;
  modelState.pending.add(key);
  return true;
}
function modelFinishPending(action, target = '') { modelState.pending.delete(modelPendingKey(action, target)); }
function modelOptional(value) {
  const text = String(value ?? '').trim();
  return text.length === 0 ? null : text;
}
function modelFriendlyError(action, error) {
  if (error?.code === 'DUPLICATE_RESOURCE') return `${action}失败：模型已存在，请修改文件名或底模后重试。`;
  if (error?.code === 'RELATION_CONFLICT') return `${action}失败：所选底模不存在或关联已变化，请刷新后重试。`;
  if (error?.code === 'UPLOAD_TYPE_UNSUPPORTED') return `${action}失败：请选择有效的 JPEG、PNG 或 WebP 图片。`;
  if (error?.code === 'WRITE_FORBIDDEN') return `${action}失败：当前应用不允许写入，请检查应用的写入权限后重试。`;
  if (error?.code === 'DATABASE_BUSY') return `${action}暂时无法完成：数据库繁忙，请稍后重试。`;
  return friendlyManagementError(action, error);
}

async function modelApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-request-id', modelRequestId());
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return await http.requestJson({ path: urls.api(path), options: { ...options, headers }, requestId: headers.get('x-request-id'), timeoutMs: http.DEFAULT_TIMEOUT_MS });
}

function modelImageMarkup(mediaPath, label) {
  if (!mediaPath) return '<div class="card-cover image-placeholder"><span>暂无封面</span></div>';
  return `<div class="card-cover image-frame"><img src="${escapeHtml(urls.media(mediaPath))}" alt="${escapeHtml(label)}" data-media-image><span class="image-placeholder-label">图片加载失败</span></div>`;
}
function modelMediaSource(image) { return image.local_url ?? urls.media(image.media_path); }
function renderModelList() {
  const list = model$('#model-list');
  list.innerHTML = modelState.listView === 'loading'
    ? '<div class="base-model-skeleton" aria-busy="true" aria-label="正在载入模型列表"><span></span><span></span><span></span></div>'
    : modelState.listView === 'error'
      ? '<p class="state-line error">模型列表读取失败。</p>'
      : modelState.items.length === 0
        ? '<p class="state-line">暂无匹配模型。</p>'
        : modelState.items.map((item) => `<article class="manage-card" data-id="${item.id}">
          <header><span class="type-tag">模型</span></header>
          ${modelImageMarkup(item.cover_media_path, `${item.file_name}封面`)}
          <strong class="card-name">${escapeHtml(item.file_name)}</strong>
          <span class="card-summary">${escapeHtml(item.description || '暂无模型说明')}</span>
          <div class="card-footer"><span class="card-footer-tag">${escapeHtml(item.base_model_name)}</span><span>${escapeHtml(item.file_format)} · ${escapeHtml(item.precision_or_quantization)}</span></div>
          <div class="manage-actions"><button class="secondary-button" data-action="open-model-detail" data-id="${item.id}">编辑</button></div>
        </article>`).join('');
  const pagination = model$('#model-pagination');
  pagination.innerHTML = paginationTools.renderControls({ page: modelState.page, totalPages: modelState.totalPages, totalCount: modelState.totalCount, loading: modelState.loading, previousAction: 'previous-model-page', nextAction: 'next-model-page', pageAction: 'go-model-page' });
  installModelImageFailureHandlers();
}

const modelPagination = paginationTools.createListController({
  state: modelState,
  fetchPage: async (page) => {
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_CONFIG.pageSize), q: modelState.query });
    if (modelState.baseModelId !== '') query.set('base_model_id', modelState.baseModelId);
    if (modelState.fileFormat !== '') query.set('file_format', modelState.fileFormat);
    if (modelState.precision !== '') query.set('precision_or_quantization', modelState.precision);
    return modelApi(`/manage/models?${query}`);
  },
  render: renderModelList,
  setStatus: modelStatus,
  setError: (message) => showError(model$('#model-error'), message),
  loadingMessage: '正在载入模型……',
  emptyMessage: '暂无模型。',
  readyMessage: (response) => managementListReadyStatus(response, PAGE_CONFIG.pageSize),
  failureMessage: '模型列表读取失败。',
  errorMessage: (error) => friendlyManagementError('读取模型列表', error)
});

function loadModels(page = 1, options = {}) { return modelPagination.load(page, options); }

async function loadModelBaseOptions(selectedId = null) {
  const data = await modelApi('/manage/base-models?page=1&page_size=100&q=');
  const select = modelField('base_model_id');
  select.innerHTML = `<option value="">请选择底模</option>${data.items.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
  if (selectedId !== null) select.value = String(selectedId);
}
async function loadModelListOptions() {
  const [bases, options] = await Promise.all([
    modelApi('/manage/base-models?page=1&page_size=100&q='),
    modelApi('/manage/generation-resource-options')
  ]);
  model$('#model-filter-base-model').innerHTML = `<option value="">全部底模</option>${bases.items.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
  modelFileFormatComboboxes.forEach((combobox) => combobox.setSuggestions(options.file_format_suggestions));
  modelPrecisionComboboxes.forEach((combobox) => combobox.setSuggestions(options.precision_or_quantization_suggestions));
}
function setModelEditorLoading(loading) {
  modelState.editorLoading = loading;
  model$('#model-form').querySelectorAll('input, select, textarea, button').forEach((element) => { element.disabled = loading; });
  model$('#model-editor-submit').disabled = loading;
}
function setModelEditorMode(id, record = null) {
  const editing = id !== null;
  model$('#model-editor-title').textContent = editing ? '编辑模型' : '新增模型';
  model$('#model-editor-subtitle').textContent = editing ? (record?.file_name ?? `#${id}`) : '';
  model$('#model-editor-delete').hidden = !editing;
  model$('#model-editor-delete').dataset.id = editing ? String(id) : '';
  model$('#model-editor-submit').textContent = editing ? '保存更改' : '创建模型';
}
function resetModelForm() {
  model$('#model-form').reset();
  [...modelFileFormatComboboxes, ...modelPrecisionComboboxes].forEach((combobox) => combobox.close());
  pendingModelMedia.clear();
  modelField('base_model_id').innerHTML = '<option value="">正在读取底模……</option>';
  model$('#model-media-section').hidden = modelState.editing !== null;
  model$('#model-image-list').innerHTML = '';
  model$('#model-media-status').textContent = '';
  model$('#model-image-upload').value = '';
  modelState.media = modelState.editing === null ? pendingModelMedia.snapshot() : null;
  Object.assign(modelState, { mediaPage: 0, managerPage: 0, previewIndex: 0 });
  if (modelState.media) renderModelMedia();
}
function modelWriteFromForm() {
  return Object.freeze({
    base_model_id: Number(modelField('base_model_id').value),
    file_name: modelField('file_name').value.trim(),
    file_format: modelField('file_format').value,
    precision_or_quantization: modelField('precision_or_quantization').value,
    author: modelOptional(modelField('author').value),
    version: modelOptional(modelField('version').value),
    release_url: modelOptional(modelField('release_url').value),
    published_at: modelOptional(modelField('published_at').value),
    description: modelField('description').value.trim(),
    usage: modelField('usage').value.trim(),
    skill_name: modelOptional(modelField('skill_name').value)
  });
}
function populateModelForm(item) {
  for (const name of ['base_model_id', 'file_name', 'file_format', 'precision_or_quantization', 'author', 'version', 'release_url', 'published_at', 'description', 'usage', 'skill_name']) {
    const field = modelField(name);
    field.value = item[name] ?? '';
  }
}
function renderModelMedia() {
  const list = model$('#model-image-list');
  const media = modelState.media;
  if (!media) { list.innerHTML = '<p class="detail-loading">正在读取资源图片……</p>'; return; }
  const coverIndex = media.images.findIndex((image) => image.media_path === media.cover_media_path);
  const window = mediaWindow(media.images, modelState.mediaPage);
  modelState.mediaPage = window.page;
  const cover = coverIndex < 0 ? '<div class="editor-cover image-placeholder"><span>暂无封面</span></div>' : `<button type="button" class="editor-cover image-frame" data-action="open-model-image-preview" data-image-index="${coverIndex}" aria-label="查看模型封面原图"><img src="${escapeHtml(modelMediaSource(media.images[coverIndex]))}" alt="模型封面" data-media-image><span class="image-placeholder-label">图片加载失败</span></button>`;
  const thumbnails = window.items.map((image, offset) => `<button type="button" class="editor-media-thumbnail${media.cover_media_path === image.media_path ? ' is-cover' : ''}" data-action="open-model-image-preview" data-image-index="${window.start + offset}" aria-label="查看模型资源图片 ${window.start + offset + 1} 原图"><img src="${escapeHtml(modelMediaSource(image))}" alt="模型资源图片 ${window.start + offset + 1}" data-media-image></button>`).join('');
  list.innerHTML = `${cover}<div class="editor-media-pager"><span>${mediaRangeLabel(window)}</span><button type="button" data-action="previous-model-media-group" aria-label="显示前 3 张图片" ${window.page === 0 ? 'disabled' : ''}>←</button><button type="button" data-action="next-model-media-group" aria-label="显示后 3 张图片" ${window.page >= window.totalPages - 1 ? 'disabled' : ''}>→</button></div><div class="editor-media-thumbnails">${thumbnails || '<span class="detail-empty">暂无资源图片</span>'}</div>`;
  renderModelImageManager();
  if (model$('#model-image-preview')?.open) renderModelImagePreview();
  installModelImageFailureHandlers();
}
function renderModelImageManager() {
  const grid = model$('#model-image-manager-grid');
  if (!grid || !modelState.media) return;
  const window = mediaWindow(modelState.media.images, modelState.managerPage);
  modelState.managerPage = window.page;
  model$('#model-image-manager-range').textContent = mediaRangeLabel(window);
  const previous = model$('[data-action="previous-model-image-group"]');
  const next = model$('[data-action="next-model-image-group"]');
  if (previous) previous.disabled = window.page === 0;
  if (next) next.disabled = window.page >= window.totalPages - 1;
  const cards = window.items.map((image, offset) => {
    const index = window.start + offset;
    return `<article class="image-manager-card${modelState.media.cover_media_path === image.media_path ? ' is-cover' : ''}"><button type="button" class="image-manager-preview" data-action="open-model-image-preview" data-image-index="${index}"><img src="${escapeHtml(modelMediaSource(image))}" alt="模型资源图片 ${index + 1}" data-media-image></button><strong>资源图片 ${index + 1}</strong><span>${modelState.media.cover_media_path === image.media_path ? '当前封面' : ''}</span><div class="image-manager-card-actions"><button type="button" data-action="set-model-cover" data-image-id="${image.id}" ${modelState.media.cover_media_path === image.media_path ? 'disabled' : ''}>设为封面</button><button type="button" data-action="move-model-image-up" data-image-id="${image.id}" ${index === 0 ? 'disabled' : ''}>前移</button><button type="button" data-action="move-model-image-down" data-image-id="${image.id}" ${index === modelState.media.images.length - 1 ? 'disabled' : ''}>后移</button><button type="button" class="danger-button" data-action="delete-model-image" data-image-id="${image.id}">删除</button></div></article>`;
  }).join('');
  const remaining = 3 - window.items.length;
  grid.innerHTML = `${cards}${imageManagerEmptySlots(remaining, 'choose-model-images', window.total)}`;
  installModelImageFailureHandlers();
}
function renderModelImagePreview() {
  const images = modelState.media?.images ?? [];
  if (images.length === 0) return;
  modelState.previewIndex = ((modelState.previewIndex % images.length) + images.length) % images.length;
  const image = images[modelState.previewIndex];
  model$('#model-image-preview-image').src = modelMediaSource(image);
  model$('#model-image-preview-image').alt = `模型资源原图 ${modelState.previewIndex + 1}`;
  model$('#model-image-preview-count').textContent = `图片 ${modelState.previewIndex + 1} / ${images.length}`;
  for (const action of ['previous-model-preview', 'next-model-preview']) model$(`[data-action="${action}"]`).disabled = images.length <= 1;
}
function openModelImageManager(trigger) { modelState.managerTrigger = trigger; modelState.managerPage = modelState.mediaPage; renderModelImageManager(); modelOpen(model$('#model-image-manager')); model$('[data-action="close-model-image-manager"]').focus(); }
function closeModelImageManager() { const dialog = model$('#model-image-manager'); if (dialog) modelClose(dialog); modelState.managerTrigger?.focus?.(); modelState.managerTrigger = null; }
function openModelImagePreview(index, trigger) { modelState.previewTrigger = trigger; modelState.previewIndex = index; renderModelImagePreview(); modelOpen(model$('#model-image-preview')); model$('[data-action="close-model-image-preview"]').focus(); }
function closeModelImagePreview() { const dialog = model$('#model-image-preview'); if (dialog) modelClose(dialog); modelState.previewTrigger?.focus?.(); modelState.previewTrigger = null; }
function updateModelCardCover() {
  if (modelState.editing === null || !modelState.media) return;
  const item = modelState.items.find((candidate) => candidate.id === modelState.editing);
  if (!item) return;
  item.cover_media_path = modelState.media.cover_media_path;
  renderModelList();
}
async function loadModelMedia(id, generation) {
  const snapshot = await modelApi(`/items/model/${id}/images`);
  if (generation !== modelState.editorGeneration || modelState.editing !== id || !model$('#model-editor').open) return false;
  modelState.media = snapshot;
  model$('#model-media-section').hidden = false;
  renderModelMedia();
  updateModelCardCover();
  return true;
}
async function openModelEditor(id = null) {
  const generation = ++modelState.editorGeneration;
  modelState.editing = id;
  modelError();
  resetModelForm();
  setModelEditorMode(id);
  modelOpen(model$('#model-editor'));
  setModelEditorLoading(true);
  try {
    const [baseModels, item] = await Promise.all([
      loadModelBaseOptions(id === null ? null : undefined),
      id === null ? Promise.resolve(null) : modelApi(`/manage/models/${id}`)
    ]);
    if (generation !== modelState.editorGeneration || modelState.editing !== id || !model$('#model-editor').open) return;
    if (item !== null) {
      if (modelField('base_model_id').value !== String(item.base_model_id)) await loadModelBaseOptions(item.base_model_id);
      populateModelForm(item);
      setModelEditorMode(id, item);
      await loadModelMedia(id, generation);
    }
    void baseModels;
    setModelEditorLoading(false);
  } catch (error) {
    if (generation !== modelState.editorGeneration || !model$('#model-editor').open) return;
    modelError(modelFriendlyError(id === null ? '读取底模' : '读取模型详情', error));
  }
}
function closeModelEditor() {
  modelState.editorGeneration += 1;
  modelState.editing = null;
  modelState.media = null;
  closeModelImagePreview();
  closeModelImageManager();
  pendingModelMedia.clear();
  modelClose(model$('#model-editor'));
}
async function uploadPendingModelMedia(id) {
  if (pendingModelMedia.size === 0) return true;
  const form = new FormData();
  pendingModelMedia.files().forEach((file) => form.append('files', file));
  try {
    const coverIndex = pendingModelMedia.coverIndex();
    let snapshot = await modelApi(`/items/model/${id}/images`, { method: 'POST', body: form });
    pendingModelMedia.clear();
    const cover = snapshot.images[coverIndex];
    if (cover) {
      try { snapshot = await modelApi(`/items/model/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: cover.id }) }); }
      catch (error) { modelState.media = snapshot; modelError(`模型 #${id} 已创建且图片已上传，但设置封面失败。${modelFriendlyError('设置封面', error)}`); return false; }
    }
    modelState.media = snapshot; model$('#model-media-section').hidden = false; renderModelMedia(); return true;
  } catch (error) {
    modelError(`模型 #${id} 已创建，但图片上传失败。${modelFriendlyError('上传图片', error)}`); return false;
  }
}
async function saveModelEditor() {
  const generation = modelState.editorGeneration;
  const id = modelState.editing;
  if (modelState.editorLoading || !modelStartPending('save', generation)) return;
  setModelEditorLoading(true);
  modelError();
  try {
    const record = id === null
      ? await modelApi('/manage/models', { method: 'POST', body: JSON.stringify(modelWriteFromForm()) })
      : await modelApi(`/manage/models/${id}`, { method: 'PUT', body: JSON.stringify(modelWriteFromForm()) });
    if (generation !== modelState.editorGeneration || modelState.editing !== id || !model$('#model-editor').open) return;
    if (id === null) {
      modelState.editing = record.id;
      setModelEditorMode(record.id, record);
      if (pendingModelMedia.size > 0) await uploadPendingModelMedia(record.id);
      else await loadModelMedia(record.id, generation);
    } else if (pendingModelMedia.size > 0) {
      await uploadPendingModelMedia(record.id);
    }
    await loadModels(id === null ? 1 : modelState.page);
  } catch (error) {
    if (generation === modelState.editorGeneration && model$('#model-editor').open) modelError(modelFriendlyError('保存模型', error));
  } finally {
    if (generation === modelState.editorGeneration && model$('#model-editor').open) setModelEditorLoading(false);
    modelFinishPending('save', generation);
  }
}
function setMediaPending(pending) {
  model$('#model-media-section').querySelectorAll('input, button').forEach((element) => { element.disabled = pending; });
  model$('#model-image-manager')?.querySelectorAll('button').forEach((element) => { element.disabled = pending; });
}
function validateModelImageFiles(files) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (files.length > 10) throw new Error('每批最多添加 10 张图片。');
  for (const file of files) {
    if (!allowed.has(file.type)) throw new Error(`文件“${file.name}”不是 JPEG、PNG 或 WebP 图片。`);
    if (file.size > 10 * 1024 * 1024) throw new Error(`文件“${file.name}”超过 10 MiB。`);
  }
}
async function uploadModelImages() {
  const id = modelState.editing;
  const files = [...model$('#model-image-upload').files];
  if (files.length === 0) return;
  try { validateModelImageFiles(files); } catch (error) { modelError(error.message); return; }
  if (id === null || pendingModelMedia.size > 0) {
    pendingModelMedia.add(files); modelState.media = pendingModelMedia.snapshot(); modelState.managerPage = Math.max(0, Math.ceil(modelState.media.images.length / 3) - 1);
    model$('#model-image-upload').value = ''; model$('#model-media-status').textContent = `已选择 ${files.length} 张图片，创建模型后上传。`; renderModelMedia(); return;
  }
  if (!modelStartPending('upload-images', id)) return;
  setMediaPending(true);
  modelError();
  try {
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    const snapshot = await modelApi(`/items/model/${id}/images`, { method: 'POST', body: form });
    if (modelState.editing !== id || !model$('#model-editor').open) return;
    modelState.media = snapshot;
    modelState.managerPage = Math.max(0, Math.ceil(snapshot.images.length / 3) - 1);
    model$('#model-image-upload').value = '';
    model$('#model-media-status').textContent = `已上传 ${files.length} 张图片。`;
    renderModelMedia();
    updateModelCardCover();
  } catch (error) {
    if (modelState.editing === id && model$('#model-editor').open) modelError(modelFriendlyError('上传', error));
  } finally {
    if (modelState.editing === id && model$('#model-editor').open) setMediaPending(false);
    modelFinishPending('upload-images', id);
  }
}
async function replaceModelCover() {
  const id = modelState.editing;
  const input = model$('#model-cover-upload');
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try { validateModelImageFiles([file]); } catch (error) { modelError(error.message); return; }
  if (id === null || pendingModelMedia.size > 0) {
    pendingModelMedia.add([file], { selectLastAsCover: true }); modelState.media = pendingModelMedia.snapshot(); model$('#model-media-status').textContent = '已选择待上传封面，创建模型后上传。'; renderModelMedia(); return;
  }
  if (!modelStartPending('replace-cover', id)) return;
  setMediaPending(true);
  modelError();
  const existingIds = new Set(modelState.media?.images.map((image) => image.id) ?? []);
  try {
    const form = new FormData();
    form.append('files', file);
    const uploaded = await modelApi(`/items/model/${id}/images`, { method: 'POST', body: form });
    if (modelState.editing !== id || !model$('#model-editor').open) return;
    modelState.media = uploaded;
    const added = uploaded.images.find((image) => !existingIds.has(image.id));
    renderModelMedia();
    if (!added) throw new Error('已上传图片，但无法识别新图片记录。');
    try {
      modelState.media = await modelApi(`/items/model/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: added.id }) });
      model$('#model-media-status').textContent = '已更换封面。';
      renderModelMedia();
      updateModelCardCover();
    } catch (error) {
      modelError(`图片已上传，但设置封面失败。${modelFriendlyError('设置封面', error)}`);
    }
  } catch (error) {
    if (modelState.editing === id && model$('#model-editor').open) modelError(modelFriendlyError('上传封面', error));
  } finally {
    if (modelState.editing === id && model$('#model-editor').open) setMediaPending(false);
    modelFinishPending('replace-cover', id);
  }
}
async function reorderModelImage(imageId, delta) {
  const id = modelState.editing;
  const media = modelState.media;
  if (pendingModelMedia.has(imageId)) {
    const nextIndex = pendingModelMedia.move(imageId, delta); if (nextIndex < 0) return;
    modelState.media = pendingModelMedia.snapshot(); modelState.managerPage = Math.floor(nextIndex / 3); renderModelMedia(); return;
  }
  if (id === null || !media || !modelStartPending('reorder-images', id)) return;
  const index = media.images.findIndex((image) => image.id === imageId);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= media.images.length) { modelFinishPending('reorder-images', id); return; }
  setMediaPending(true);
  modelError();
  const ids = media.images.map((image) => image.id);
  [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
  try {
    const snapshot = await modelApi(`/items/model/${id}/images/order`, { method: 'PUT', body: JSON.stringify({ ids }) });
    if (modelState.editing !== id || !model$('#model-editor').open) return;
    modelState.media = snapshot;
    modelState.managerPage = Math.floor(nextIndex / 3);
    renderModelMedia();
    updateModelCardCover();
  } catch (error) {
    if (modelState.editing === id && model$('#model-editor').open) modelError(modelFriendlyError('调整图片顺序', error));
  } finally {
    if (modelState.editing === id && model$('#model-editor').open) setMediaPending(false);
    modelFinishPending('reorder-images', id);
  }
}
async function setModelCover(imageId) {
  const id = modelState.editing;
  if (pendingModelMedia.has(imageId)) { pendingModelMedia.setCover(imageId); modelState.media = pendingModelMedia.snapshot(); renderModelMedia(); return; }
  if (id === null || !modelStartPending('set-cover', id)) return;
  setMediaPending(true);
  modelError();
  try {
    const snapshot = await modelApi(`/items/model/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: imageId }) });
    if (modelState.editing !== id || !model$('#model-editor').open) return;
    modelState.media = snapshot;
    renderModelMedia();
    updateModelCardCover();
  } catch (error) {
    if (modelState.editing === id && model$('#model-editor').open) modelError(modelFriendlyError('设置封面', error));
  } finally {
    if (modelState.editing === id && model$('#model-editor').open) setMediaPending(false);
    modelFinishPending('set-cover', id);
  }
}
function openModelImageDelete(imageId) {
  const image = modelState.media?.images.find((candidate) => candidate.id === imageId);
  const ownerModelId = modelState.editing;
  if (!image || (ownerModelId === null && !pendingModelMedia.has(imageId))) return;
  modelState.imageDeleteGeneration += 1;
  modelState.imageDeleting = image;
  modelState.imageDeleteTarget = Object.freeze({ ownerModelId, imageId: image.id });
  model$('#model-image-delete-target').textContent = `将删除图片“${image.media_path}”。`;
  model$('#model-image-delete [data-action="confirm-model-image-delete"]').disabled = false;
  modelOpen(model$('#model-image-delete'));
}
function closeModelImageDelete() {
  modelState.imageDeleteGeneration += 1;
  modelState.imageDeleteTarget = null;
  modelState.imageDeleting = null;
  model$('#model-image-delete [data-action="confirm-model-image-delete"]').disabled = false;
  modelClose(model$('#model-image-delete'));
}
async function confirmModelImageDelete() {
  const ownerModelId = modelState.editing;
  const image = modelState.imageDeleting;
  const imageId = image?.id;
  const generation = modelState.imageDeleteGeneration;
  const editorGeneration = modelState.editorGeneration;
  const target = modelState.imageDeleteTarget;
  const dialog = model$('#model-image-delete');
  if (image && pendingModelMedia.has(imageId)) {
    pendingModelMedia.remove(imageId); modelState.media = pendingModelMedia.snapshot(); modelState.managerPage = mediaWindow(modelState.media.images, modelState.managerPage).page;
    closeModelImageDelete(); renderModelMedia(); return;
  }
  if (ownerModelId === null || !image || target?.ownerModelId !== ownerModelId || target.imageId !== imageId || !modelStartPending('delete-image', imageId)) return;
  const requestToken = ++modelState.imageDeleteRequestToken;
  const button = dialog.querySelector('[data-action="confirm-model-image-delete"]');
  const isCurrentRequest = () => requestToken === modelState.imageDeleteRequestToken
    && generation === modelState.imageDeleteGeneration
    && editorGeneration === modelState.editorGeneration
    && modelState.editing === ownerModelId
    && modelState.imageDeleting === image
    && modelState.imageDeleteTarget === target
    && target.ownerModelId === ownerModelId
    && target.imageId === imageId
    && model$('#model-editor').open
    && dialog.open;
  button.disabled = true;
  try {
    const snapshot = await modelApi(`/items/model/${ownerModelId}/images/${imageId}`, { method: 'DELETE' });
    if (!isCurrentRequest()) return;
    modelState.media = snapshot;
    modelState.managerPage = mediaWindow(snapshot.images, modelState.managerPage).page;
    closeModelImageDelete();
    renderModelMedia();
    updateModelCardCover();
  } catch (error) {
    if (isCurrentRequest()) modelError(modelFriendlyError('删除图片', error));
  } finally {
    modelFinishPending('delete-image', imageId);
    if (isCurrentRequest()) button.disabled = false;
  }
}
function modelImpactItem(item) {
  const label = ({ model: '模型', lora: 'LoRA', template: '模板', image: '图片', artist_prompt_string: '画师串' }[item.kind] ?? item.kind);
  return `<li>${label}：${escapeHtml(item.name ?? item.media_path ?? `#${item.id}`)}</li>`;
}
async function openModelDelete(id) {
  const generation = ++modelState.deleteGeneration;
  const dialog = model$('#model-delete');
  modelState.deleting = null;
  showError(dialog.querySelector('#model-delete-error'));
  dialog.querySelector('#model-delete-target').textContent = '正在读取模型删除影响预览……';
  dialog.querySelector('#model-cascade-list').innerHTML = '<li>正在读取影响预览……</li>';
  dialog.querySelector('#model-retained-list').innerHTML = '';
  dialog.querySelector('[data-action="confirm-model-delete"]').disabled = true;
  modelOpen(dialog);
  try {
    const impact = await modelApi(`/manage/models/${id}/delete-impact`);
    if (generation !== modelState.deleteGeneration || !dialog.open) return;
    modelState.deleting = impact;
    dialog.querySelector('#model-delete-target').textContent = `将删除模型“${impact.target.name}”。`;
    dialog.querySelector('#model-cascade-list').innerHTML = impact.cascade_deleted.length ? impact.cascade_deleted.map(modelImpactItem).join('') : '<li>没有需要级联删除的对象。</li>';
    dialog.querySelector('#model-retained-list').innerHTML = impact.retained.length ? impact.retained.map(modelImpactItem).join('') : '<li>没有需要解除关联的对象。</li>';
  } catch (error) {
    if (generation === modelState.deleteGeneration && dialog.open) showError(dialog.querySelector('#model-delete-error'), modelFriendlyError('读取删除影响预览', error));
  } finally {
    if (generation !== modelState.deleteGeneration || !dialog.open) return;
    dialog.querySelector('[data-action="confirm-model-delete"]').disabled = modelState.deleting === null;
  }
}
function closeModelDelete() {
  modelState.deleteGeneration += 1;
  modelState.deleting = null;
  modelClose(model$('#model-delete'));
}
async function confirmModelDelete() {
  const impact = modelState.deleting;
  const targetId = impact?.target?.id;
  const generation = modelState.deleteGeneration;
  if (!impact || !modelStartPending('delete-model', targetId)) return;
  const requestToken = ++modelState.deleteRequestToken;
  const dialog = model$('#model-delete');
  const button = dialog.querySelector('[data-action="confirm-model-delete"]');
  const isCurrentRequest = () => requestToken === modelState.deleteRequestToken
    && generation === modelState.deleteGeneration
    && modelState.deleting === impact
    && modelState.deleting?.target?.id === targetId
    && dialog.open;
  button.disabled = true;
  try {
    const result = await modelApi(`/manage/models/${targetId}`, { method: 'DELETE', body: JSON.stringify({ impact_token: impact.impact_token }) });
    await loadModels(modelState.page, { fallbackToLastPage: true });
    if (!isCurrentRequest()) return;
    closeModelDelete();
    if (result.cleanup_warning) showError(model$('#model-error'), '模型记录已删除，但部分资源图片文件等待后续清理。');
  } catch (error) {
    if (!isCurrentRequest()) return;
    if (error?.code === 'DELETE_IMPACT_STALE') {
      showError(dialog.querySelector('#model-delete-error'), '影响预览已过期，正在重新读取。请确认新的删除范围。');
      if (!isCurrentRequest()) return;
      await openModelDelete(targetId);
    } else {
      showError(dialog.querySelector('#model-delete-error'), modelFriendlyError('删除模型', error));
    }
  } finally {
    modelFinishPending('delete-model', targetId);
    if (isCurrentRequest()) button.disabled = modelState.deleting === null;
  }
}

const modelSearch = model$('#model-search');
if (modelSearch) {
  bindManagementFilterForm({
    config: PAGE_CONFIG,
    form: model$('#model-filter-form'),
    keyword: modelSearch,
    onApply() {
      modelState.query = modelSearch.value;
      modelState.baseModelId = model$('#model-filter-base-model').value;
      modelState.fileFormat = model$('#model-filter-file-format').value.trim();
      modelState.precision = model$('#model-filter-precision').value.trim();
      return loadModels(1);
    },
    onReset() {
      Object.assign(modelState, { query: '', baseModelId: '', fileFormat: '', precision: '' });
      return loadModels(1);
    }
  });
  model$('#model-form').addEventListener('submit', (event) => { event.preventDefault(); void saveModelEditor(); });
  model$('#model-cover-upload')?.addEventListener('change', () => { void replaceModelCover(); });
  model$('#model-image-upload').addEventListener('change', () => { void uploadModelImages(); });
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const id = Number(target.dataset.id);
    const imageId = target.dataset.imageId?.startsWith('pending-') ? target.dataset.imageId : Number(target.dataset.imageId);
    const imageIndex = Number(target.dataset.imageIndex);
    if (target.dataset.action === 'choose-model-cover') model$('#model-cover-upload').click();
    if (target.dataset.action === 'choose-model-images') model$('#model-image-upload').click();
    if (target.dataset.action === 'open-model-image-manager') openModelImageManager(target);
    if (target.dataset.action === 'close-model-image-manager') closeModelImageManager();
    if (target.dataset.action === 'previous-model-image-group') { modelState.managerPage -= 1; renderModelImageManager(); }
    if (target.dataset.action === 'next-model-image-group') { modelState.managerPage += 1; renderModelImageManager(); }
    if (target.dataset.action === 'previous-model-media-group') { modelState.mediaPage -= 1; renderModelMedia(); }
    if (target.dataset.action === 'next-model-media-group') { modelState.mediaPage += 1; renderModelMedia(); }
    if (target.dataset.action === 'open-model-image-preview') openModelImagePreview(imageIndex, target);
    if (target.dataset.action === 'close-model-image-preview') closeModelImagePreview();
    if (target.dataset.action === 'previous-model-preview') { modelState.previewIndex -= 1; renderModelImagePreview(); }
    if (target.dataset.action === 'next-model-preview') { modelState.previewIndex += 1; renderModelImagePreview(); }
    if (target.dataset.action === 'open-model-create') void openModelEditor();
    if (target.dataset.action === 'open-model-detail') void openModelEditor(id);
    if (target.dataset.action === 'close-model-editor') closeModelEditor();
    if (target.dataset.action === 'upload-model-images') void uploadModelImages();
    if (target.dataset.action === 'move-model-image-up') void reorderModelImage(imageId, -1);
    if (target.dataset.action === 'move-model-image-down') void reorderModelImage(imageId, 1);
    if (target.dataset.action === 'set-model-cover') void setModelCover(imageId);
    if (target.dataset.action === 'delete-model-image') openModelImageDelete(imageId);
    if (target.dataset.action === 'close-model-image-delete') closeModelImageDelete();
    if (target.dataset.action === 'confirm-model-image-delete') void confirmModelImageDelete();
    if (target.dataset.action === 'open-model-delete') void openModelDelete(id);
    if (target.dataset.action === 'close-model-delete') closeModelDelete();
    if (target.dataset.action === 'confirm-model-delete') void confirmModelDelete();
    if (target.dataset.action === 'previous-model-page') void loadModels(modelState.page - 1);
    if (target.dataset.action === 'next-model-page') void loadModels(modelState.page + 1);
    if (target.dataset.action === 'go-model-page') void loadModels(Number(target.dataset.page));
  });
  document.addEventListener('keydown', (event) => {
    if (!model$('#model-image-preview')?.open) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); modelState.previewIndex -= 1; renderModelImagePreview(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); modelState.previewIndex += 1; renderModelImagePreview(); }
    if (event.key === 'Escape') { event.preventDefault(); closeModelImagePreview(); }
  });

  renderModelList();
  void loadModelListOptions().catch((error) => showError(model$('#model-error'), modelFriendlyError('读取模型筛选选项', error)));
  void loadModels();
}
