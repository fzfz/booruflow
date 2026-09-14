import { createPendingMediaCollection, escapeHtml, http, installModelImageFailureHandlers, managementListReadyStatus, paginationTools, renderManagementListStatus, showError, urls } from './generation-resource-shared.js';
import { MANAGEMENT_LIST_PAGE_CONFIG } from './management-list-page-config.mjs';
import { bindManagementFilterForm } from './management-list-layout.js';
import { formatWorkflowJsonFile } from './workflow-json-file.mjs';

const PAGE_CONFIG = MANAGEMENT_LIST_PAGE_CONFIG.comfyuiTemplates;
const TEMPLATE_TYPE_LABELS = Object.freeze({
  text_to_image: '文生图', text_to_image_lora: '文生图 LoRA', text_to_image_hires_fix: '文生图高清修复',
  text_to_image_second_pass: '文生图二次处理', text_to_video: '文生视频', image_to_image: '图生图',
  image_to_video: '图生视频', video_to_video: '视频转视频', style_transfer: '风格迁移', controlnet: 'ControlNet',
  inpainting: '局部重绘', outpainting: '扩图', upscale: '放大', face_detailer: '面部修复', other: '其他'
});
const templateState = {
  items: [], page: 1, totalCount: 0, totalPages: 1, query: '', baseModelId: '', modelId: '', loraId: '', templateType: '', listView: 'loading', loading: false,
  editing: null, editorGeneration: 0, editorLoading: false, media: null, deleting: null, imageDeleting: null,
  listGeneration: 0, deleteGeneration: 0, deleteRequestToken: 0, imageDeleteGeneration: 0, imageDeleteRequestToken: 0,
  imageDeleteTarget: null, pending: new Set(), jsonReadGeneration: 0, previewTrigger: null
};

