import { PROMPT_TERM_CATEGORY_CODES } from '../prompt-terms/prompt-term-categories.mjs';

export class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputValidationError';
  }
}

function fail(message) {
  throw new InputValidationError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} contains an unknown field: ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  }
}

const MODEL_RELEASE_URL_PATTERN = /^https?:\/\/(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}|(?=[A-Za-z0-9.-]{1,253}(?::(?:0|[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?(?:[/?#]|$))(?!(?:(?:\d+|0[xX][0-9A-Fa-f]+)\.)*(?:\d+|0[xX][0-9A-Fa-f]+)(?::(?:0|[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?(?:[/?#]|$))[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::(?:0|[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?(?:[/?#](?:[A-Za-z0-9._~:/?#@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*)?$/u;
const FILE_ATTRIBUTE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const FILE_ATTRIBUTE_MAX_LENGTH = 64;
const PROMPT_TERM_CATEGORY_CODE_SET = new Set(PROMPT_TERM_CATEGORY_CODES);
const COMFYUI_CREDENTIAL_TYPES = Object.freeze(['none', 'http_basic', 'bearer']);
const COMFYUI_TEMPLATE_TYPES = Object.freeze(['text_to_image', 'text_to_image_lora', 'text_to_image_hires_fix', 'text_to_image_second_pass', 'text_to_video', 'image_to_image', 'image_to_video', 'video_to_video', 'style_transfer', 'controlnet', 'inpainting', 'outpainting', 'upscale', 'face_detailer', 'other']);

function assertGenerationResourceFileAttribute(value, label) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > FILE_ATTRIBUTE_MAX_LENGTH
    || value !== value.trim()
    || FILE_ATTRIBUTE_CONTROL_PATTERN.test(value)) {
    fail(`${label} must contain 1 to ${FILE_ATTRIBUTE_MAX_LENGTH} UTF-16 code units without leading whitespace, trailing whitespace or control characters`);
  }
  return value;
}

export function assertIdentifier(value, label = 'identifier') {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

export function assertRequestId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    fail('request_id must contain 1 to 128 UTF-16 code units');
  }
  return value;
}

export function normalizeSearchText(value) {
  if (typeof value !== 'string') fail('search text must be a string');
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

export function normalizeCatalogText(value) {
  return typeof value === 'string' ? normalizeSearchText(value) : '';
}

export function assertSearchQuery(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
    fail('query must contain 1 to 100 UTF-16 code units');
  }
  const normalized = normalizeSearchText(value);
  if (normalized.length === 0) fail('query must contain non-whitespace text');
  return normalized;
}

export function assertBaseModelName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0 || value !== value.trim()) {
    fail('base_model_name must be a non-empty string without leading or trailing whitespace');
  }
  return value;
}

export function validateSemanticQueryRequest(value, { requireBaseModelName = false, preserveQueryText = false } = {}) {
  if (!isPlainObject(value)) fail('semantic request must be an object');
  const allowed = new Set(['queries', 'limit', ...(requireBaseModelName ? ['base_model_name'] : [])]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`semantic request contains an unknown field: ${key}`);
  }
  if (!Object.hasOwn(value, 'queries')) fail('semantic request is missing queries');
  if (requireBaseModelName && !Object.hasOwn(value, 'base_model_name')) fail('semantic request is missing base_model_name');
  if (!Array.isArray(value.queries) || value.queries.length < 1 || value.queries.length > 3) {
    fail('queries must contain 1 to 3 entries');
  }
  const limit = Object.hasOwn(value, 'limit') ? value.limit : 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    fail('limit must be an integer from 1 to 20');
  }
  return Object.freeze({
    ...(requireBaseModelName ? { base_model_name: assertBaseModelName(value.base_model_name) } : {}),
    queries: Object.freeze(value.queries.map((query) => {
      const normalized = assertSearchQuery(query);
      return preserveQueryText ? query : normalized;
    })),
    limit
  });
}

