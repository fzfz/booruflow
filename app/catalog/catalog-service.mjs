import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, assertItemKind, assertSearchQuery, normalizeSearchText, validateCatalogRequest } from '../security/input-validation.mjs';
import { publicPrefixPath } from '../http/public-path.mjs';
import {
  CATALOG_ERROR_MESSAGES,
  CATALOG_PAGE_MAX_ITEMS,
  assertCatalogMediaOrigin
} from '../contracts/catalog-contract.mjs';

const CATALOG_IMAGE_OWNER_KIND = Object.freeze({
  generation_model: 'model',
  lora: 'lora',
  work: 'work',
  character: 'character',
  style: 'style',
  prompt_term: null,
  artist_prompt_string: 'artist_prompt_string',
  comfyui_template: 'template'
});

export function createCatalogService({ database, repository, repositoryRoot = undefined, mediaOrigin = undefined, mediaPublicPrefix = undefined, generationLoraSemanticService = null, workSemanticService = null, characterSemanticService = null, styleSemanticService = null, promptTermSemanticService = null, artistPromptStringSemanticService = null }) {
  const MANAGE_DEFAULT_LIMIT = 16;
  const MANAGE_MAX_LIMIT = 100;
  const HOME_DEFAULT_LIMIT = 30;
  const HOME_MAX_LIMIT = 100;
  if (workSemanticService !== null && (typeof workSemanticService.searchPublic !== 'function' || typeof workSemanticService.searchSkillForAgent !== 'function')) {
    throw new TypeError('workSemanticService must expose searchPublic and searchSkillForAgent');
  }
  if (characterSemanticService !== null && (typeof characterSemanticService.searchPublic !== 'function' || typeof characterSemanticService.searchSkillForAgent !== 'function')) {
    throw new TypeError('characterSemanticService must expose searchPublic and searchSkillForAgent');
  }
  if (styleSemanticService !== null && (typeof styleSemanticService.searchPublic !== 'function' || typeof styleSemanticService.searchSkillForAgent !== 'function')) {
    throw new TypeError('styleSemanticService must expose searchPublic and searchSkillForAgent');
  }
  if (promptTermSemanticService !== null && (typeof promptTermSemanticService.searchPublic !== 'function' || typeof promptTermSemanticService.searchSkillForAgent !== 'function')) {
    throw new TypeError('promptTermSemanticService must expose searchPublic and searchSkillForAgent');
  }
  if (artistPromptStringSemanticService !== null && (typeof artistPromptStringSemanticService.searchPublic !== 'function' || typeof artistPromptStringSemanticService.searchSkillForAgent !== 'function')) {
    throw new TypeError('artistPromptStringSemanticService must expose searchPublic and searchSkillForAgent');
  }
  if (generationLoraSemanticService !== null && (typeof generationLoraSemanticService.searchPublic !== 'function' || typeof generationLoraSemanticService.searchSkillForAgent !== 'function')) {
    throw new TypeError('generationLoraSemanticService must expose searchPublic and searchSkillForAgent');
  }

  function validateManageQuery(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ApplicationError('VALIDATION_ERROR', 'management catalog query must be an object');
    for (const key of Object.keys(input)) {
      if (!['kind', 'query', 'limit', 'page', 'base_model_id', 'availability'].includes(key)) throw new ApplicationError('VALIDATION_ERROR', `management catalog query contains an unknown parameter: ${key}`);
    }
    const kind = input.kind === 'all' ? 'all' : assertItemKind(input.kind, { allowWork: true });
    if (typeof input.query !== 'string' || input.query.length > 100) throw new ApplicationError('VALIDATION_ERROR', 'query must contain 0 to 100 UTF-16 code units');
    const query = normalizeSearchText(input.query);
    const limit = input.limit === undefined ? MANAGE_DEFAULT_LIMIT : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MANAGE_MAX_LIMIT) throw new ApplicationError('VALIDATION_ERROR', `limit must be an integer from 1 to ${MANAGE_MAX_LIMIT}`);
    const page = input.page === undefined ? 1 : input.page;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new ApplicationError('VALIDATION_ERROR', 'page must be an integer from 1 to 1000000');
    const baseModelId = input.base_model_id === undefined ? null : assertIdentifier(input.base_model_id, 'base_model_id');
    if (input.availability !== undefined && !['available', 'unavailable'].includes(input.availability)) throw new ApplicationError('VALIDATION_ERROR', 'availability must be available or unavailable');
    const availability = input.availability === undefined ? null : input.availability === 'available' ? 1 : 0;
    return Object.freeze({ kind, query, limit, page, baseModelId, availability });
  }

  function validateHomeCatalogQuery(kind, input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ApplicationError('VALIDATION_ERROR', 'home catalog query must be an object');
    assertItemKind(kind, { allowWork: true });
    if (typeof input.query !== 'string' || input.query.length > 100) throw new ApplicationError('VALIDATION_ERROR', 'query must contain 0 to 100 UTF-16 code units');
    const query = normalizeSearchText(input.query);
    const limit = input.limit === undefined ? HOME_DEFAULT_LIMIT : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HOME_MAX_LIMIT) throw new ApplicationError('VALIDATION_ERROR', `limit must be an integer from 1 to ${HOME_MAX_LIMIT}`);
    const cursor = input.cursor === undefined ? null : input.cursor;
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 128)) throw new ApplicationError('INVALID_CURSOR', 'home catalog cursor is invalid');
    const workId = input.workId === undefined ? null : input.workId;
    if (kind !== 'character' && workId !== null) throw new ApplicationError('VALIDATION_ERROR', 'work_id only applies to character catalog queries');
    if (workId !== null) assertIdentifier(workId, 'work_id');
    return Object.freeze({ kind, query, workId, limit, cursor });
  }

  function catalogRequest(input, options = {}) {
    try {
      return validateCatalogRequest(input, options);
    } catch {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID);
    }
  }

  function catalogItem(row) {
    if (row === null || typeof row !== 'object' || !Object.hasOwn(row, 'id') || !Object.hasOwn(row, 'name')) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({ id: row.id, name: row.name });
  }

  function workCatalogItem(row, { coverMediaPath, sampleImageUrls }) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    const result = { id: row.id, name: row.name, aliases_json: parseCatalogJsonOrValue(row.aliases_json ?? row.aliases), category_name: row.category_name ?? null };
    result.character_names = row.character_names ?? database.prepare('SELECT name FROM characters WHERE work_id = ? AND is_available = 1 ORDER BY id').all(row.id).map(({ name }) => name);
    result.cover_url = catalogMediaUrl(coverMediaPath);
    result.sample_image_urls = sampleImageUrls;
    return Object.freeze(result);
  }

  function characterCatalogItem(row, { coverMediaPath, sampleImageUrls }) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({
      id: row.id,
      work_id: row.work_id,
      'works.name': row['works.name'] ?? row.work_name ?? null,
      name: row.name,
      aliases_json: parseCatalogJsonOrValue(row.aliases_json ?? row.aliases),
      prompt_text: row.prompt_text,
      cover_url: catalogMediaUrl(coverMediaPath),
      sample_image_urls: sampleImageUrls
    });
  }

  function styleCatalogItem(row, { coverMediaPath, sampleImageUrls }) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({
      id: row.id,
      base_model_id: row.base_model_id,
      name: row.name,
      aliases_json: parseCatalogJsonOrValue(row.aliases_json ?? row.aliases),
      prompt_text: row.prompt_text,
      style_description: row.style_description ?? null,
      cover_url: catalogMediaUrl(coverMediaPath),
      sample_image_urls: sampleImageUrls
    });
  }

  function promptTermCatalogItem(row, { sampleImageUrls }) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({
      id: row.id,
      canonical_tag: row.canonical_tag,
      aliases_json: parseCatalogJsonOrValue(row.aliases_json ?? row.aliases),
      category: row.category,
      post_count: row.post_count,
      sample_image_urls: sampleImageUrls
    });
  }

  function artistPromptStringCatalogItem(row, { coverMediaPath, sampleImageUrls }) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({
      id: row.id,
      title: row.title,
      description: row.description,
      artist_string: row.artist_string,
      base_model_id: row.base_model_id ?? null,
      style_ids: Object.freeze([...(row.style_ids ?? [])]),
      cover_url: catalogMediaUrl(coverMediaPath),
      sample_image_urls: sampleImageUrls
    });
  }

  function catalogMediaUrl(mediaPath) {
    if (mediaPath === null || mediaPath === undefined || mediaPath === '') return null;
    if (typeof mediaPath !== 'string' || mediaPath.includes(String.fromCharCode(0)) || mediaPath.includes('\\') || mediaPath.startsWith('/')) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    const segments = mediaPath.split('/');
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    let origin;
    try {
      origin = assertCatalogMediaOrigin(mediaOrigin);
    } catch {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    if (typeof mediaPublicPrefix !== 'string') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    let prefix;
    try {
      prefix = publicPrefixPath(mediaPublicPrefix);
    } catch {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    const url = `${origin}${prefix}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
    if (url.length > 2048) throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    return url;
  }

  function parseCatalogJson(value) {
    if (value === null) return null;
    if (typeof value !== 'string') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    try {
      return JSON.parse(value);
    } catch {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
  }

  function parseCatalogJsonOrValue(value) {
    if (typeof value === 'string') return parseCatalogJson(value);
    if (value !== null && typeof value === 'object') return value;
    throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
  }

  function generationModelCatalogItem(row, { coverMediaPath, sampleImageUrls }) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({
      id: row.id,
      base_model_id: row.base_model_id,
      file_name: row.file_name,
      file_format: row.file_format,
      precision_or_quantization: row.precision_or_quantization,
      author: row.author ?? null,
      version: row.version ?? null,
      description: row.description,
      usage: row.usage,
      skill_name: row.skill_name ?? null,
      cover_url: catalogMediaUrl(coverMediaPath),
      sample_image_urls: sampleImageUrls
    });
  }

  function loraCatalogItem(row, { coverMediaPath, sampleImageUrls }) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({
      id: row.id,
      base_model_id: row.base_model_id,
      model_id: row.model_id,
      file_name: row.file_name,
      file_format: row.file_format,
      precision_or_quantization: row.precision_or_quantization,
      author: row.author ?? null,
      version: row.version ?? null,
      description: row.description,
      usage: row.usage,
      trigger_words_json: parseCatalogJson(row.trigger_words_json),
      weight: row.weight,
      cover_url: catalogMediaUrl(coverMediaPath),
      sample_image_urls: sampleImageUrls
    });
  }

  function comfyuiInstanceCatalogItem(row) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({ id: row.id, title: row.title });
  }

  function comfyuiTemplateCatalogItem(row, { coverMediaPath, sampleImageUrls }) {
    if (row === null || typeof row !== 'object') {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({
      id: row.id,
      base_model_id: row.base_model_id,
      model_id: row.model_id,
      lora_id: row.lora_id ?? null,
      template_type: row.template_type,
      title: row.title,
      cover_url: catalogMediaUrl(coverMediaPath),
      sample_image_urls: sampleImageUrls,
      workflow_json: parseCatalogJson(row.workflow_json)
    });
  }

  function catalogPage(results, page, pageSize, totalCount) {
    if (!Array.isArray(results) || results.length > CATALOG_PAGE_MAX_ITEMS) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return Object.freeze({
      status: 'ok',
      message: null,
      results: Object.freeze(results),
      page,
      page_size: pageSize,
      total_count: totalCount
    });
  }

  function catalogCoverMediaPath(catalogType, row) {
    if (catalogType === 'artist_prompt_string' && row.cover_media_path === undefined && row.id !== undefined
      && typeof repository.getCatalogArtistPromptString === 'function') {
      return repository.getCatalogArtistPromptString(row.id)?.cover_media_path ?? null;
    }
    return row.cover_media_path ?? null;
  }

  function projectCatalogItems(catalogType, rows, projectItem) {
    if (!Object.hasOwn(CATALOG_IMAGE_OWNER_KIND, catalogType) || !Array.isArray(rows)) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    const ownerKind = CATALOG_IMAGE_OWNER_KIND[catalogType];
    const coverMediaPathByOwner = new Map(rows.map((row) => [row.id, catalogCoverMediaPath(catalogType, row)]));
    const images = ownerKind === null || rows.length === 0
      ? []
      : repository.listCatalogImagesByOwners(ownerKind, rows.map(({ id }) => id));
    const imagesByOwner = new Map();
    for (const image of images) {
      const ownerImages = imagesByOwner.get(image.owner_id) ?? [];
      ownerImages.push(image);
      imagesByOwner.set(image.owner_id, ownerImages);
    }
    return rows.map((row) => {
      const coverMediaPath = coverMediaPathByOwner.get(row.id);
      const sampleImageUrls = [];
      const seenUrls = new Set();
      for (const image of imagesByOwner.get(row.id) ?? []) {
        if (image.media_path === coverMediaPath) continue;
        const imageUrl = catalogMediaUrl(image.media_path);
        if (seenUrls.has(imageUrl)) continue;
        seenUrls.add(imageUrl);
        sampleImageUrls.push(imageUrl);
      }
      return projectItem(row, Object.freeze({
        coverMediaPath,
        sampleImageUrls: Object.freeze(sampleImageUrls)
      }));
    });
  }

  function querySemanticBaseModelsForSkill(input) {
    const request = catalogRequest(input);
    if (request.mode === 'resolve') {
      const row = repository.getCatalogBaseModel(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      return catalogPage([catalogItem(row)], 1, 1, 1);
    }
    const page = repository.listCatalogBaseModels(request);
    return catalogPage(page.rows.map(catalogItem), request.page, request.page_size, page.total_count);
  }

  function querySemanticGenerationModelsForSkill(input) {
    const request = catalogRequest(input, { allowedSearchFields: ['base_model_id'] });
    if (request.mode === 'resolve') {
      const row = repository.getCatalogGenerationModel(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      return catalogPage(projectCatalogItems('generation_model', [row], generationModelCatalogItem), 1, 1, 1);
    }
    if (request.base_model_id !== undefined && !repository.getCatalogBaseModel(request.base_model_id)) {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID);
    }
    const page = repository.listCatalogGenerationModels(request);
    return catalogPage(projectCatalogItems('generation_model', page.rows, generationModelCatalogItem), request.page, request.page_size, page.total_count);
  }

  async function querySemanticWorksForSkill(input) {
    const request = catalogRequest(input);
    if (request.mode === 'resolve') {
      const row = repository.getCatalogWork(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      if (row.is_available !== 1) throw new ApplicationError('CATALOG_RESOURCE_UNAVAILABLE', CATALOG_ERROR_MESSAGES.CATALOG_RESOURCE_UNAVAILABLE);
      return catalogPage(projectCatalogItems('work', [row], workCatalogItem), 1, 1, 1);
    }
    if (request.query === '') {
      const page = repository.listCatalogWorks(request);
      return catalogPage(projectCatalogItems('work', page.rows, workCatalogItem), request.page, request.page_size, page.total_count);
    }
    if (workSemanticService === null || typeof workSemanticService.searchCatalog !== 'function') {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', 'Catalog semantic index is not ready.');
    }
    const page = await workSemanticService.searchCatalog(request);
    if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.total_count) || page.total_count < 0) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return catalogPage(projectCatalogItems('work', page.rows, workCatalogItem), request.page, request.page_size, page.total_count);
  }

  async function querySemanticCharactersForSkill(input) {
    const request = catalogRequest(input, { allowedSearchFields: ['work_id'] });
    if (request.mode === 'resolve') {
      const row = repository.getCatalogCharacter(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      if (row.is_available !== 1 || row.work_is_available !== 1) {
        throw new ApplicationError('CATALOG_RESOURCE_UNAVAILABLE', CATALOG_ERROR_MESSAGES.CATALOG_RESOURCE_UNAVAILABLE);
      }
      return catalogPage(projectCatalogItems('character', [row], characterCatalogItem), 1, 1, 1);
    }
    if (request.work_id !== undefined && !repository.getCatalogWork(request.work_id)) {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID);
    }
    if (request.query === '') {
      const page = repository.listCatalogCharacters(request);
      return catalogPage(projectCatalogItems('character', page.rows, characterCatalogItem), request.page, request.page_size, page.total_count);
    }
    if (characterSemanticService === null || typeof characterSemanticService.searchCatalog !== 'function') {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', CATALOG_ERROR_MESSAGES.CATALOG_INDEX_NOT_READY);
    }
    const page = await characterSemanticService.searchCatalog(request);
    if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.total_count) || page.total_count < 0) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return catalogPage(projectCatalogItems('character', page.rows, characterCatalogItem), request.page, request.page_size, page.total_count);
  }

  async function querySemanticStylesForSkill(input) {
    const request = catalogRequest(input, { allowedSearchFields: ['base_model_id'] });
    if (request.mode === 'resolve') {
      const row = repository.getCatalogStyle(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      return catalogPage(projectCatalogItems('style', [row], styleCatalogItem), 1, 1, 1);
    }
    if (request.base_model_id !== undefined && !repository.getCatalogBaseModel(request.base_model_id)) {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID);
    }
    if (request.query === '') {
      const page = repository.listCatalogStyles(request);
      return catalogPage(projectCatalogItems('style', page.rows, styleCatalogItem), request.page, request.page_size, page.total_count);
    }
    if (styleSemanticService === null || typeof styleSemanticService.searchCatalog !== 'function') {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', CATALOG_ERROR_MESSAGES.CATALOG_INDEX_NOT_READY);
    }
    const page = await styleSemanticService.searchCatalog(request);
    if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.total_count) || page.total_count < 0) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return catalogPage(projectCatalogItems('style', page.rows, styleCatalogItem), request.page, request.page_size, page.total_count);
  }

  async function querySemanticPromptTermsForSkill(input) {
    const request = catalogRequest(input);
    if (request.mode === 'resolve') {
      const row = repository.getCatalogPromptTerm(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      return catalogPage(projectCatalogItems('prompt_term', [row], promptTermCatalogItem), 1, 1, 1);
    }
    if (request.query === '') {
      const page = repository.listCatalogPromptTerms(request);
      return catalogPage(projectCatalogItems('prompt_term', page.rows, promptTermCatalogItem), request.page, request.page_size, page.total_count);
    }
    if (promptTermSemanticService === null || typeof promptTermSemanticService.searchCatalog !== 'function') {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', CATALOG_ERROR_MESSAGES.CATALOG_INDEX_NOT_READY);
    }
    const page = await promptTermSemanticService.searchCatalog(request);
    if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.total_count) || page.total_count < 0) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return catalogPage(projectCatalogItems('prompt_term', page.rows, promptTermCatalogItem), request.page, request.page_size, page.total_count);
  }

  async function querySemanticArtistPromptStringsForSkill(input) {
    const request = catalogRequest(input, { allowedSearchFields: ['base_model_id'] });
    if (request.mode === 'resolve') {
      const row = repository.getCatalogArtistPromptString(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      return catalogPage(projectCatalogItems('artist_prompt_string', [row], artistPromptStringCatalogItem), 1, 1, 1);
    }
    if (request.base_model_id !== undefined && !repository.getCatalogBaseModel(request.base_model_id)) {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID);
    }
    if (request.query === '') {
      const page = repository.listCatalogArtistPromptStrings(request);
      return catalogPage(projectCatalogItems('artist_prompt_string', page.rows, artistPromptStringCatalogItem), request.page, request.page_size, page.total_count);
    }
    if (artistPromptStringSemanticService === null || typeof artistPromptStringSemanticService.searchCatalog !== 'function') {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', CATALOG_ERROR_MESSAGES.CATALOG_INDEX_NOT_READY);
    }
    const page = await artistPromptStringSemanticService.searchCatalog(request);
    if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.total_count) || page.total_count < 0) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return catalogPage(projectCatalogItems('artist_prompt_string', page.rows, artistPromptStringCatalogItem), request.page, request.page_size, page.total_count);
  }

  async function querySemanticLorasForSkill(input) {
    const request = catalogRequest(input, { allowedSearchFields: ['base_model_id'] });
    if (request.mode === 'resolve') {
      const row = repository.getCatalogLora(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      return catalogPage(projectCatalogItems('lora', [row], loraCatalogItem), 1, 1, 1);
    }
    if (request.base_model_id !== undefined && !repository.getCatalogBaseModel(request.base_model_id)) {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID);
    }
    if (request.query === '') {
      const page = repository.listCatalogLoras(request);
      return catalogPage(projectCatalogItems('lora', page.rows, loraCatalogItem), request.page, request.page_size, page.total_count);
    }
    if (generationLoraSemanticService === null || typeof generationLoraSemanticService.searchCatalog !== 'function') {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', CATALOG_ERROR_MESSAGES.CATALOG_INDEX_NOT_READY);
    }
    const page = await generationLoraSemanticService.searchCatalog(request);
    if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.total_count) || page.total_count < 0) {
      throw new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
    }
    return catalogPage(projectCatalogItems('lora', page.rows, loraCatalogItem), request.page, request.page_size, page.total_count);
  }

  function querySemanticComfyuiInstancesForSkill(input) {
    const request = catalogRequest(input);
    if (request.mode === 'resolve') {
      const row = repository.getCatalogComfyuiInstance(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      return catalogPage([comfyuiInstanceCatalogItem(row)], 1, 1, 1);
    }
    const page = repository.listCatalogComfyuiInstances(request);
    return catalogPage(page.rows.map(comfyuiInstanceCatalogItem), request.page, request.page_size, page.total_count);
  }

  function querySemanticComfyuiTemplatesForSkill(input) {
    const request = catalogRequest(input, { allowedSearchFields: ['base_model_id'] });
    if (request.mode === 'resolve') {
      const row = repository.getCatalogComfyuiTemplate(request.id);
      if (!row) throw new ApplicationError('CATALOG_REF_NOT_FOUND', CATALOG_ERROR_MESSAGES.CATALOG_REF_NOT_FOUND);
      if (row.workflow_json === null) {
        throw new ApplicationError('CATALOG_RESOURCE_UNAVAILABLE', CATALOG_ERROR_MESSAGES.CATALOG_RESOURCE_UNAVAILABLE);
      }
      return catalogPage(projectCatalogItems('comfyui_template', [row], comfyuiTemplateCatalogItem), 1, 1, 1);
    }
    if (request.base_model_id !== undefined && !repository.getCatalogBaseModel(request.base_model_id)) {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID);
    }
    const page = repository.listCatalogComfyuiTemplates(request);
    return catalogPage(projectCatalogItems('comfyui_template', page.rows, comfyuiTemplateCatalogItem), request.page, request.page_size, page.total_count);
  }

  return Object.freeze({
    listWorks: () => repository.listWorks(),
    getWork(workId) {
      assertIdentifier(workId, 'work_id');
      const work = repository.getWork(workId);
      if (!work) throw new ApplicationError('NOT_FOUND', 'work was not found');
      return work;
    },
    listWorkCharacters(workId) {
      assertIdentifier(workId, 'work_id');
      if (!repository.getWork(workId)) throw new ApplicationError('NOT_FOUND', 'work was not found');
      return repository.listWorkCharacters(workId);
    },
    listCharacters: () => repository.listCharacters(),
    getCharacter(characterId) {
      assertIdentifier(characterId, 'character_id');
      const character = repository.getCharacter(characterId);
      if (!character) throw new ApplicationError('NOT_FOUND', 'character was not found');
      return character;
    },
    listStyles: () => repository.listStyles(),
    listPublicCatalog(kind, input) {
      const query = validateHomeCatalogQuery(kind, input);
      if (query.workId !== null && !repository.getWork(query.workId)) throw new ApplicationError('NOT_FOUND', 'work was not found');
      return repository.listPublicCatalog(query);
    },
    getStyle(styleId) {
      assertIdentifier(styleId, 'style_id');
      const style = repository.getStyle(styleId);
      if (!style) throw new ApplicationError('NOT_FOUND', 'style was not found');
      return style;
    },
    searchCatalog(query) {
      const normalized = assertSearchQuery(query);
      return repository.searchPublic(normalized).map((item) => {
        if (item.kind === 'work') return { kind: item.kind, id: item.id, name: item.name };
        return { kind: item.kind, id: item.id, name: item.name, work_name: item.work_name ?? null };
      });
    },
    querySemanticBaseModelsForSkill,
    querySemanticGenerationModelsForSkill,
    querySemanticLorasForSkill,
    querySemanticWorksForSkill,
    querySemanticCharactersForSkill,
    querySemanticStylesForSkill,
    querySemanticPromptTermsForSkill,
    querySemanticArtistPromptStringsForSkill,
    querySemanticComfyuiInstancesForSkill,
    querySemanticComfyuiTemplatesForSkill,
    searchSemanticWorks(input) {
      if (workSemanticService === null) throw new ApplicationError('VECTOR_INDEX_NOT_READY', 'work vector index is not ready');
      return workSemanticService.searchPublic(input);
    },
    searchSemanticCharacters(input) {
      if (characterSemanticService === null) throw new ApplicationError('VECTOR_INDEX_NOT_READY', 'character vector index is not ready');
      return characterSemanticService.searchPublic(input);
    },
    searchSemanticStyles(input) {
      if (styleSemanticService === null) throw new ApplicationError('INTERNAL_ERROR', 'style semantic service is not configured');
      return styleSemanticService.searchPublic(input);
    },
    searchSemanticPromptTerms(input) {
      if (promptTermSemanticService === null) throw new ApplicationError('VECTOR_INDEX_NOT_READY', 'prompt term vector index is not ready');
      return promptTermSemanticService.searchPublic(input);
    },
    listManageItems(input) {
      return repository.listManageItems(validateManageQuery(input));
    },
    getManageItemDetail(kind, itemId) {
      assertItemKind(kind, { allowWork: true });
      assertIdentifier(itemId, 'item_id');
      const detail = repository.getManageItemDetail(kind, itemId);
      if (!detail) throw new ApplicationError('NOT_FOUND', `${kind} was not found`);
      return detail;
    }
  });
}