const template$ = (selector) => document.querySelector(selector);
const templateField = (name) => template$('#template-form').elements.namedItem(name);
const templateRequestId = () => `generation-template-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const templatePendingKey = (action, target = '') => `${action}:${target}`;
const pendingTemplateMedia = createPendingMediaCollection();

function templateOpen(dialog) { if (!dialog.open) dialog.showModal(); }
function templateClose(dialog) { if (dialog.open) dialog.close(); }
function templateError(message = '') { showError(template$('#template-editor-error'), message); }
function templateStatus(message, busy = false) {
  renderManagementListStatus(template$('#template-status'), message, busy);
}
function templateStartPending(action, target = '') {
  const key = templatePendingKey(action, target);
  if (templateState.pending.has(key)) return false;
  templateState.pending.add(key);
  return true;
}
function templateFinishPending(action, target = '') { templateState.pending.delete(templatePendingKey(action, target)); }
function templateFriendlyError(action, error) {
  if (error?.code === 'DUPLICATE_RESOURCE') return `${action}失败：模板封面已存在；请先删除当前封面。`;
  if (error?.code === 'RELATION_CONFLICT') {
    return `${action}失败：相关内容在页面打开后已经变化。请重新加载后再试；当前编辑内容已保留。`;
  }
  if (error?.code === 'VALIDATION_ERROR'
    && error.details?.field === 'template_json'
    && Array.isArray(error.details.supported_versions)
    && error.details.supported_versions.length === 2
    && error.details.supported_versions.every((version) => typeof version === 'string' && version.length > 0)) {
    return `${action}失败：Workflow JSON 必须符合 ${error.details.supported_versions.join(' 或 ')} 格式；当前编辑内容已保留。`;
  }
  if (error?.code === 'VALIDATION_ERROR') return `${action}失败：当前填写内容不能保存。请检查必填内容和格式后重试；当前编辑内容已保留。`;
  if (error?.code === 'UPLOAD_TYPE_UNSUPPORTED') return `${action}失败：请选择有效的 JPEG、PNG 或 WebP 图片。`;
  if (error?.code === 'WRITE_FORBIDDEN') return `${action}失败：当前操作没有写入权限。请检查应用的写入权限后重试；当前编辑内容已保留。`;
  if (error?.code === 'DATABASE_BUSY') return `${action}暂时无法完成：数据正在被其他操作占用，请稍后重试；当前编辑内容已保留。`;
  return `${action}失败：服务暂时无法完成请求。请稍后重试；当前编辑内容已保留。`;
}
async function templateApi(path, options = {}) {
  const { requestId = templateRequestId(), ...requestOptions } = options;
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-request-id', requestId);
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return await http.requestJson({ path: urls.api(path), options: { ...requestOptions, headers }, requestId, timeoutMs: http.DEFAULT_TIMEOUT_MS });
}
function templateImageMarkup(mediaPath, label) {
  if (!mediaPath) return '<div class="card-cover image-placeholder"><span>暂无封面</span></div>';
  return `<div class="card-cover image-frame"><img src="${escapeHtml(urls.media(mediaPath))}" alt="${escapeHtml(label)}" data-media-image><span class="image-placeholder-label">图片加载失败</span></div>`;
}
function templateMediaSource(image) { return image.local_url ?? urls.media(image.media_path); }
function templateImpactItem(item) {
  const label = ({ model: '模型', lora: 'LoRA', template: '模板', image: '图片', artist_prompt_string: '画师串' }[item.kind] ?? item.kind);
  return `<li>${label}：${escapeHtml(item.name ?? item.media_path ?? `#${item.id}`)}</li>`;
}
function renderTemplateList() {
  const list = template$('#template-list');
  list.innerHTML = templateState.listView === 'loading'
    ? '<div class="base-model-skeleton" aria-busy="true" aria-label="正在载入 ComfyUI 模板列表"><span></span><span></span><span></span></div>'
    : templateState.listView === 'error'
      ? '<p class="state-line error">ComfyUI 模板列表读取失败。</p>'
      : templateState.items.length === 0
        ? '<p class="state-line">暂无匹配 ComfyUI 模板。</p>'
        : templateState.items.map((item) => `<article class="manage-card" data-id="${item.id}">
          <header><span class="type-tag">ComfyUI 模板</span></header>
          ${templateImageMarkup(item.cover_media_path, `${item.title}封面`)}
          <strong class="card-name">${escapeHtml(item.title)}</strong>
          <span class="card-summary">底模 ${escapeHtml(item.base_model_name)} · 模型 ${escapeHtml(item.model_name)}</span>
          <div class="card-footer"><span class="card-footer-tag">${escapeHtml(TEMPLATE_TYPE_LABELS[item.template_type] ?? '其他')}</span><span>${item.lora_name === null ? '无 LoRA' : `LoRA ${escapeHtml(item.lora_name)}`}</span></div>
          <div class="manage-actions"><button class="secondary-button" data-action="open-template-detail" data-id="${item.id}">编辑</button></div>
        </article>`).join('');
  const pagination = template$('#template-pagination');
  pagination.innerHTML = paginationTools.renderControls({ page: templateState.page, totalPages: templateState.totalPages, totalCount: templateState.totalCount, loading: templateState.loading, previousAction: 'previous-template-page', nextAction: 'next-template-page', pageAction: 'go-template-page' });
  installModelImageFailureHandlers();
}
const templatePagination = paginationTools.createListController({
  state: templateState,
  fetchPage: (page) => {
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_CONFIG.pageSize), q: templateState.query });
    if (templateState.baseModelId !== '') query.set('base_model_id', templateState.baseModelId);
    if (templateState.modelId !== '') query.set('model_id', templateState.modelId);
    if (templateState.loraId !== '') query.set('lora_id', templateState.loraId);
    if (templateState.templateType !== '') query.set('template_type', templateState.templateType);
    return templateApi(`/manage/comfyui-templates?${query}`);
  },
  render: renderTemplateList,
  setStatus: templateStatus,
  setError: (message) => showError(template$('#template-error'), message),
  loadingMessage: '正在载入 ComfyUI 模板……',
  emptyMessage: '暂无 ComfyUI 模板。',
  readyMessage: (response) => managementListReadyStatus(response, PAGE_CONFIG.pageSize),
  failureMessage: 'ComfyUI 模板列表读取失败。',
  errorMessage: (error) => templateFriendlyError('读取 ComfyUI 模板列表', error)
});
function loadTemplates(page = 1, options = {}) { return templatePagination.load(page, options); }
function fillTemplateOptions(select, items, emptyLabel, selectedId = null, name = 'name') {
  const nullOption = select.name === 'lora_id' ? '<option value="null" hidden>不关联 LoRA</option>' : '';
  select.innerHTML = `<option value="">${emptyLabel}</option>${nullOption}${items.map((item) => `<option value="${item.id}">${escapeHtml(item[name])}</option>`).join('')}`;
  if (selectedId !== null && selectedId !== undefined) select.value = String(selectedId);
}
async function loadTemplateEditorOptions(item = null) {
  const [bases, models, loras] = await Promise.all([
    templateApi('/manage/base-models?page=1&page_size=100&q='),
    templateApi('/manage/models?page=1&page_size=100&q='),
    templateApi('/manage/loras?page=1&page_size=100&q=')
  ]);
  fillTemplateOptions(templateField('base_model_id'), bases.items, '请选择底模', item?.base_model_id, 'name');
  fillTemplateOptions(templateField('model_id'), models.items, '请选择模型', item?.model_id, 'file_name');
  fillTemplateOptions(templateField('lora_id'), loras.items, '不关联 LoRA', item?.lora_id, 'file_name');
}
async function loadTemplateFilterOptions() {
  try {
    const [bases, models, loras] = await Promise.all([
      templateApi('/manage/base-models?page=1&page_size=100&q='),
      templateApi('/manage/models?page=1&page_size=100&q='),
      templateApi('/manage/loras?page=1&page_size=100&q=')
    ]);
    fillTemplateOptions(template$('#template-filter-base-model'), bases.items, '全部底模', templateState.baseModelId || null, 'name');
    fillTemplateOptions(template$('#template-filter-model'), models.items, '全部模型', templateState.modelId || null, 'file_name');
    fillTemplateOptions(template$('#template-filter-lora'), loras.items, '全部 LoRA', templateState.loraId || null, 'file_name');
    template$('#template-filter-type').innerHTML = `<option value="">全部类型</option>${Object.entries(TEMPLATE_TYPE_LABELS).map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}`;
    template$('#template-filter-type').value = templateState.templateType;
  } catch (error) {
    showError(template$('#template-error'), templateFriendlyError('读取 ComfyUI 模板筛选选项', error));
  }
}
function setTemplateEditorLoading(loading) {
  templateState.editorLoading = loading;
  template$('#template-editor').querySelectorAll('input, select, textarea, button').forEach((element) => {
    if (element.dataset.action === 'close-template-editor') return;
    element.disabled = loading;
  });
}
function setTemplateEditorMode(id, record = null) {
  const editing = id !== null;
  template$('#template-editor-title').textContent = editing ? '编辑 ComfyUI 模板' : '新增 ComfyUI 模板';
  template$('#template-editor-subtitle').textContent = editing ? (record?.title ?? `#${id}`) : '';
  template$('#template-editor-delete').hidden = !editing;
  template$('#template-editor-delete').dataset.id = editing ? String(id) : '';
  template$('#template-editor-submit').textContent = editing ? '保存更改' : '创建 ComfyUI 模板';
}
function resetTemplateForm() {
  templateState.jsonReadGeneration += 1;
  template$('#template-form').reset();
  pendingTemplateMedia.clear();
  templateField('base_model_id').innerHTML = '<option value="">正在读取底模……</option>';
  templateField('model_id').innerHTML = '<option value="">正在读取模型……</option>';
  templateField('lora_id').innerHTML = '<option value="">正在读取 LoRA……</option>';
  template$('#template-media-section').hidden = templateState.editing !== null;
  template$('#template-image-list').innerHTML = '';
  template$('#template-media-status').textContent = '';
  template$('#template-image-upload').value = '';
  template$('#template-json-file').value = '';
  template$('#template-json-file-status').textContent = '也可以直接编辑下方 JSON。';
  templateState.media = templateState.editing === null ? pendingTemplateMedia.snapshot() : null;
  if (templateState.media) renderTemplateMedia();
}
function templateWriteFromForm() {
  let templateJson;
  try {
    templateJson = JSON.parse(templateField('template_json').value);
  } catch {
    throw new Error('Workflow JSON 不是有效的 JSON。');
  }
  if (templateJson === null || Array.isArray(templateJson) || typeof templateJson !== 'object') throw new Error('Workflow JSON 必须是 JSON 对象。');
  return Object.freeze({
    base_model_id: Number(templateField('base_model_id').value),
    model_id: Number(templateField('model_id').value),
    lora_id: ['', 'null'].includes(templateField('lora_id').value) ? null : Number(templateField('lora_id').value),
    template_type: templateField('template_type').value,
    title: templateField('title').value.trim(),
    template_json: templateJson
  });
}
function populateTemplateForm(item) {
  templateField('base_model_id').value = String(item.base_model_id);
  templateField('model_id').value = String(item.model_id);
  templateField('lora_id').value = item.lora_id === null ? '' : String(item.lora_id);
  templateField('template_type').value = item.template_type;
  templateField('title').value = item.title;
  templateField('template_json').value = JSON.stringify(item.template_json, null, 2);
}
function renderTemplateMedia() {
  const list = template$('#template-image-list');
  const media = templateState.media;
  if (!media) { list.innerHTML = '<p class="detail-loading">正在读取模板封面……</p>'; return; }
  template$('#template-image-upload-controls').hidden = media.images.length > 0;
  if (media.images.length === 0) { list.innerHTML = '<p class="detail-empty">暂无模板封面。</p>'; return; }
  list.innerHTML = media.images.map((image) => `<article class="detail-image is-cover">
    <button type="button" class="detail-image-frame image-frame" data-action="open-template-image-preview" aria-label="查看模板封面原图"><img src="${escapeHtml(templateMediaSource(image))}" alt="模板封面" data-media-image><span class="image-placeholder-label">图片加载失败</span></button>
    <p class="detail-image-status">当前封面</p>
    <div class="detail-image-actions"><button type="button" class="danger-button" data-action="delete-template-image" data-image-id="${image.id}">删除图片</button></div>
  </article>`).join('');
  installModelImageFailureHandlers();
}
function openTemplateImagePreview(trigger) {
  const image = templateState.media?.images[0];
  if (!image) return;
  templateState.previewTrigger = trigger;
  template$('#template-image-preview-image').src = templateMediaSource(image);
  templateOpen(template$('#template-image-preview'));
  template$('[data-action="close-template-image-preview"]').focus();
}
function closeTemplateImagePreview() {
  templateClose(template$('#template-image-preview'));
  templateState.previewTrigger?.focus?.();
  templateState.previewTrigger = null;
}
function updateTemplateCardCover() {
  if (templateState.editing === null || !templateState.media) return;
  const item = templateState.items.find((candidate) => candidate.id === templateState.editing);
  if (!item) return;
  item.cover_media_path = templateState.media.cover_media_path;
  renderTemplateList();
}
async function loadTemplateMedia(id, generation) {
  const snapshot = await templateApi(`/items/template/${id}/images`);
  if (generation !== templateState.editorGeneration || templateState.editing !== id || !template$('#template-editor').open) return false;
  templateState.media = snapshot;
  template$('#template-media-section').hidden = false;
  renderTemplateMedia();
  updateTemplateCardCover();
  return true;
}
async function openTemplateEditor(id = null) {
  const generation = ++templateState.editorGeneration;
  templateState.editing = id;
  templateError();
  resetTemplateForm();
  setTemplateEditorMode(id);
  templateOpen(template$('#template-editor'));
  setTemplateEditorLoading(true);
  try {
    const item = id === null ? null : await templateApi(`/manage/comfyui-templates/${id}`);
    if (generation !== templateState.editorGeneration || templateState.editing !== id || !template$('#template-editor').open) return;
    await loadTemplateEditorOptions(item);
    if (generation !== templateState.editorGeneration || templateState.editing !== id || !template$('#template-editor').open) return;
    if (item !== null) {
      populateTemplateForm(item);
      setTemplateEditorMode(id, item);
      await loadTemplateMedia(id, generation);
    }
    setTemplateEditorLoading(false);
  } catch (error) {
    if (generation !== templateState.editorGeneration || !template$('#template-editor').open) return;
    templateError(templateFriendlyError(id === null ? '读取模板关联选项' : '读取 ComfyUI 模板详情', error));
    setTemplateEditorLoading(false);
  }
}
function closeTemplateEditor() {
  templateState.editorGeneration += 1;
  templateState.jsonReadGeneration += 1;
  templateState.editing = null;
  templateState.media = null;
  closeTemplateImagePreview();
  pendingTemplateMedia.clear();
  templateClose(template$('#template-editor'));
}
async function uploadPendingTemplateMedia(id) {
  if (pendingTemplateMedia.size === 0) return true;
  const form = new FormData();
  form.append('files', pendingTemplateMedia.files()[0]);
  try {
    const snapshot = await templateApi(`/items/template/${id}/images`, { method: 'POST', body: form });
    pendingTemplateMedia.clear();
    templateState.media = snapshot;
    template$('#template-media-section').hidden = false;
    template$('#template-media-status').textContent = '模板封面已上传。';
    renderTemplateMedia();
    return true;
  } catch (error) {
    templateError(`ComfyUI 模板 #${id} 已创建，但封面上传失败。${templateFriendlyError('上传模板封面', error)}`);
    return false;
  }
}
async function readTemplateJsonFile() {
  const input = template$('#template-json-file');
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const readGeneration = ++templateState.jsonReadGeneration;
  const editorGeneration = templateState.editorGeneration;
  template$('#template-json-file-status').textContent = `正在读取“${file.name}”……`;
  try {
    const formatted = formatWorkflowJsonFile(file.name, await file.text());
    if (readGeneration !== templateState.jsonReadGeneration || editorGeneration !== templateState.editorGeneration || !template$('#template-editor').open) return;
    templateField('template_json').value = formatted;
    templateField('template_json').dispatchEvent(new Event('input', { bubbles: true }));
    template$('#template-json-file-status').textContent = `已读取“${file.name}”，更改尚未保存。`;
    templateError();
  } catch (error) {
    if (readGeneration !== templateState.jsonReadGeneration || editorGeneration !== templateState.editorGeneration || !template$('#template-editor').open) return;
    template$('#template-json-file-status').textContent = `读取“${file.name}”失败。`;
    templateError(error.message);
  }
}
async function saveTemplateEditor() {
  const generation = templateState.editorGeneration;
  const id = templateState.editing;
  if (templateState.editorLoading || !templateStartPending('save', generation)) return;
  let write;
  try {
    write = templateWriteFromForm();
  } catch (error) {
    templateError(error.message);
    templateFinishPending('save', generation);
    return;
  }
  setTemplateEditorLoading(true);
  templateError();
  try {
    const record = id === null
      ? await templateApi('/manage/comfyui-templates', { method: 'POST', body: JSON.stringify(write) })
      : await templateApi(`/manage/comfyui-templates/${id}`, { method: 'PUT', body: JSON.stringify(write) });
    if (generation !== templateState.editorGeneration || templateState.editing !== id || !template$('#template-editor').open) return;
    if (id === null) {
      templateState.editing = record.id;
      setTemplateEditorMode(record.id, record);
      if (pendingTemplateMedia.size > 0) await uploadPendingTemplateMedia(record.id);
      else await loadTemplateMedia(record.id, generation);
    } else if (pendingTemplateMedia.size > 0) {
      await uploadPendingTemplateMedia(record.id);
    }
    await loadTemplates(id === null ? 1 : templateState.page);
  } catch (error) {
    if (generation === templateState.editorGeneration && template$('#template-editor').open) templateError(templateFriendlyError('保存 ComfyUI 模板', error));
  } finally {
    if (generation === templateState.editorGeneration && template$('#template-editor').open) setTemplateEditorLoading(false);
    templateFinishPending('save', generation);
  }
}
function setTemplateMediaPending(pending) {
  template$('#template-media-section').querySelectorAll('input, button').forEach((element) => { element.disabled = pending; });
}
function validateTemplateImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error(`文件“${file.name}”不是 JPEG、PNG 或 WebP 图片。`);
  if (file.size > 10 * 1024 * 1024) throw new Error(`文件“${file.name}”超过 10 MiB。`);
}
async function uploadTemplateImage() {
  const id = templateState.editing;
  const file = template$('#template-image-upload').files[0];
  if (!file) return;
  try { validateTemplateImage(file); } catch (error) { templateError(error.message); return; }
  if (id === null || pendingTemplateMedia.size > 0) {
    pendingTemplateMedia.clear();
    pendingTemplateMedia.add([file], { selectLastAsCover: true });
    templateState.media = pendingTemplateMedia.snapshot();
    template$('#template-image-upload').value = '';
    template$('#template-media-status').textContent = '已选择模板封面，创建模板后上传。';
    renderTemplateMedia();
    return;
  }
  if (!templateStartPending('upload-image', id)) return;
  setTemplateMediaPending(true);
  templateError();
  try {
    const form = new FormData();
    form.append('files', file);
    const snapshot = await templateApi(`/items/template/${id}/images`, { method: 'POST', body: form });
    if (templateState.editing !== id || !template$('#template-editor').open) return;
    templateState.media = snapshot;
    template$('#template-image-upload').value = '';
    template$('#template-media-status').textContent = '模板封面已上传。';
    renderTemplateMedia();
    updateTemplateCardCover();
  } catch (error) {
    if (templateState.editing === id && template$('#template-editor').open) templateError(templateFriendlyError('上传模板封面', error));
  } finally {
    if (templateState.editing === id && template$('#template-editor').open) setTemplateMediaPending(false);
    templateFinishPending('upload-image', id);
  }
}
function openTemplateImageDelete(imageId) {
  const image = templateState.media?.images.find((candidate) => candidate.id === imageId);
  const ownerTemplateId = templateState.editing;
  if (!image || (ownerTemplateId === null && !pendingTemplateMedia.has(imageId))) return;
  templateState.imageDeleteGeneration += 1;
  templateState.imageDeleting = image;
  templateState.imageDeleteTarget = Object.freeze({ ownerTemplateId, imageId: image.id });
  template$('#template-image-delete-target').textContent = `将删除模板封面“${image.media_path}”。`;
  template$('#template-image-delete [data-action="confirm-template-image-delete"]').disabled = false;
  templateOpen(template$('#template-image-delete'));
}
function closeTemplateImageDelete() {
  templateState.imageDeleteGeneration += 1;
  templateState.imageDeleteTarget = null;
  templateState.imageDeleting = null;
  templateClose(template$('#template-image-delete'));
}
async function confirmTemplateImageDelete() {
  const ownerTemplateId = templateState.editing;
  const image = templateState.imageDeleting;
  const imageId = image?.id;
  const generation = templateState.imageDeleteGeneration;
  const editorGeneration = templateState.editorGeneration;
  const target = templateState.imageDeleteTarget;
  const dialog = template$('#template-image-delete');
  if (image && pendingTemplateMedia.has(imageId)) {
    pendingTemplateMedia.remove(imageId);
    templateState.media = pendingTemplateMedia.snapshot();
    closeTemplateImageDelete();
    renderTemplateMedia();
    return;
  }
  if (ownerTemplateId === null || !image || target?.ownerTemplateId !== ownerTemplateId || target.imageId !== imageId || !templateStartPending('delete-image', imageId)) return;
  const requestToken = ++templateState.imageDeleteRequestToken;
  const button = dialog.querySelector('[data-action="confirm-template-image-delete"]');
  const isCurrentRequest = () => requestToken === templateState.imageDeleteRequestToken
    && generation === templateState.imageDeleteGeneration && editorGeneration === templateState.editorGeneration
    && templateState.editing === ownerTemplateId && templateState.imageDeleting === image && templateState.imageDeleteTarget === target
    && template$('#template-editor').open && dialog.open;
  button.disabled = true;
  try {
    const snapshot = await templateApi(`/items/template/${ownerTemplateId}/images/${imageId}`, { method: 'DELETE' });
    if (!isCurrentRequest()) return;
    templateState.media = snapshot;
    closeTemplateImageDelete();
    renderTemplateMedia();
    updateTemplateCardCover();
    if (snapshot.cleanup_warning) showError(template$('#template-error'), '模板封面已移除，但本机图片文件仍然存在。请联系维护人员处理残留文件；模板其他内容未修改。');
  } catch (error) {
    if (isCurrentRequest()) templateError(templateFriendlyError('删除模板封面', error));
  } finally {
    templateFinishPending('delete-image', imageId);
    if (isCurrentRequest()) button.disabled = false;
  }
}
async function openTemplateDelete(id) {
  const generation = ++templateState.deleteGeneration;
  const dialog = template$('#template-delete');
  templateState.deleting = null;
  showError(template$('#template-delete-error'));
  template$('#template-delete-target').textContent = '正在读取 ComfyUI 模板删除影响预览……';
  template$('#template-cascade-list').innerHTML = '<li>正在读取影响预览……</li>';
  template$('#template-retained-list').innerHTML = '';
  dialog.querySelector('[data-action="confirm-template-delete"]').disabled = true;
  templateOpen(dialog);
  try {
    const impact = await templateApi(`/manage/comfyui-templates/${id}/delete-impact`);
    if (generation !== templateState.deleteGeneration || !dialog.open) return;
    templateState.deleting = impact;
    template$('#template-delete-target').textContent = `将删除 ComfyUI 模板“${impact.target.name}”。`;
    template$('#template-cascade-list').innerHTML = impact.cascade_deleted.length ? impact.cascade_deleted.map(templateImpactItem).join('') : '<li>没有需要级联删除的对象。</li>';
    template$('#template-retained-list').innerHTML = impact.retained.length ? impact.retained.map(templateImpactItem).join('') : '<li>没有需要解除关联的对象。</li>';
  } catch (error) {
    if (generation === templateState.deleteGeneration && dialog.open) showError(template$('#template-delete-error'), templateFriendlyError('读取删除影响预览', error));
  } finally {
    if (generation !== templateState.deleteGeneration || !dialog.open) return;
    dialog.querySelector('[data-action="confirm-template-delete"]').disabled = templateState.deleting === null;
  }
}
function closeTemplateDelete() {
  templateState.deleteGeneration += 1;
  templateState.deleting = null;
  templateClose(template$('#template-delete'));
}
async function confirmTemplateDelete() {
  const impact = templateState.deleting;
  const targetId = impact?.target?.id;
  const generation = templateState.deleteGeneration;
  if (!impact || !templateStartPending('delete-template', targetId)) return;
  const requestToken = ++templateState.deleteRequestToken;
  const dialog = template$('#template-delete');
  const button = dialog.querySelector('[data-action="confirm-template-delete"]');
  const isCurrentRequest = () => requestToken === templateState.deleteRequestToken && generation === templateState.deleteGeneration
    && templateState.deleting === impact && templateState.deleting?.target?.id === targetId && dialog.open;
  button.disabled = true;
  try {
    const result = await templateApi(`/manage/comfyui-templates/${targetId}`, { method: 'DELETE', body: JSON.stringify({ impact_token: impact.impact_token }) });
    await loadTemplates(templateState.page, { fallbackToLastPage: true });
    if (!isCurrentRequest()) return;
    closeTemplateDelete();
    if (result.cleanup_warning) showError(template$('#template-error'), '模板已删除，但部分本机封面图片仍然存在。请联系维护人员处理残留文件。');
  } catch (error) {
    if (!isCurrentRequest()) return;
    if (error?.code === 'DELETE_IMPACT_STALE') {
      showError(template$('#template-delete-error'), '影响预览已过期，正在重新读取。请确认新的删除范围。');
      await openTemplateDelete(targetId);
    } else {
      showError(template$('#template-delete-error'), templateFriendlyError('删除 ComfyUI 模板', error));
    }
  } finally {
    templateFinishPending('delete-template', targetId);
    if (isCurrentRequest()) button.disabled = templateState.deleting === null;
  }
}