function validateSemanticResourceQueryRequest(value, extraKey, extraLabel) {
  if (!isPlainObject(value)) fail('semantic request must be an object');
  const allowed = new Set(['base_model_name', 'queries', 'limit', extraKey]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`semantic request contains an unknown field: ${key}`);
  }
  const normalized = validateSemanticQueryRequest({
    base_model_name: value.base_model_name,
    queries: value.queries,
    ...(Object.hasOwn(value, 'limit') ? { limit: value.limit } : {})
  }, { requireBaseModelName: true, preserveQueryText: true });
  return Object.freeze({
    ...normalized,
    ...(Object.hasOwn(value, extraKey) ? { [extraKey]: assertIdentifier(value[extraKey], extraLabel) } : {})
  });
}

export function validateSemanticGenerationLorasInternalRequest(value) {
  return validateSemanticResourceQueryRequest(value, 'model_id', 'model_id');
}

export function validateSemanticArtistPromptStringsInternalRequest(value) {
  return validateSemanticResourceQueryRequest(value, 'style_id', 'style_id');
}

const CATALOG_STABLE_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;

function assertCatalogStableId(value, label) {
  if (typeof value !== 'string' || !CATALOG_STABLE_ID_PATTERN.test(value)) {
    fail(`${label} must be a stable positive integer string`);
  }
  return value;
}

export function validateCatalogRequest(value, { allowedSearchFields = [] } = {}) {
  if (!isPlainObject(value)) fail('catalog request must be an object');
  if (!Array.isArray(allowedSearchFields) || allowedSearchFields.some((field) => typeof field !== 'string' || field.length === 0)) {
    throw new TypeError('allowedSearchFields must contain non-empty strings');
  }
  if (value.mode === 'search') {
    const allowed = new Set(['mode', 'query', 'page', 'page_size', ...allowedSearchFields]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`catalog search request contains an unknown field: ${key}`);
    const query = value.query === undefined ? '' : value.query;
    if (typeof query !== 'string' || query.length > 200) fail('catalog query must contain 0 to 200 UTF-16 code units');
    const page = value.page === undefined ? 1 : value.page;
    const pageSize = value.page_size === undefined ? 20 : value.page_size;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) fail('catalog page must be an integer from 1 to 100000');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('catalog page_size must be an integer from 1 to 100');
    const filters = Object.fromEntries(allowedSearchFields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, assertCatalogStableId(value[field], field)]));
    return Object.freeze({ mode: 'search', query: normalizeSearchText(query), page, page_size: pageSize, ...filters });
  }
  if (value.mode === 'resolve') {
    const allowed = new Set(['mode', 'id']);
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`catalog resolve request contains an unknown field: ${key}`);
    if (!Object.hasOwn(value, 'id')) fail('catalog resolve request is missing id');
    return Object.freeze({ mode: 'resolve', id: assertCatalogStableId(value.id, 'id') });
  }
  fail('catalog request mode must be search or resolve');
}

export function assertItemKind(value, { allowWork = false } = {}) {
  const allowed = allowWork ? new Set(['work', 'character', 'style']) : new Set(['character', 'style']);
  if (typeof value !== 'string' || !allowed.has(value)) {
    fail(`kind must be one of ${[...allowed].join(', ')}`);
  }
  return value;
}

export function assertMediaOwnerKind(value) {
  const allowed = new Set(['work', 'character', 'style', 'model', 'lora', 'artist_prompt_string', 'template']);
  if (typeof value !== 'string' || !allowed.has(value)) {
    fail(`owner_kind must be one of ${[...allowed].join(', ')}`);
  }
  return value;
}

