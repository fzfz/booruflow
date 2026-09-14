import { createPendingMediaCollection, escapeHtml, friendlyManagementError, http, imageManagerEmptySlots, installDialogFocusReturn, installModelImageFailureHandlers, managementListReadyStatus, mediaRangeLabel, mediaWindow, paginationTools, renderManagementListStatus, showError, urls } from './generation-resource-shared.js';
import { MANAGEMENT_LIST_PAGE_CONFIG } from './management-list-page-config.mjs';
import { bindManagementFilterForm } from './management-list-layout.js';

const PAGE_CONFIG = MANAGEMENT_LIST_PAGE_CONFIG.artists;
const artistState = {
  items: [], page: 1, totalCount: 0, totalPages: 1, query: '', baseModelId: '', styleId: '', listView: 'loading', loading: false,
  editing: null, editorGeneration: 0, editorLoading: false, media: null, deleting: null, imageDeleting: null,
  listGeneration: 0, deleteGeneration: 0, deleteRequestToken: 0, imageDeleteGeneration: 0, imageDeleteRequestToken: 0,
  imageDeleteTarget: null, pending: new Set(), styleOptions: [], selectedStyleIds: new Set(), styleSearch: '', stylePanelOpen: false,
  mediaPage: 0, managerPage: 0, previewIndex: 0, managerTrigger: null, previewTrigger: null
};