const templateSearch = template$('#template-search');
if (templateSearch) {
  bindManagementFilterForm({
    config: PAGE_CONFIG,
    form: template$('#template-filter-form'),
    keyword: templateSearch,
    onApply() {
      templateState.query = templateSearch.value;
      templateState.baseModelId = template$('#template-filter-base-model').value;
      templateState.modelId = template$('#template-filter-model').value;
      templateState.loraId = template$('#template-filter-lora').value;
      templateState.templateType = template$('#template-filter-type').value;
      return loadTemplates(1);
    },
    onReset() {
      Object.assign(templateState, { query: '', baseModelId: '', modelId: '', loraId: '', templateType: '' });
      return loadTemplates(1);
    }
  });
  template$('#template-form').addEventListener('submit', (event) => { event.preventDefault(); void saveTemplateEditor(); });
  template$('#template-json-file').addEventListener('change', () => { void readTemplateJsonFile(); });
  document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const id = Number(target.dataset.id);
  const imageId = target.dataset.imageId?.startsWith('pending-') ? target.dataset.imageId : Number(target.dataset.imageId);
  if (target.dataset.action === 'choose-template-json') template$('#template-json-file').click();
  if (target.dataset.action === 'open-template-create') void openTemplateEditor();
  if (target.dataset.action === 'open-template-detail') void openTemplateEditor(id);
  if (target.dataset.action === 'close-template-editor') closeTemplateEditor();
  if (target.dataset.action === 'cancel-template-editor') closeTemplateEditor();
  if (target.dataset.action === 'upload-template-image') void uploadTemplateImage();
  if (target.dataset.action === 'open-template-image-preview') openTemplateImagePreview(target);
  if (target.dataset.action === 'close-template-image-preview') closeTemplateImagePreview();
  if (target.dataset.action === 'delete-template-image') openTemplateImageDelete(imageId);
  if (target.dataset.action === 'close-template-image-delete') closeTemplateImageDelete();
  if (target.dataset.action === 'confirm-template-image-delete') void confirmTemplateImageDelete();
  if (target.dataset.action === 'open-template-delete') void openTemplateDelete(id);
  if (target.dataset.action === 'close-template-delete') closeTemplateDelete();
  if (target.dataset.action === 'confirm-template-delete') void confirmTemplateDelete();
  if (target.dataset.action === 'previous-template-page') void loadTemplates(templateState.page - 1);
  if (target.dataset.action === 'next-template-page') void loadTemplates(templateState.page + 1);
  if (target.dataset.action === 'go-template-page') void loadTemplates(Number(target.dataset.page));
  });
  template$('#template-image-preview').addEventListener('cancel', (event) => { event.preventDefault(); closeTemplateImagePreview(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && template$('#template-image-preview').open) { event.preventDefault(); closeTemplateImagePreview(); }
  });

  renderTemplateList();
  void loadTemplateFilterOptions();
  void loadTemplates();
}