export function validateImageOrder(value) {
  assertExactKeys(value, ['ids'], 'image order');
  if (!Array.isArray(value.ids) || value.ids.length < 1) fail('ids must contain at least 1 entry');
  const ids = value.ids.map((id, index) => assertIdentifier(id, `ids[${index}]`));
  if (new Set(ids).size !== ids.length) fail('ids must not contain duplicates');
  return Object.freeze({ ids: Object.freeze(ids) });
}

export function validateCoverSelection(value) {
  assertExactKeys(value, ['id'], 'cover selection');
  if (value.id !== null) assertIdentifier(value.id, 'id');
  return Object.freeze({ id: value.id });
}

export function validateBaseModelWrite(value) {
  assertExactKeys(value, ['name'], 'base model write');
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    fail('base model name must contain non-whitespace text');
  }
  return Object.freeze({ name: value.name.trim() });
}

function validateCatalogManagementText(value, label, { nullable = false, maximum = 10_000 } = {}) {
  if (nullable && (value === null || value === '')) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || FILE_ATTRIBUTE_CONTROL_PATTERN.test(value)) {
    fail(`${label} must contain 1 to ${maximum} UTF-16 code units without control characters`);
  }
  return value.trim();
}

function validateCatalogManagementAliases(value, label) {
  if (!Array.isArray(value) || value.length > 100) fail(`${label} must be an array with at most 100 entries`);
  const result = value.map((entry, index) => validateCatalogManagementText(entry, `${label}[${index}]`, { maximum: 200 }));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates after trimming`);
  return Object.freeze(result);
}

export function validateCatalogManagementWrite(kind, value) {
  assertItemKind(kind, { allowWork: true });
  const keys = kind === 'work'
    ? ['name', 'category_name', 'aliases_json', 'is_available']
    : kind === 'character'
      ? ['work_id', 'name', 'aliases_json', 'prompt_text', 'is_available']
      : ['base_model_id', 'name', 'aliases_json', 'prompt_text', 'style_description'];
  assertExactKeys(value, keys, `${kind} management write`);
  const common = {
    name: validateCatalogManagementText(value.name, `${kind} name`, { maximum: 200 }),
    aliases_json: validateCatalogManagementAliases(value.aliases_json, `${kind} aliases_json`)
  };
  if (kind === 'work') {
    if (typeof value.is_available !== 'boolean') fail('work is_available must be a boolean');
    return Object.freeze({
      ...common,
      category_name: validateCatalogManagementText(value.category_name, 'work category_name', { nullable: true, maximum: 200 }),
      is_available: value.is_available
    });
  }
  if (kind === 'character') {
    if (typeof value.is_available !== 'boolean') fail('character is_available must be a boolean');
    return Object.freeze({
      work_id: assertIdentifier(value.work_id, 'character work_id'),
      ...common,
      prompt_text: validateCatalogManagementText(value.prompt_text, 'character prompt_text'),
      is_available: value.is_available
    });
  }
  return Object.freeze({
    base_model_id: assertIdentifier(value.base_model_id, 'style base_model_id'),
    ...common,
    prompt_text: validateCatalogManagementText(value.prompt_text, 'style prompt_text'),
    style_description: validateCatalogManagementText(value.style_description, 'style style_description', { nullable: true })
  });
}

export function validatePromptTermWrite(value) {
  assertExactKeys(value, ['canonical_tag', 'category', 'aliases_json', 'post_count'], 'Prompt Tag write');
  if (typeof value.canonical_tag !== 'string' || value.canonical_tag.trim().length === 0) {
    fail('Prompt Tag canonical_tag must contain non-whitespace text');
  }
  if (!PROMPT_TERM_CATEGORY_CODE_SET.has(value.category)) fail('Prompt Tag category is invalid');
  if (!Array.isArray(value.aliases_json)) fail('Prompt Tag aliases_json must be an array');
  const aliases = value.aliases_json.map((alias, index) => {
    if (typeof alias !== 'string' || alias.trim().length === 0) fail(`Prompt Tag aliases_json[${index}] must contain non-whitespace text`);
    return alias.trim();
  });
  if (new Set(aliases).size !== aliases.length) fail('Prompt Tag aliases_json must not contain duplicates after trimming');
  if (!Number.isSafeInteger(value.post_count) || value.post_count < 0) fail('Prompt Tag post_count must be a non-negative safe integer');
  return Object.freeze({
    canonical_tag: value.canonical_tag.trim(),
    category: value.category,
    aliases_json: Object.freeze(aliases),
    post_count: value.post_count
  });
}

export function validatePromptTermListQuery(value = {}) {
  if (!isPlainObject(value)) fail('Prompt Tag list query must be an object');
  const allowed = new Set(['page', 'page_size', 'q', 'category', 'post_count_min', 'post_count_max']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Prompt Tag list query contains an unknown parameter: ${key}`);
  const page = value.page === undefined ? 1 : value.page;
  const pageSize = value.page_size === undefined ? 16 : value.page_size;
  const q = value.q === undefined ? '' : value.q;
  if (!Number.isSafeInteger(page) || page < 1) fail('Prompt Tag page must be a positive integer');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('Prompt Tag page_size must be an integer from 1 to 100');
  if (typeof q !== 'string' || q.length > 100) fail('Prompt Tag q must contain 0 to 100 UTF-16 code units');
  if (value.category !== undefined && !PROMPT_TERM_CATEGORY_CODE_SET.has(value.category)) fail('Prompt Tag category is invalid');
  for (const key of ['post_count_min', 'post_count_max']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) fail(`Prompt Tag ${key} must be a non-negative safe integer`);
  }
  if (value.post_count_min !== undefined && value.post_count_max !== undefined && value.post_count_min > value.post_count_max) {
    fail('Prompt Tag post_count_min must not exceed post_count_max');
  }
  return Object.freeze({
    page,
    page_size: pageSize,
    q: normalizeSearchText(q),
    category: value.category,
    post_count_min: value.post_count_min,
    post_count_max: value.post_count_max
  });
}