const artist$ = (selector) => document.querySelector(selector);
const artistField = (name) => artist$('#artist-form').elements.namedItem(name);
const artistRequestId = () => `generation-artist-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const artistPendingKey = (action, target = '') => `${action}:${target}`;
const rememberArtistEditorTrigger = installDialogFocusReturn(artist$('#artist-editor'));
const pendingArtistMedia = createPendingMediaCollection();

function artistOpen(dialog) { if (!dialog.open) dialog.showModal(); }
function artistClose(dialog) { if (dialog.open) dialog.close(); }
function artistError(message = '') { showError(artist$('#artist-editor-error'), message); }
function artistStatus(message, busy = false) {
  renderManagementListStatus(artist$('#artist-status'), message, busy);
}
function artistStartPending(action, target = '') {
  const key = artistPendingKey(action, target);
  if (artistState.pending.has(key)) return false;
  artistState.pending.add(key);
  return true;
}
function artistFinishPending(action, target = '') { artistState.pending.delete(artistPendingKey(action, target)); }
function artistFriendlyError(action, error) {
  if (error?.code === 'DUPLICATE_RESOURCE') return `${action}失败：画师串名称已存在，请修改名称后重试。`;
  if (error?.code === 'RELATION_CONFLICT') return `${action}失败：所选底模或画风不存在，请刷新后重试。`;
  if (error?.code === 'UPLOAD_TYPE_UNSUPPORTED') return `${action}失败：请选择有效的 JPEG、PNG 或 WebP 图片。`;
  if (error?.code === 'WRITE_FORBIDDEN') return `${action}失败：当前应用不允许写入，请检查应用的写入权限后重试。`;
  if (error?.code === 'DATABASE_BUSY') return `${action}暂时无法完成：数据库繁忙，请稍后重试。`;
  return friendlyManagementError(action, error);
}
async function artistApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-request-id', artistRequestId());
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return await http.requestJson({ path: urls.api(path), options: { ...options, headers }, requestId: headers.get('x-request-id'), timeoutMs: http.DEFAULT_TIMEOUT_MS });
}
function artistImageMarkup(mediaPath, label) {
  if (!mediaPath) return '<div class="card-cover image-placeholder"><span>暂无封面</span></div>';
  return `<div class="card-cover image-frame"><img src="${escapeHtml(urls.media(mediaPath))}" alt="${escapeHtml(label)}" data-media-image><span class="image-placeholder-label">图片加载失败</span></div>`;
}
function artistMediaSource(image) { return image.local_url ?? urls.media(image.media_path); }
function renderArtistList() {
  const list = artist$('#artist-list');
  list.innerHTML = artistState.listView === 'loading'
    ? '<div class="base-model-skeleton" aria-busy="true" aria-label="正在载入画师串列表"><span></span><span></span><span></span></div>'
    : artistState.listView === 'error'
      ? '<p class="state-line error">画师串列表读取失败。</p>'
      : artistState.items.length === 0
        ? '<p class="state-line">暂无匹配画师串。</p>'
        : artistState.items.map((item) => `<article class="manage-card" data-id="${item.id}">
          <header><span class="type-tag">画师串</span></header>
          ${artistImageMarkup(item.cover_media_path, `${item.title}封面`)}
          <strong class="card-name">${escapeHtml(item.title)}</strong>
          <span class="card-summary">${escapeHtml(item.description || item.artist_string || '暂无画师串说明')}</span>
          <div class="card-footer"><span class="card-footer-tag">${item.base_model_name === null ? '未关联底模' : escapeHtml(item.base_model_name)}</span><span>${item.style_ids.length} 个关联画风</span></div>
          <div class="manage-actions"><button class="secondary-button" data-action="open-artist-detail" data-id="${item.id}">编辑</button></div>
        </article>`).join('');
  const pagination = artist$('#artist-pagination');
  pagination.innerHTML = paginationTools.renderControls({ page: artistState.page, totalPages: artistState.totalPages, totalCount: artistState.totalCount, loading: artistState.loading, previousAction: 'previous-artist-page', nextAction: 'next-artist-page', pageAction: 'go-artist-page' });
  installModelImageFailureHandlers();
}
const artistPagination = paginationTools.createListController({
  state: artistState,
  fetchPage: (page) => {
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_CONFIG.pageSize), q: artistState.query });
    if (artistState.baseModelId !== '') query.set('base_model_id', artistState.baseModelId);
    if (artistState.styleId !== '') query.set('style_id', artistState.styleId);
    return artistApi(`/manage/artist-prompt-strings?${query}`);
  },
  render: renderArtistList,
  setStatus: artistStatus,
  setError: (message) => showError(artist$('#artist-error'), message),
  loadingMessage: '正在载入画师串……',
  emptyMessage: '暂无画师串。',
  readyMessage: (response) => managementListReadyStatus(response, PAGE_CONFIG.pageSize),
  failureMessage: '画师串列表读取失败。',
  errorMessage: (error) => artistFriendlyError('读取画师串列表', error)
});
function loadArtists(page = 1, options = {}) { return artistPagination.load(page, options); }
async function loadArtistListOptions() {
  const [bases, styles] = await Promise.all([
    artistApi('/manage/base-models?page=1&page_size=100&q='),
    artistApi('/styles?limit=100')
  ]);
  artist$('#artist-filter-base-model').innerHTML = `<option value="">全部底模</option>${bases.items.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
  artist$('#artist-filter-style').innerHTML = `<option value="">全部画风</option>${styles.items.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
}
async function loadArtistBaseOptions(selectedId = null) {
  const data = await artistApi('/manage/base-models?page=1&page_size=100&q=');
  const select = artistField('base_model_id');
  select.innerHTML = `<option value="">不关联底模</option>${data.items.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
  if (selectedId !== null) select.value = String(selectedId);
}
async function loadArtistStyleOptions(selectedIds = []) {
  const data = await artistApi('/styles?limit=100');
  artistState.styleOptions = [...data.items].sort((left, right) => left.id - right.id);
  artistState.selectedStyleIds = new Set(selectedIds.map(Number));
  const select = artistField('style_ids');
  select.innerHTML = artistState.styleOptions.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  syncArtistStyleSelect();
  renderArtistStyleControl();
}
function syncArtistStyleSelect() {
  const selected = new Set([...artistState.selectedStyleIds].map(String));
  for (const option of artistField('style_ids').options) option.selected = selected.has(option.value);
}
function selectedArtistStyles() {
  return artistState.styleOptions.filter((item) => artistState.selectedStyleIds.has(item.id));
}
function renderArtistStyleControl() {
  const selected = selectedArtistStyles();
  const query = artistState.styleSearch.trim().toLocaleLowerCase('zh-CN');
  const candidates = artistState.styleOptions.filter((item) => !artistState.selectedStyleIds.has(item.id) && item.name.toLocaleLowerCase('zh-CN').includes(query));
  artist$('#artist-style-trigger').setAttribute('aria-expanded', String(artistState.stylePanelOpen));
  artist$('#artist-style-panel').hidden = !artistState.stylePanelOpen;
  artist$('#artist-style-summary').textContent = selected.length === 0 ? '未选择画风' : selected.map((item) => item.name).join('、');
  artist$('#artist-style-count').textContent = `已选 ${selected.length} 个`;
  artist$('#artist-style-selection-count').textContent = `已选 ${selected.length} 个`;
  artist$('#artist-style-selected').innerHTML = selected.length === 0 ? '<span class="searchable-multi-empty">尚未选择画风</span>' : selected.map((item) => `<span class="searchable-multi-chip">${escapeHtml(item.name)}<button type="button" data-action="remove-artist-style" data-style-id="${item.id}" aria-label="取消选择画风 ${escapeHtml(item.name)}">取消</button></span>`).join('');
  artist$('#artist-style-options').innerHTML = candidates.length === 0 ? '<p class="searchable-multi-empty">没有匹配的画风</p>' : candidates.map((item) => `<button type="button" class="searchable-multi-option" data-action="add-artist-style" data-style-id="${item.id}" role="option" aria-selected="false">${escapeHtml(item.name)}</button>`).join('');
}
function openArtistStylePanel() {
  artistState.stylePanelOpen = true;
  renderArtistStyleControl();
  artist$('#artist-style-search').focus();
}
function closeArtistStylePanel() {
  artistState.stylePanelOpen = false;
  artistState.styleSearch = '';
  artist$('#artist-style-search').value = '';
  renderArtistStyleControl();
  artist$('#artist-style-trigger').focus();
}
function changeArtistStyle(styleId, selected) {
  if (selected) artistState.selectedStyleIds.add(styleId); else artistState.selectedStyleIds.delete(styleId);
  syncArtistStyleSelect();
  renderArtistStyleControl();
}
function setArtistEditorLoading(loading) {
  artistState.editorLoading = loading;
  artist$('#artist-form').querySelectorAll('input, select, textarea, button').forEach((element) => { element.disabled = loading; });
  artist$('#artist-editor-submit').disabled = loading;
}
function setArtistEditorMode(id, record = null) {
  const editing = id !== null;
  artist$('#artist-editor-title').textContent = editing ? '编辑画师串' : '新增画师串';
  artist$('#artist-editor-subtitle').textContent = editing ? (record?.title ?? `#${id}`) : '';
  artist$('#artist-editor-delete').hidden = !editing;
  artist$('#artist-editor-delete').dataset.id = editing ? String(id) : '';
  artist$('#artist-editor-submit').textContent = editing ? '保存更改' : '创建画师串';
}
function resetArtistForm() {
  artist$('#artist-form').reset();
  pendingArtistMedia.clear();
  artistField('base_model_id').innerHTML = '<option value="">正在读取底模……</option>';
  artistField('style_ids').innerHTML = '';
  artistState.styleOptions = [];
  artistState.selectedStyleIds = new Set();
  artistState.styleSearch = '';
  artistState.stylePanelOpen = false;
  renderArtistStyleControl();
  artist$('#artist-media-section').hidden = artistState.editing !== null;
  artist$('#artist-image-list').innerHTML = '';
  artist$('#artist-media-status').textContent = '';
  artist$('#artist-image-upload').value = '';
  artistState.media = artistState.editing === null ? pendingArtistMedia.snapshot() : null;
  Object.assign(artistState, { mediaPage: 0, managerPage: 0, previewIndex: 0 });
  if (artistState.media) renderArtistMedia();
}
function artistWriteFromForm() {
  return Object.freeze({
    title: artistField('title').value.trim(),
    description: artistField('description').value.trim(),
    artist_string: artistField('artist_string').value.trim(),
    base_model_id: artistField('base_model_id').value === '' ? null : Number(artistField('base_model_id').value),
    style_ids: [...artistState.selectedStyleIds]
  });
}
function populateArtistForm(item) {
  artistField('title').value = item.title;
  artistField('description').value = item.description;
  artistField('artist_string').value = item.artist_string;
  artistField('base_model_id').value = item.base_model_id === null ? '' : String(item.base_model_id);
  artistState.selectedStyleIds = new Set(item.style_ids.map(Number));
  syncArtistStyleSelect();
  renderArtistStyleControl();
}
function renderArtistMedia() {
  const list = artist$('#artist-image-list');
  const media = artistState.media;
  if (!media) { list.innerHTML = '<p class="detail-loading">正在读取资源图片……</p>'; return; }
  const coverIndex = media.images.findIndex((image) => image.media_path === media.cover_media_path);
  const window = mediaWindow(media.images, artistState.mediaPage);
  artistState.mediaPage = window.page;
  const cover = coverIndex < 0 ? '<div class="editor-cover image-placeholder"><span>暂无封面</span></div>' : `<button type="button" class="editor-cover image-frame" data-action="open-artist-image-preview" data-image-index="${coverIndex}" aria-label="查看画师串封面原图"><img src="${escapeHtml(artistMediaSource(media.images[coverIndex]))}" alt="画师串封面" data-media-image><span class="image-placeholder-label">图片加载失败</span></button>`;
  const thumbnails = window.items.map((image, offset) => `<button type="button" class="editor-media-thumbnail${media.cover_media_path === image.media_path ? ' is-cover' : ''}" data-action="open-artist-image-preview" data-image-index="${window.start + offset}" aria-label="查看画师串资源图片 ${window.start + offset + 1} 原图"><img src="${escapeHtml(artistMediaSource(image))}" alt="画师串资源图片 ${window.start + offset + 1}" data-media-image></button>`).join('');
  list.innerHTML = `${cover}<div class="editor-media-pager"><span>${mediaRangeLabel(window)}</span><button type="button" data-action="previous-artist-media-group" aria-label="显示前 3 张图片" ${window.page === 0 ? 'disabled' : ''}>←</button><button type="button" data-action="next-artist-media-group" aria-label="显示后 3 张图片" ${window.page >= window.totalPages - 1 ? 'disabled' : ''}>→</button></div><div class="editor-media-thumbnails">${thumbnails || '<span class="detail-empty">暂无资源图片</span>'}</div>`;
  renderArtistImageManager();
  if (artist$('#artist-image-preview')?.open) renderArtistImagePreview();
  installModelImageFailureHandlers();
}
function renderArtistImageManager() {
  const grid = artist$('#artist-image-manager-grid');
  if (!grid || !artistState.media) return;
  const window = mediaWindow(artistState.media.images, artistState.managerPage);
  artistState.managerPage = window.page;
  artist$('#artist-image-manager-range').textContent = mediaRangeLabel(window);
  const previous = artist$('[data-action="previous-artist-image-group"]'); const next = artist$('[data-action="next-artist-image-group"]');
  if (previous) previous.disabled = window.page === 0; if (next) next.disabled = window.page >= window.totalPages - 1;
  const cards = window.items.map((image, offset) => { const index = window.start + offset; return `<article class="image-manager-card${artistState.media.cover_media_path === image.media_path ? ' is-cover' : ''}"><button type="button" class="image-manager-preview" data-action="open-artist-image-preview" data-image-index="${index}"><img src="${escapeHtml(artistMediaSource(image))}" alt="画师串资源图片 ${index + 1}" data-media-image></button><strong>资源图片 ${index + 1}</strong><span>${artistState.media.cover_media_path === image.media_path ? '当前封面' : ''}</span><div class="image-manager-card-actions"><button type="button" data-action="set-artist-cover" data-image-id="${image.id}" ${artistState.media.cover_media_path === image.media_path ? 'disabled' : ''}>设为封面</button><button type="button" data-action="move-artist-image-up" data-image-id="${image.id}" ${index === 0 ? 'disabled' : ''}>前移</button><button type="button" data-action="move-artist-image-down" data-image-id="${image.id}" ${index === artistState.media.images.length - 1 ? 'disabled' : ''}>后移</button><button type="button" class="danger-button" data-action="delete-artist-image" data-image-id="${image.id}">删除</button></div></article>`; }).join('');
  const remaining = 3 - window.items.length;
  grid.innerHTML = `${cards}${imageManagerEmptySlots(remaining, 'choose-artist-images', window.total)}`;
  installModelImageFailureHandlers();
}
function renderArtistImagePreview() {
  const images = artistState.media?.images ?? [];
  if (images.length === 0) return;
  artistState.previewIndex = ((artistState.previewIndex % images.length) + images.length) % images.length;
  const image = images[artistState.previewIndex];
  artist$('#artist-image-preview-image').src = artistMediaSource(image);
  artist$('#artist-image-preview-image').alt = `画师串资源原图 ${artistState.previewIndex + 1}`;
  artist$('#artist-image-preview-count').textContent = `图片 ${artistState.previewIndex + 1} / ${images.length}`;
  for (const action of ['previous-artist-preview', 'next-artist-preview']) artist$(`[data-action="${action}"]`).disabled = images.length <= 1;
}
function openArtistImageManager(trigger) { artistState.managerTrigger = trigger; artistState.managerPage = artistState.mediaPage; renderArtistImageManager(); artistOpen(artist$('#artist-image-manager')); artist$('[data-action="close-artist-image-manager"]').focus(); }
function closeArtistImageManager() { const dialog = artist$('#artist-image-manager'); if (dialog) artistClose(dialog); artistState.managerTrigger?.focus?.(); artistState.managerTrigger = null; }
function openArtistImagePreview(index, trigger) { artistState.previewTrigger = trigger; artistState.previewIndex = index; renderArtistImagePreview(); artistOpen(artist$('#artist-image-preview')); artist$('[data-action="close-artist-image-preview"]').focus(); }
function closeArtistImagePreview() { const dialog = artist$('#artist-image-preview'); if (dialog) artistClose(dialog); artistState.previewTrigger?.focus?.(); artistState.previewTrigger = null; }
function updateArtistCardCover() {
  if (artistState.editing === null || !artistState.media) return;
  const item = artistState.items.find((candidate) => candidate.id === artistState.editing);
  if (!item) return;
  item.cover_media_path = artistState.media.cover_media_path;
  renderArtistList();
}
async function loadArtistMedia(id, generation) {
  const snapshot = await artistApi(`/items/artist_prompt_string/${id}/images`);
  if (generation !== artistState.editorGeneration || artistState.editing !== id || !artist$('#artist-editor').open) return false;
  artistState.media = snapshot;
  artist$('#artist-media-section').hidden = false;
  renderArtistMedia();
  updateArtistCardCover();
  return true;
}
async function openArtistEditor(id = null, trigger = null) {
  const generation = ++artistState.editorGeneration;
  rememberArtistEditorTrigger(trigger);
  artistState.editing = id;
  artistError();
  resetArtistForm();
  setArtistEditorMode(id);
  artistOpen(artist$('#artist-editor'));
  setArtistEditorLoading(true);
  try {
    const [, , item] = await Promise.all([
      loadArtistBaseOptions(),
      loadArtistStyleOptions(),
      id === null ? Promise.resolve(null) : artistApi(`/manage/artist-prompt-strings/${id}`)
    ]);
    if (generation !== artistState.editorGeneration || artistState.editing !== id || !artist$('#artist-editor').open) return;
    if (item !== null) {
      await Promise.all([loadArtistBaseOptions(item.base_model_id), loadArtistStyleOptions(item.style_ids)]);
      if (generation !== artistState.editorGeneration || artistState.editing !== id || !artist$('#artist-editor').open) return;
      populateArtistForm(item);
      setArtistEditorMode(id, item);
      await loadArtistMedia(id, generation);
    }
    setArtistEditorLoading(false);
  } catch (error) {
    if (generation !== artistState.editorGeneration || !artist$('#artist-editor').open) return;
    artistError(artistFriendlyError(id === null ? '读取底模和画风选项' : '读取画师串详情', error));
    setArtistEditorLoading(false);
  }
}
function closeArtistEditor() {
  artistState.editorGeneration += 1;
  artistState.editing = null;
  artistState.media = null;
  artistState.stylePanelOpen = false;
  closeArtistImagePreview();
  closeArtistImageManager();
  pendingArtistMedia.clear();
  artistClose(artist$('#artist-editor'));
}
async function uploadPendingArtistMedia(id) {
  if (pendingArtistMedia.size === 0) return true;
  const form = new FormData();
  pendingArtistMedia.files().forEach((file) => form.append('files', file));
  try {
    const coverIndex = pendingArtistMedia.coverIndex();
    let snapshot = await artistApi(`/items/artist_prompt_string/${id}/images`, { method: 'POST', body: form });
    pendingArtistMedia.clear();
    const cover = snapshot.images[coverIndex];
    if (cover) {
      try { snapshot = await artistApi(`/items/artist_prompt_string/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: cover.id }) }); }
      catch (error) { artistState.media = snapshot; artistError(`画师串 #${id} 已创建且图片已上传，但设置封面失败。${artistFriendlyError('设置封面', error)}`); return false; }
    }
    artistState.media = snapshot; artist$('#artist-media-section').hidden = false; renderArtistMedia(); return true;
  } catch (error) {
    artistError(`画师串 #${id} 已创建，但图片上传失败。${artistFriendlyError('上传图片', error)}`); return false;
  }
}
async function saveArtistEditor() {
  const generation = artistState.editorGeneration;
  const id = artistState.editing;
  if (artistState.editorLoading || !artistStartPending('save', generation)) return;
  setArtistEditorLoading(true);
  artistError();
  try {
    const record = id === null
      ? await artistApi('/manage/artist-prompt-strings', { method: 'POST', body: JSON.stringify(artistWriteFromForm()) })
      : await artistApi(`/manage/artist-prompt-strings/${id}`, { method: 'PUT', body: JSON.stringify(artistWriteFromForm()) });
    if (generation !== artistState.editorGeneration || artistState.editing !== id || !artist$('#artist-editor').open) return;
    if (id === null) {
      artistState.editing = record.id;
      setArtistEditorMode(record.id, record);
      if (pendingArtistMedia.size > 0) await uploadPendingArtistMedia(record.id);
      else await loadArtistMedia(record.id, generation);
    } else if (pendingArtistMedia.size > 0) {
      await uploadPendingArtistMedia(record.id);
    }
    await loadArtists(id === null ? 1 : artistState.page);
  } catch (error) {
    if (generation === artistState.editorGeneration && artist$('#artist-editor').open) artistError(artistFriendlyError('保存画师串', error));
  } finally {
    if (generation === artistState.editorGeneration && artist$('#artist-editor').open) setArtistEditorLoading(false);
    artistFinishPending('save', generation);
  }
}
function setArtistMediaPending(pending) {
  artist$('#artist-media-section').querySelectorAll('input, button').forEach((element) => { element.disabled = pending; });
  artist$('#artist-image-manager')?.querySelectorAll('button').forEach((element) => { element.disabled = pending; });
}
function validateArtistImageFiles(files) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (files.length > 10) throw new Error('每批最多添加 10 张图片。');
  for (const file of files) {
    if (!allowed.has(file.type)) throw new Error(`文件“${file.name}”不是 JPEG、PNG 或 WebP 图片。`);
    if (file.size > 10 * 1024 * 1024) throw new Error(`文件“${file.name}”超过 10 MiB。`);
  }
}
async function uploadArtistImages() {
  const id = artistState.editing;
  const files = [...artist$('#artist-image-upload').files];
  if (files.length === 0) return;
  try { validateArtistImageFiles(files); } catch (error) { artistError(error.message); return; }
  if (id === null || pendingArtistMedia.size > 0) {
    pendingArtistMedia.add(files);
    artistState.media = pendingArtistMedia.snapshot();
    artistState.managerPage = Math.max(0, Math.ceil(artistState.media.images.length / 3) - 1);
    artist$('#artist-image-upload').value = '';
    artist$('#artist-media-status').textContent = `已选择 ${files.length} 张图片，创建画师串后上传。`;
    renderArtistMedia();
    return;
  }
  if (!artistStartPending('upload-images', id)) return;
  setArtistMediaPending(true);
  artistError();
  try {
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    const snapshot = await artistApi(`/items/artist_prompt_string/${id}/images`, { method: 'POST', body: form });
    if (artistState.editing !== id || !artist$('#artist-editor').open) return;
    artistState.media = snapshot;
    artistState.managerPage = Math.max(0, Math.ceil(snapshot.images.length / 3) - 1);
    artist$('#artist-image-upload').value = '';
    artist$('#artist-media-status').textContent = `已上传 ${files.length} 张图片。`;
    renderArtistMedia();
    updateArtistCardCover();
  } catch (error) {
    if (artistState.editing === id && artist$('#artist-editor').open) artistError(artistFriendlyError('上传', error));
  } finally {
    if (artistState.editing === id && artist$('#artist-editor').open) setArtistMediaPending(false);
    artistFinishPending('upload-images', id);
  }
}
async function replaceArtistCover() {
  const id = artistState.editing;
  const input = artist$('#artist-cover-upload');
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try { validateArtistImageFiles([file]); } catch (error) { artistError(error.message); return; }
  if (id === null || pendingArtistMedia.size > 0) {
    pendingArtistMedia.add([file], { selectLastAsCover: true });
    artistState.media = pendingArtistMedia.snapshot();
    artist$('#artist-media-status').textContent = '已选择待上传封面，创建画师串后上传。';
    renderArtistMedia();
    return;
  }
  if (!artistStartPending('replace-cover', id)) return;
  setArtistMediaPending(true); artistError();
  const existingIds = new Set(artistState.media?.images.map((image) => image.id) ?? []);
  try {
    const form = new FormData(); form.append('files', file);
    const uploaded = await artistApi(`/items/artist_prompt_string/${id}/images`, { method: 'POST', body: form });
    if (artistState.editing !== id || !artist$('#artist-editor').open) return;
    artistState.media = uploaded;
    const added = uploaded.images.find((image) => !existingIds.has(image.id));
    renderArtistMedia();
    if (!added) throw new Error('已上传图片，但无法识别新图片记录。');
    try {
      artistState.media = await artistApi(`/items/artist_prompt_string/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: added.id }) });
      artist$('#artist-media-status').textContent = '已更换封面。'; renderArtistMedia(); updateArtistCardCover();
    } catch (error) { artistError(`图片已上传，但设置封面失败。${artistFriendlyError('设置封面', error)}`); }
  } catch (error) {
    if (artistState.editing === id && artist$('#artist-editor').open) artistError(artistFriendlyError('上传封面', error));
  } finally {
    if (artistState.editing === id && artist$('#artist-editor').open) setArtistMediaPending(false);
    artistFinishPending('replace-cover', id);
  }
}
async function reorderArtistImage(imageId, delta) {
  const id = artistState.editing;
  const media = artistState.media;
  if (pendingArtistMedia.has(imageId)) {
    const nextIndex = pendingArtistMedia.move(imageId, delta);
    if (nextIndex < 0) return;
    artistState.media = pendingArtistMedia.snapshot();
    artistState.managerPage = Math.floor(nextIndex / 3);
    renderArtistMedia();
    return;
  }
  if (id === null || !media || !artistStartPending('reorder-images', id)) return;
  const index = media.images.findIndex((image) => image.id === imageId);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= media.images.length) { artistFinishPending('reorder-images', id); return; }
  setArtistMediaPending(true);
  artistError();
  const ids = media.images.map((image) => image.id);
  [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
  try {
    const snapshot = await artistApi(`/items/artist_prompt_string/${id}/images/order`, { method: 'PUT', body: JSON.stringify({ ids }) });
    if (artistState.editing !== id || !artist$('#artist-editor').open) return;
    artistState.media = snapshot;
    artistState.managerPage = Math.floor(nextIndex / 3);
    renderArtistMedia();
    updateArtistCardCover();
  } catch (error) {
    if (artistState.editing === id && artist$('#artist-editor').open) artistError(artistFriendlyError('调整图片顺序', error));
  } finally {
    if (artistState.editing === id && artist$('#artist-editor').open) setArtistMediaPending(false);
    artistFinishPending('reorder-images', id);
  }
}
async function setArtistCover(imageId) {
  const id = artistState.editing;
  if (pendingArtistMedia.has(imageId)) {
    pendingArtistMedia.setCover(imageId);
    artistState.media = pendingArtistMedia.snapshot();
    renderArtistMedia();
    return;
  }
  if (id === null || !artistStartPending('set-cover', id)) return;
  setArtistMediaPending(true);
  artistError();
  try {
    const snapshot = await artistApi(`/items/artist_prompt_string/${id}/cover`, { method: 'PUT', body: JSON.stringify({ id: imageId }) });
    if (artistState.editing !== id || !artist$('#artist-editor').open) return;
    artistState.media = snapshot;
    renderArtistMedia();
    updateArtistCardCover();
  } catch (error) {
    if (artistState.editing === id && artist$('#artist-editor').open) artistError(artistFriendlyError('设置封面', error));
  } finally {
    if (artistState.editing === id && artist$('#artist-editor').open) setArtistMediaPending(false);
    artistFinishPending('set-cover', id);
  }
}
function openArtistImageDelete(imageId) {
  const image = artistState.media?.images.find((candidate) => candidate.id === imageId);
  const ownerArtistId = artistState.editing;
  if (!image || (ownerArtistId === null && !pendingArtistMedia.has(imageId))) return;
  artistState.imageDeleteGeneration += 1;
  artistState.imageDeleting = image;
  artistState.imageDeleteTarget = Object.freeze({ ownerArtistId, imageId: image.id });
  artist$('#artist-image-delete-target').textContent = `将删除图片“${image.media_path}”。`;
  artist$('#artist-image-delete [data-action="confirm-artist-image-delete"]').disabled = false;
  artistOpen(artist$('#artist-image-delete'));
}
function closeArtistImageDelete() {
  artistState.imageDeleteGeneration += 1;
  artistState.imageDeleteTarget = null;
  artistState.imageDeleting = null;
  artist$('#artist-image-delete [data-action="confirm-artist-image-delete"]').disabled = false;
  artistClose(artist$('#artist-image-delete'));
}
async function confirmArtistImageDelete() {
  const ownerArtistId = artistState.editing;
  const image = artistState.imageDeleting;
  const imageId = image?.id;
  const generation = artistState.imageDeleteGeneration;
  const editorGeneration = artistState.editorGeneration;
  const target = artistState.imageDeleteTarget;
  const dialog = artist$('#artist-image-delete');
  if (image && pendingArtistMedia.has(imageId)) {
    pendingArtistMedia.remove(imageId);
    artistState.media = pendingArtistMedia.snapshot();
    artistState.managerPage = mediaWindow(artistState.media.images, artistState.managerPage).page;
    closeArtistImageDelete();
    renderArtistMedia();
    return;
  }
  if (ownerArtistId === null || !image || target?.ownerArtistId !== ownerArtistId || target.imageId !== imageId || !artistStartPending('delete-image', imageId)) return;
  const requestToken = ++artistState.imageDeleteRequestToken;
  const button = dialog.querySelector('[data-action="confirm-artist-image-delete"]');
  const isCurrentRequest = () => requestToken === artistState.imageDeleteRequestToken
    && generation === artistState.imageDeleteGeneration && editorGeneration === artistState.editorGeneration
    && artistState.editing === ownerArtistId && artistState.imageDeleting === image && artistState.imageDeleteTarget === target
    && target.ownerArtistId === ownerArtistId && target.imageId === imageId && artist$('#artist-editor').open && dialog.open;
  button.disabled = true;
  try {
    const snapshot = await artistApi(`/items/artist_prompt_string/${ownerArtistId}/images/${imageId}`, { method: 'DELETE' });
    if (!isCurrentRequest()) return;
    artistState.media = snapshot;
    artistState.managerPage = mediaWindow(snapshot.images, artistState.managerPage).page;
    closeArtistImageDelete();
    renderArtistMedia();
    updateArtistCardCover();
  } catch (error) {
    if (isCurrentRequest()) artistError(artistFriendlyError('删除图片', error));
  } finally {
    artistFinishPending('delete-image', imageId);
    if (isCurrentRequest()) button.disabled = false;
  }
}
function artistImpactItem(item) {
  const label = ({ style: '画风', image: '图片' }[item.kind] ?? item.kind);
  return `<li>${label}：${escapeHtml(item.name ?? item.media_path ?? `#${item.id}`)}</li>`;
}
async function openArtistDelete(id) {
  const generation = ++artistState.deleteGeneration;
  const dialog = artist$('#artist-delete');
  artistState.deleting = null;
  showError(dialog.querySelector('#artist-delete-error'));
  dialog.querySelector('#artist-delete-target').textContent = '正在读取画师串删除影响预览……';
  dialog.querySelector('#artist-cascade-list').innerHTML = '<li>正在读取影响预览……</li>';
  dialog.querySelector('#artist-retained-list').innerHTML = '';
  dialog.querySelector('[data-action="confirm-artist-delete"]').disabled = true;
  artistOpen(dialog);
  try {
    const impact = await artistApi(`/manage/artist-prompt-strings/${id}/delete-impact`);
    if (generation !== artistState.deleteGeneration || !dialog.open) return;
    artistState.deleting = impact;
    dialog.querySelector('#artist-delete-target').textContent = `将删除画师串“${impact.target.name}”。`;
    dialog.querySelector('#artist-cascade-list').innerHTML = impact.cascade_deleted.length ? impact.cascade_deleted.map(artistImpactItem).join('') : '<li>没有需要级联删除的对象。</li>';
    dialog.querySelector('#artist-retained-list').innerHTML = impact.retained.length ? impact.retained.map(artistImpactItem).join('') : '<li>没有需要解除关联的画风。</li>';
  } catch (error) {
    if (generation === artistState.deleteGeneration && dialog.open) showError(dialog.querySelector('#artist-delete-error'), artistFriendlyError('读取删除影响预览', error));
  } finally {
    if (generation !== artistState.deleteGeneration || !dialog.open) return;
    dialog.querySelector('[data-action="confirm-artist-delete"]').disabled = artistState.deleting === null;
  }
}
function closeArtistDelete() {
  artistState.deleteGeneration += 1;
  artistState.deleting = null;
  artistClose(artist$('#artist-delete'));
}
async function confirmArtistDelete() {
  const impact = artistState.deleting;
  const targetId = impact?.target?.id;
  const generation = artistState.deleteGeneration;
  if (!impact || !artistStartPending('delete-artist', targetId)) return;
  const requestToken = ++artistState.deleteRequestToken;
  const dialog = artist$('#artist-delete');
  const button = dialog.querySelector('[data-action="confirm-artist-delete"]');
  const isCurrentRequest = () => requestToken === artistState.deleteRequestToken && generation === artistState.deleteGeneration
    && artistState.deleting === impact && artistState.deleting?.target?.id === targetId && dialog.open;
  button.disabled = true;
  try {
    const result = await artistApi(`/manage/artist-prompt-strings/${targetId}`, { method: 'DELETE', body: JSON.stringify({ impact_token: impact.impact_token }) });
    await loadArtists(artistState.page, { fallbackToLastPage: true });
    if (!isCurrentRequest()) return;
    closeArtistDelete();
    if (result.cleanup_warning) showError(artist$('#artist-error'), '画师串记录已删除，但部分资源图片文件等待后续清理。');
  } catch (error) {
    if (!isCurrentRequest()) return;
    if (error?.code === 'DELETE_IMPACT_STALE') {
      showError(dialog.querySelector('#artist-delete-error'), '影响预览已过期，正在重新读取。请确认新的删除范围。');
      await openArtistDelete(targetId);
    } else {
      showError(dialog.querySelector('#artist-delete-error'), artistFriendlyError('删除画师串', error));
    }
  } finally {
    artistFinishPending('delete-artist', targetId);
    if (isCurrentRequest()) button.disabled = artistState.deleting === null;
  }
}

const artistSearch = artist$('#artist-search');
if (artistSearch) {
  bindManagementFilterForm({
    config: PAGE_CONFIG,
    form: artist$('#artist-filter-form'),
    keyword: artistSearch,
    onApply() {
      artistState.query = artistSearch.value;
      artistState.baseModelId = artist$('#artist-filter-base-model').value;
      artistState.styleId = artist$('#artist-filter-style').value;
      return loadArtists(1);
    },
    onReset() {
      Object.assign(artistState, { query: '', baseModelId: '', styleId: '' });
      return loadArtists(1);
    }
  });
  artist$('#artist-form').addEventListener('submit', (event) => { event.preventDefault(); void saveArtistEditor(); });
  artist$('#artist-cover-upload')?.addEventListener('change', () => { void replaceArtistCover(); });
  artist$('#artist-image-upload').addEventListener('change', () => { void uploadArtistImages(); });
  artist$('#artist-style-trigger').addEventListener('click', () => {
    if (artistState.stylePanelOpen) closeArtistStylePanel(); else openArtistStylePanel();
  });
  artist$('#artist-style-search').addEventListener('input', (event) => {
    artistState.styleSearch = event.target.value;
    renderArtistStyleControl();
  });
  artist$('#artist-style-search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (artistState.styleSearch !== '') {
        artistState.styleSearch = '';
        event.target.value = '';
        renderArtistStyleControl();
      } else closeArtistStylePanel();
      return;
    }
    const options = [...artist$('#artist-style-options').querySelectorAll('[role="option"]')];
    if ((event.key === 'Enter' || event.key === 'ArrowDown') && options[0]) {
      event.preventDefault();
      if (event.key === 'Enter') changeArtistStyle(Number(options[0].dataset.styleId), true); else options[0].focus();
    }
    if (event.key === 'ArrowUp' && options.length > 0) { event.preventDefault(); options.at(-1).focus(); }
  });
  document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const id = Number(target.dataset.id);
  const imageId = target.dataset.imageId?.startsWith('pending-') ? target.dataset.imageId : Number(target.dataset.imageId);
  const imageIndex = Number(target.dataset.imageIndex);
  const styleId = Number(target.dataset.styleId);
  if (target.dataset.action === 'add-artist-style') changeArtistStyle(styleId, true);
  if (target.dataset.action === 'remove-artist-style') changeArtistStyle(styleId, false);
  if (target.dataset.action === 'open-artist-create') void openArtistEditor(null, target);
  if (target.dataset.action === 'open-artist-detail') void openArtistEditor(id, target);
  if (target.dataset.action === 'close-artist-editor') closeArtistEditor();
  if (target.dataset.action === 'cancel-artist-editor') closeArtistEditor();
  if (target.dataset.action === 'choose-artist-cover') artist$('#artist-cover-upload').click();
  if (target.dataset.action === 'choose-artist-images') artist$('#artist-image-upload').click();
  if (target.dataset.action === 'open-artist-image-manager') openArtistImageManager(target);
  if (target.dataset.action === 'close-artist-image-manager') closeArtistImageManager();
  if (target.dataset.action === 'previous-artist-image-group') { artistState.managerPage -= 1; renderArtistImageManager(); }
  if (target.dataset.action === 'next-artist-image-group') { artistState.managerPage += 1; renderArtistImageManager(); }
  if (target.dataset.action === 'previous-artist-media-group') { artistState.mediaPage -= 1; renderArtistMedia(); }
  if (target.dataset.action === 'next-artist-media-group') { artistState.mediaPage += 1; renderArtistMedia(); }
  if (target.dataset.action === 'open-artist-image-preview') openArtistImagePreview(imageIndex, target);
  if (target.dataset.action === 'close-artist-image-preview') closeArtistImagePreview();
  if (target.dataset.action === 'previous-artist-preview') { artistState.previewIndex -= 1; renderArtistImagePreview(); }
  if (target.dataset.action === 'next-artist-preview') { artistState.previewIndex += 1; renderArtistImagePreview(); }
  if (target.dataset.action === 'upload-artist-images') void uploadArtistImages();
  if (target.dataset.action === 'move-artist-image-up') void reorderArtistImage(imageId, -1);
  if (target.dataset.action === 'move-artist-image-down') void reorderArtistImage(imageId, 1);
  if (target.dataset.action === 'set-artist-cover') void setArtistCover(imageId);
  if (target.dataset.action === 'delete-artist-image') openArtistImageDelete(imageId);
  if (target.dataset.action === 'close-artist-image-delete') closeArtistImageDelete();
  if (target.dataset.action === 'confirm-artist-image-delete') void confirmArtistImageDelete();
  if (target.dataset.action === 'open-artist-delete') void openArtistDelete(id);
  if (target.dataset.action === 'close-artist-delete') closeArtistDelete();
  if (target.dataset.action === 'confirm-artist-delete') void confirmArtistDelete();
  if (target.dataset.action === 'previous-artist-page') void loadArtists(artistState.page - 1);
  if (target.dataset.action === 'next-artist-page') void loadArtists(artistState.page + 1);
  if (target.dataset.action === 'go-artist-page') void loadArtists(Number(target.dataset.page));
  });
  document.addEventListener('keydown', (event) => {
    if (artistState.stylePanelOpen && event.key === 'Escape' && document.activeElement !== artist$('#artist-style-search')) {
      event.preventDefault();
      closeArtistStylePanel();
      return;
    }
    if (!artist$('#artist-image-preview')?.open) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); artistState.previewIndex -= 1; renderArtistImagePreview(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); artistState.previewIndex += 1; renderArtistImagePreview(); }
    if (event.key === 'Escape') { event.preventDefault(); closeArtistImagePreview(); }
  });

  renderArtistList();
  void loadArtistListOptions().catch((error) => showError(artist$('#artist-error'), artistFriendlyError('读取画师串筛选选项', error)));
  void loadArtists();
}