export function validateModelWrite(value) {
  const required = ['base_model_id', 'file_name', 'file_format', 'precision_or_quantization', 'description', 'usage'];
  const optional = ['author', 'version', 'release_url', 'published_at', 'skill_name'];
  if (!isPlainObject(value)) fail('model write must be an object');
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`model write contains an unknown field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`model write is missing ${key}`);
  }
  assertIdentifier(value.base_model_id, 'base_model_id');
  for (const key of ['file_name', 'description', 'usage']) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) fail(`model ${key} must be a non-empty string`);
  }
  assertGenerationResourceFileAttribute(value.file_format, 'model file_format');
  assertGenerationResourceFileAttribute(value.precision_or_quantization, 'model precision_or_quantization');
  for (const key of ['author', 'version', 'skill_name']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') fail(`model ${key} must be a string or null`);
  }
  if (value.release_url !== undefined && value.release_url !== null) {
    if (typeof value.release_url !== 'string' || !MODEL_RELEASE_URL_PATTERN.test(value.release_url)) {
      fail('model release_url must be an http or https URL');
    }
    let parsed;
    try {
      parsed = new URL(value.release_url);
    } catch {
      fail('model release_url must be an http or https URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.hostname.length === 0
      || parsed.username.length > 0
      || parsed.password.length > 0) {
      fail('model release_url must be an http or https URL');
    }
  }
  if (value.published_at !== undefined && value.published_at !== null) {
    if (typeof value.published_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.published_at) || Number.isNaN(Date.parse(`${value.published_at}T00:00:00.000Z`))) fail('model published_at must be an ISO date or null');
    if (new Date(`${value.published_at}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.published_at) fail('model published_at must be an ISO date or null');
  }
  return Object.freeze({
    base_model_id: value.base_model_id,
    file_name: value.file_name.trim(),
    file_format: value.file_format,
    precision_or_quantization: value.precision_or_quantization,
    author: value.author ?? null,
    version: value.version ?? null,
    release_url: value.release_url ?? null,
    published_at: value.published_at ?? null,
    description: value.description.trim(),
    usage: value.usage.trim(),
    skill_name: value.skill_name ?? null
  });
}

export function validateModelListQuery(value = {}) {
  if (!isPlainObject(value)) fail('model list query must be an object');
  for (const key of Object.keys(value)) {
    if (!['page', 'page_size', 'q', 'base_model_id', 'file_format', 'precision_or_quantization'].includes(key)) fail(`model list query contains an unknown parameter: ${key}`);
  }
  const page = value.page === undefined ? 1 : value.page;
  const pageSize = value.page_size === undefined ? 16 : value.page_size;
  const q = value.q === undefined ? '' : value.q;
  if (!Number.isSafeInteger(page) || page < 1) fail('model page must be a positive integer');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('model page_size must be an integer from 1 to 100');
  if (typeof q !== 'string' || q.length > 100) fail('model q must contain 0 to 100 UTF-16 code units');
  if (value.base_model_id !== undefined) assertIdentifier(value.base_model_id, 'base_model_id');
  if (value.file_format !== undefined) assertGenerationResourceFileAttribute(value.file_format, 'model file_format filter');
  if (value.precision_or_quantization !== undefined) assertGenerationResourceFileAttribute(value.precision_or_quantization, 'model precision_or_quantization filter');
  return Object.freeze({
    page,
    page_size: pageSize,
    q: normalizeSearchText(q),
    base_model_id: value.base_model_id,
    file_format: value.file_format,
    precision_or_quantization: value.precision_or_quantization
  });
}

export function validateLoraWrite(value) {
  const required = ['base_model_id', 'model_id', 'file_name', 'file_format', 'precision_or_quantization', 'description', 'usage', 'trigger_words', 'weight'];
  const optional = ['author', 'version', 'release_url'];
  if (!isPlainObject(value)) fail('lora write must be an object');
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`lora write contains an unknown field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`lora write is missing ${key}`);
  }
  assertIdentifier(value.base_model_id, 'base_model_id');
  assertIdentifier(value.model_id, 'model_id');
  for (const key of ['file_name', 'description', 'usage']) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) fail(`lora ${key} must be a non-empty string`);
  }
  assertGenerationResourceFileAttribute(value.file_format, 'lora file_format');
  assertGenerationResourceFileAttribute(value.precision_or_quantization, 'lora precision_or_quantization');
  if (!Array.isArray(value.trigger_words)) fail('lora trigger_words must be an array');
  const triggerWords = value.trigger_words.map((triggerWord, index) => {
    if (typeof triggerWord !== 'string' || triggerWord.trim().length === 0) fail(`lora trigger_words[${index}] must be a non-empty string`);
    return triggerWord.trim();
  });
  if (new Set(triggerWords).size !== triggerWords.length) fail('lora trigger_words must not contain duplicates after trimming');
  if (typeof value.weight !== 'number' || !Number.isFinite(value.weight)) fail('lora weight must be a finite number');
  for (const key of ['author', 'version']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') fail(`lora ${key} must be a string or null`);
  }
  if (value.release_url !== undefined && value.release_url !== null) {
    if (typeof value.release_url !== 'string' || !MODEL_RELEASE_URL_PATTERN.test(value.release_url)) fail('lora release_url must be an http or https URL');
    let parsed;
    try {
      parsed = new URL(value.release_url);
    } catch {
      fail('lora release_url must be an http or https URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) {
      fail('lora release_url must be an http or https URL');
    }
  }
  return Object.freeze({
    base_model_id: value.base_model_id,
    model_id: value.model_id,
    file_name: value.file_name.trim(),
    file_format: value.file_format,
    precision_or_quantization: value.precision_or_quantization,
    author: value.author ?? null,
    version: value.version ?? null,
    release_url: value.release_url ?? null,
    description: value.description.trim(),
    usage: value.usage.trim(),
    trigger_words: Object.freeze(triggerWords),
    weight: value.weight
  });
}

export function validateLoraListQuery(value = {}) {
  if (!isPlainObject(value)) fail('lora list query must be an object');
  for (const key of Object.keys(value)) {
    if (!['page', 'page_size', 'q', 'base_model_id', 'model_id', 'file_format', 'precision_or_quantization'].includes(key)) fail(`lora list query contains an unknown parameter: ${key}`);
  }
  const page = value.page === undefined ? 1 : value.page;
  const pageSize = value.page_size === undefined ? 16 : value.page_size;
  const q = value.q === undefined ? '' : value.q;
  if (!Number.isSafeInteger(page) || page < 1) fail('lora page must be a positive integer');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('lora page_size must be an integer from 1 to 100');
  if (typeof q !== 'string' || q.length > 100) fail('lora q must contain 0 to 100 UTF-16 code units');
  if (value.base_model_id !== undefined) assertIdentifier(value.base_model_id, 'base_model_id');
  if (value.model_id !== undefined) assertIdentifier(value.model_id, 'model_id');
  if (value.file_format !== undefined) assertGenerationResourceFileAttribute(value.file_format, 'lora file_format filter');
  if (value.precision_or_quantization !== undefined) assertGenerationResourceFileAttribute(value.precision_or_quantization, 'lora precision_or_quantization filter');
  return Object.freeze({
    page,
    page_size: pageSize,
    q: normalizeSearchText(q),
    base_model_id: value.base_model_id,
    model_id: value.model_id,
    file_format: value.file_format,
    precision_or_quantization: value.precision_or_quantization
  });
}

export function validateArtistPromptStringWrite(value) {
  assertExactKeys(value, ['title', 'description', 'artist_string', 'base_model_id', 'style_ids'], 'artist prompt string write');
  for (const key of ['title', 'description', 'artist_string']) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) fail(`artist prompt string ${key} must be a non-empty string`);
  }
  if ([...value.title.trim()].length > 20) fail('artist prompt string title must contain at most 20 Unicode code points');
  if (value.base_model_id !== null) assertIdentifier(value.base_model_id, 'base_model_id');
  if (!Array.isArray(value.style_ids)) fail('artist prompt string style_ids must be an array');
  const styleIds = value.style_ids.map((styleId, index) => assertIdentifier(styleId, `style_ids[${index}]`));
  if (new Set(styleIds).size !== styleIds.length) fail('artist prompt string style_ids must not contain duplicates');
  return Object.freeze({
    title: value.title.trim(),
    description: value.description.trim(),
    artist_string: value.artist_string.trim(),
    base_model_id: value.base_model_id,
    style_ids: Object.freeze(styleIds)
  });
}

export function validateArtistPromptStringListQuery(value = {}) {
  if (!isPlainObject(value)) fail('artist prompt string list query must be an object');
  for (const key of Object.keys(value)) {
    if (!['page', 'page_size', 'q', 'base_model_id', 'style_id'].includes(key)) fail(`artist prompt string list query contains an unknown parameter: ${key}`);
  }
  const page = value.page === undefined ? 1 : value.page;
  const pageSize = value.page_size === undefined ? 16 : value.page_size;
  const q = value.q === undefined ? '' : value.q;
  if (!Number.isSafeInteger(page) || page < 1) fail('artist prompt string page must be a positive integer');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('artist prompt string page_size must be an integer from 1 to 100');
  if (typeof q !== 'string' || q.length > 100) fail('artist prompt string q must contain 0 to 100 UTF-16 code units');
  if (value.base_model_id !== undefined) assertIdentifier(value.base_model_id, 'base_model_id');
  if (value.style_id !== undefined) assertIdentifier(value.style_id, 'style_id');
  return Object.freeze({ page, page_size: pageSize, q: normalizeSearchText(q), base_model_id: value.base_model_id, style_id: value.style_id });
}

function assertComfyuiUrl(value) {
  if (typeof value !== 'string' || value.length === 0) fail('ComfyUI instance url must be an HTTP or HTTPS URL');
  let parsed;
  try { parsed = new URL(value); } catch { fail('ComfyUI instance url must be an HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    fail('ComfyUI instance url must be an HTTP or HTTPS URL');
  }
  return value;
}

function validateComfyuiCredential(value, { creating }) {
  if (!isPlainObject(value)) fail('ComfyUI instance credential must be an object');
  if (value.type === 'none') {
    assertExactKeys(value, ['type'], 'ComfyUI instance credential');
    return Object.freeze({ type: 'none' });
  }
  if (value.action === 'keep') {
    if (creating) fail('ComfyUI instance credential keep is unavailable when creating an instance');
    assertExactKeys(value, ['action'], 'ComfyUI instance credential');
    return Object.freeze({ action: 'keep' });
  }
  if (value.action === 'clear') {
    assertExactKeys(value, ['action'], 'ComfyUI instance credential');
    return Object.freeze({ action: 'clear', type: 'none' });
  }
  if (value.action !== 'replace') fail('ComfyUI instance credential action is invalid');
  if (value.type === 'http_basic') {
    assertExactKeys(value, ['action', 'type', 'username', 'password'], 'ComfyUI instance credential');
    if (typeof value.username !== 'string' || value.username.length === 0 || typeof value.password !== 'string' || value.password.length === 0) {
      fail('ComfyUI HTTP Basic credential username and password must be non-empty strings');
    }
    return Object.freeze({ action: 'replace', type: 'http_basic', username: value.username, password: value.password });
  }
  if (value.type === 'bearer') {
    assertExactKeys(value, ['action', 'type', 'token'], 'ComfyUI instance credential');
    if (typeof value.token !== 'string' || value.token.length === 0) fail('ComfyUI Bearer credential token must be a non-empty string');
    return Object.freeze({ action: 'replace', type: 'bearer', token: value.token });
  }
  fail('ComfyUI instance credential type is invalid');
}

export function validateComfyuiInstanceWrite(value, { creating = false } = {}) {
  assertExactKeys(value, ['title', 'url', 'credential', 'is_enabled'], 'ComfyUI instance write');
  if (typeof value.title !== 'string' || value.title.trim().length === 0) fail('ComfyUI instance title must be a non-empty string');
  if (typeof value.is_enabled !== 'boolean') fail('ComfyUI instance is_enabled must be a boolean');
  return Object.freeze({
    title: value.title.trim(),
    url: assertComfyuiUrl(value.url),
    credential: validateComfyuiCredential(value.credential, { creating }),
    is_enabled: value.is_enabled
  });
}

export function validateComfyuiInstanceListQuery(value = {}) {
  if (!isPlainObject(value)) fail('ComfyUI instance list query must be an object');
  const keys = ['page', 'page_size', 'q', 'credential_type', 'is_valid', 'is_enabled'];
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`ComfyUI instance list query contains an unknown parameter: ${key}`);
  }
  const page = value.page === undefined ? 1 : value.page;
  const pageSize = value.page_size === undefined ? 16 : value.page_size;
  const q = value.q === undefined ? '' : value.q;
  if (!Number.isSafeInteger(page) || page < 1) fail('ComfyUI instance page must be a positive integer');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('ComfyUI instance page_size must be an integer from 1 to 100');
  if (typeof q !== 'string' || q.length > 100) fail('ComfyUI instance q must contain 0 to 100 UTF-16 code units');
  if (value.credential_type !== undefined && !COMFYUI_CREDENTIAL_TYPES.includes(value.credential_type)) fail('ComfyUI instance credential_type filter is invalid');
  for (const key of ['is_valid', 'is_enabled']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`ComfyUI instance ${key} filter must be a boolean`);
  }
  return Object.freeze({
    page,
    page_size: pageSize,
    q: normalizeSearchText(q),
    credential_type: value.credential_type,
    is_valid: value.is_valid,
    is_enabled: value.is_enabled
  });
}

export function validateComfyuiTemplateWrite(value) {
  assertExactKeys(value, ['base_model_id', 'model_id', 'lora_id', 'template_type', 'title', 'template_json'], 'ComfyUI template write');
  assertIdentifier(value.base_model_id, 'base_model_id');
  assertIdentifier(value.model_id, 'model_id');
  if (value.lora_id !== null) assertIdentifier(value.lora_id, 'lora_id');
  if (!COMFYUI_TEMPLATE_TYPES.includes(value.template_type)) {
    fail('ComfyUI template template_type is invalid');
  }
  if (typeof value.title !== 'string' || value.title.trim().length === 0) fail('ComfyUI template title must be a non-empty string');
  if (!isPlainObject(value.template_json)) fail('ComfyUI template template_json must be an object');
  return Object.freeze({
    base_model_id: value.base_model_id,
    model_id: value.model_id,
    lora_id: value.lora_id,
    template_type: value.template_type,
    title: value.title.trim(),
    template_json: value.template_json
  });
}

export function validateComfyuiTemplateListQuery(value = {}) {
  if (!isPlainObject(value)) fail('ComfyUI template list query must be an object');
  for (const key of Object.keys(value)) {
    if (!['page', 'page_size', 'q', 'base_model_id', 'model_id', 'lora_id', 'template_type'].includes(key)) fail(`ComfyUI template list query contains an unknown parameter: ${key}`);
  }
  const page = value.page === undefined ? 1 : value.page;
  const pageSize = value.page_size === undefined ? 16 : value.page_size;
  const q = value.q === undefined ? '' : value.q;
  if (!Number.isSafeInteger(page) || page < 1) fail('ComfyUI template page must be a positive integer');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('ComfyUI template page_size must be an integer from 1 to 100');
  if (typeof q !== 'string' || q.length > 100) fail('ComfyUI template q must contain 0 to 100 UTF-16 code units');
  for (const key of ['base_model_id', 'model_id', 'lora_id']) {
    if (value[key] !== undefined) assertIdentifier(value[key], key);
  }
  if (value.template_type !== undefined && !COMFYUI_TEMPLATE_TYPES.includes(value.template_type)) fail('ComfyUI template template_type filter is invalid');
  return Object.freeze({
    page,
    page_size: pageSize,
    q: normalizeSearchText(q),
    base_model_id: value.base_model_id,
    model_id: value.model_id,
    lora_id: value.lora_id,
    template_type: value.template_type
  });
}

export function validateDeleteImpactConfirmation(value) {
  assertExactKeys(value, ['impact_token'], 'delete impact confirmation');
  if (typeof value.impact_token !== 'string' || value.impact_token.length === 0) {
    fail('impact_token must be a non-empty string');
  }
  return Object.freeze({ impact_token: value.impact_token });
}

export function validateBatchDelete(value) {
  assertExactKeys(value, ['items'], 'batch delete');
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) fail('items must contain 1 to 100 entries');
  const identities = value.items.map((item, index) => {
    assertExactKeys(item, ['kind', 'id'], `items[${index}]`);
    return Object.freeze({ kind: assertItemKind(item.kind, { allowWork: true }), id: assertIdentifier(item.id, `items[${index}].id`) });
  });
  const identitiesSeen = new Set();
  for (const identity of identities) {
    const key = `${identity.kind}:${identity.id}`;
    if (identitiesSeen.has(key)) fail(`items contains duplicate ${key}`);
    identitiesSeen.add(key);
  }
  return Object.freeze({ items: Object.freeze(identities) });
}
