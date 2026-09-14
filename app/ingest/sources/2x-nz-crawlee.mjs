import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ManualIngestError, resolveControlledPath } from '../manual-ingest.mjs';

import { Configuration, HttpCrawler, RequestQueue } from '@crawlee/http';

export const TWO_X_NZ_DRAW_URL = 'https://2x.nz/draw';
export const TWO_X_NZ_API_ORIGIN = 'https://api-ai.acofork.com';
export const TWO_X_NZ_ROLE_STYLE_SELECTOR = 'body > div.flex-1.flex.flex-col.min-h-0.pt-14 > div > div.flex.flex-col.h-\\[calc\\(100vh-260px\\)\\].min-h-\\[400px\\] > div.shrink-0.flex.items-center.gap-2.px-4.py-1\\.5.border-b.bg-muted\\/30 > button';
export const TWO_X_NZ_SOURCE_CONFIG = Object.freeze({
  schema_version: 1,
  source_name: '2x.nz role-style library',
  source_base_url: TWO_X_NZ_DRAW_URL,
  request: { concurrency: 1, min_delay_seconds: 3, max_delay_seconds: 3, timeout_seconds: 20, max_retries: 0, retry_wait_seconds: [30, 120], max_run_minutes: 60 }
});

const MODES = Object.freeze(['WAI', 'ANIMA']);
const LIMIT = 200;
const UNSAFE_PATTERNS = Object.freeze([
  ['CONTROL_CHARACTER', /[\u0000-\u001f\u007f-\u009f]/u],
  ['HIDDEN_CONTENT', /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/u],
  ['SCRIPT_CONTENT', /<\s*script\b|javascript\s*:/iu],
  ['HIDDEN_CONTENT', /<[^>]*\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden/iu],
  ['PAGE_INSTRUCTION', /ignore\s+(?:all|any|previous)\s+instructions|system\s+message/iu],
  ['ENCODED_CONTENT', /(?:data:[^,;]+;base64,|&#x?[0-9a-f]{2,};)/iu],
  ['CAPTCHA_DETECTED', /captcha|cloudflare|verify\s+you\s+are\s+human/iu]
]);

export class TwoXNzSourceError extends ManualIngestError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = 'TwoXNzSourceError';
  }
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceId(...parts) {
  const raw = `2x-nz:${parts.map((value) => encodeURIComponent(String(value))).join(':')}`;
  if (raw.length <= 256) return raw;
  const digest = createHash('sha256').update(raw).digest('hex');
  return `${raw.slice(0, 191)}:${digest}`;
}

function normalizeThumbnailLocalPath(value) {
  return typeof value === 'string' && value.startsWith('images/') ? value.slice('images/'.length) : value;
}

function isGeneratedThumbnailPath(value, contentHash) {
  return typeof value === 'string' && new RegExp(`^2x-nz/[a-f0-9]{32}-${contentHash}\\.img$`, 'u').test(value);
}

function twoXNzThumbnailLocalPath(contentHash) {
  if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(contentHash)) throw new TypeError('contentHash must be a SHA-256 hex digest');
  return `2x-nz/${randomBytes(16).toString('hex')}-${contentHash}.img`;
}

function timestamp(now) {
  return now().toISOString();
}

function assertText(value, field, stage = 'discover_catalog') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${field} 缺失或为空`, { stage });
  }
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function scanUntrusted(value, seen = new Set()) {
  if (typeof value === 'string') {
    for (const [code, pattern] of UNSAFE_PATTERNS) {
      if (pattern.test(value)) throw new TwoXNzSourceError(code, `2x.nz API 内容触发安全停止：${code}`, { stage: 'discover_catalog' });
    }
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) scanUntrusted(item, seen);
}

function assertExactKeys(value, allowed, label, stage = 'discover_catalog') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${label} 必须是对象`, { stage });
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${label} 包含来源契约外字段`, { stage });
  }
}

function assertSourceUrl(value, label, stage = 'discover_catalog') {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${label} 不是有效 URL`, { stage }); }
  if (parsed.origin !== TWO_X_NZ_API_ORIGIN || parsed.protocol !== 'https:') {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${label} 超出 2x.nz API 来源边界`, { stage });
  }
  return parsed;
}

function assertFinalResponseOrigin(response, sourceUrl, label, stage, options = {}) {
  if (!response?.url || response.url === sourceUrl) return;
  let finalUrl;
  try { finalUrl = new URL(response.url); } catch {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${label} 重定向后的 URL 无效`, { stage, ...options });
  }
  const originalUrl = new URL(sourceUrl);
  if (finalUrl.protocol !== originalUrl.protocol || finalUrl.origin !== originalUrl.origin) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${label} 重定向到了来源边界之外`, { stage, ...options });
  }
}

function responseHeaders(response) {
  const headers = {};
  if (response?.headers?.entries) {
    for (const [name, value] of response.headers.entries()) headers[name] = value;
  } else {
    const contentType = response?.headers?.get?.('content-type');
    if (contentType) headers['content-type'] = contentType;
  }
  return headers;
}

function categoriesUrl(mode) {
  const url = new URL('/api/library/categories', TWO_X_NZ_API_ORIGIN);
  url.searchParams.set('mode', mode);
  return url.toString();
}

function libraryUrl(mode, category, offset) {
  const url = new URL('/api/library', TWO_X_NZ_API_ORIGIN);
  url.searchParams.set('mode', mode);
  if (category !== null && category !== undefined) url.searchParams.set('category', category);
  url.searchParams.set('limit', String(LIMIT));
  url.searchParams.set('offset', String(offset));
  return url.toString();
}

function normalizeCategory(value, kind, index) {
  assertExactKeys(value, new Set(['name', 'count']), `${kind} categories[${index}]`);
  if (!Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'count')) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${kind} categories[${index}] 缺少字段`, { stage: 'discover_catalog' });
  }
  const name = assertText(value.name, `${kind} categories[${index}].name`);
  if (!Number.isInteger(value.count) || value.count < 0) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${kind} categories[${index}].count 必须是非负整数`, { stage: 'discover_catalog' });
  }
  return { name, count: value.count };
}

function normalizeCategories(value) {
  scanUntrusted(value);
  assertExactKeys(value, new Set(['characters', 'styles', 'total']), 'categories response');
  if (!Array.isArray(value.characters) || !Array.isArray(value.styles)) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', 'categories response 必须含 characters 与 styles 数组', { stage: 'discover_catalog' });
  }
  if (!Object.hasOwn(value, 'total')) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', 'categories response 缺少 total', { stage: 'discover_catalog' });
  }
  assertExactKeys(value.total, new Set(['characters', 'styles']), 'categories total');
  if (!Number.isInteger(value.total.characters) || value.total.characters < 0 || !Number.isInteger(value.total.styles) || value.total.styles < 0) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', 'categories total 必须是非负整数', { stage: 'discover_catalog' });
  }
  return {
    characters: value.characters.map((entry, index) => normalizeCategory(entry, 'characters', index)),
    styles: value.styles.map((entry, index) => normalizeCategory(entry, 'styles', index)),
    total: value.total
  };
}

function assertAvailable(value, label, pageUrl = null) {
  const unavailableStatus = new Set(['deleted', 'removed', 'unavailable', 'disabled', 'inactive', 'invalid', 'offline', 'down']);
  if (value.deleted === true || value.disabled === true || value.available === false || unavailableStatus.has(value.status)) {
    throw new TwoXNzSourceError('SOURCE_MAPPING_MISMATCH', `${label} 被来源明确标记为下架、删除或失效；已拒绝导入。`, {
      stage: 'discover_catalog',
      rawEvidence: { page_url: pageUrl, object: clone(value) }
    });
  }
  for (const field of ['deleted', 'disabled', 'available']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${label}.${field} 必须是布尔值`, { stage: 'discover_catalog' });
    }
  }
  if (value.status !== undefined && !['active', 'available'].includes(value.status)) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${label}.status 不在来源契约内`, { stage: 'discover_catalog' });
  }
}

function normalizeRecord(value, expectedType, expectedMode, index, pageUrl = null) {
  const allowed = new Set(['id', 'kind', 'type', 'mode', 'name', 'tags', 'category', 'thumbnail', 'lora_path', 'url', 'deleted', 'disabled', 'available', 'status']);
  assertExactKeys(value, allowed, `${expectedType} record[${index}]`);
  for (const field of ['id', 'kind', 'type', 'mode', 'name', 'tags']) {
    if (!Object.hasOwn(value, field)) throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${expectedType} record[${index}] 缺少 ${field}`, { stage: 'discover_catalog' });
  }
  const id = assertText(value.id, `${expectedType} record[${index}].id`);
  const name = assertText(value.name, `${expectedType} record[${index}].name`);
  const promptText = assertText(value.tags, `${expectedType} record[${index}].tags`);
  assertAvailable(value, `${expectedType} record[${index}]`, pageUrl);
  if (!['builtin', 'external'].includes(value.kind) || value.type !== expectedType) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${expectedType} record[${index}] 的 kind 或 type 与请求不一致`, { stage: 'discover_catalog' });
  }
  const category = value.category === undefined ? null : assertText(value.category, `${expectedType} record[${index}].category`);
  if (expectedType === 'character' && category === null) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `角色 ${name} 缺少 category，无法建立来源作品归属。`, { stage: 'discover_catalog' });
  }
  let thumbnail = null;
  if (value.thumbnail !== undefined) {
    thumbnail = assertText(value.thumbnail, `${expectedType} record[${index}].thumbnail`);
    let resolved;
    try {
      resolved = new URL(thumbnail, TWO_X_NZ_API_ORIGIN);
    } catch {
      throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${expectedType} record[${index}] 的 thumbnail 不是有效 URL`, { stage: 'discover_catalog' });
    }
    if (resolved.origin !== TWO_X_NZ_API_ORIGIN || !['/api/library/tag_thumb', '/api/library/thumb', '/api/style_thumbnail'].includes(resolved.pathname)) {
      throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${expectedType} record[${index}] 的 thumbnail 超出允许 API 路径`, { stage: 'discover_catalog' });
    }
    thumbnail = resolved.toString();
  }
  const loraPath = value.lora_path === undefined || value.lora_path === '' ? null : assertText(value.lora_path, `${expectedType} record[${index}].lora_path`);
  const itemUrl = value.url === undefined || value.url === '' ? null : assertText(value.url, `${expectedType} record[${index}].url`);
  return { id, name, prompt_text: promptText, category, thumbnail, lora_path: loraPath, item_url: itemUrl, item_mode: value.mode };
}

function normalizeLibrary(value, expectedType, expectedMode, pageUrl = null) {
  scanUntrusted(value);
  assertExactKeys(value, new Set(['characters', 'styles', 'mode', 'total']), 'library response');
  if (!Array.isArray(value.characters) || !Array.isArray(value.styles) || value.mode !== expectedMode) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', 'library response 的数组或 mode 与请求不一致', { stage: 'discover_catalog' });
  }
  assertExactKeys(value.total, new Set(['characters', 'styles']), 'library total');
  if (!Number.isInteger(value.total.characters) || value.total.characters < 0 || !Number.isInteger(value.total.styles) || value.total.styles < 0) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', 'library total 必须是非负整数', { stage: 'discover_catalog' });
  }
  const field = expectedType === 'character' ? 'characters' : 'styles';
  const otherField = field === 'characters' ? 'styles' : 'characters';
  value[field].map((entry, index) => normalizeRecord(entry, expectedType, expectedMode, index, pageUrl));
  value[otherField].map((entry, index) => normalizeRecord(entry, otherField === 'characters' ? 'character' : 'style', expectedMode, index, pageUrl));
  return { total: value.total[field], records: value[field].map((entry, index) => normalizeRecord(entry, expectedType, expectedMode, index, pageUrl)) };
}

function normalizeGlobalLibrary(value, expectedMode, pageUrl = null) {
  scanUntrusted(value);
  assertExactKeys(value, new Set(['characters', 'styles', 'mode', 'total']), 'global library response');
  if (!Array.isArray(value.characters) || !Array.isArray(value.styles) || value.mode !== expectedMode) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', 'global library response 的数组或 mode 与请求不一致', { stage: 'discover_catalog' });
  }
  assertExactKeys(value.total, new Set(['characters', 'styles']), 'global library total');
  if (!Number.isInteger(value.total.characters) || value.total.characters < 0 || !Number.isInteger(value.total.styles) || value.total.styles < 0) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', 'global library total 必须是非负整数', { stage: 'discover_catalog' });
  }
  return {
    total: value.total,
    characters: value.characters.map((entry, index) => normalizeRecord(entry, 'character', expectedMode, index, pageUrl)),
    styles: value.styles.map((entry, index) => normalizeRecord(entry, 'style', expectedMode, index, pageUrl))
  };
}

function workIdentity(mode, category) {
  return { kind: 'work', source_id: sourceId(mode, 'category', category), parent_identity: 'root', normalized_name: category };
}

function modeBaseModelId(mode, baseModelIds, stage = 'discover_catalog') {
  const value = baseModelIds instanceof Map ? baseModelIds.get(mode) : baseModelIds?.[mode];
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', `2x.nz ${mode} 缺少唯一 generation_base_models 映射`, { stage });
  }
  return value;
}

function itemIdentity(record, type, mode, baseModelIds) {
  if (type === 'style') return { kind: 'style', base_model_id: modeBaseModelId(mode, baseModelIds), source_id: sourceId(mode, type, record.id), parent_identity: 'root', normalized_name: record.name };
  return { kind: 'character', source_id: sourceId(mode, type, record.id), parent_work_identity: workIdentity(mode, record.category), normalized_name: record.name };
}

function cachedRecord(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item) || !MODES.includes(item.mode) || !['character', 'style'].includes(item.type) || item.record === null || typeof item.record !== 'object' || Array.isArray(item.record) || typeof item.source_url !== 'string') {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz 本地目录缓存格式无效', { stage: 'fetch_details' });
  }
  assertSourceUrl(item.source_url, 'cache source_url', 'fetch_details');
  scanUntrusted(item.record);
  const record = item.record;
  const fields = new Set(['id', 'name', 'prompt_text', 'category', 'thumbnail', 'lora_path', 'item_url', 'item_mode']);
  assertExactKeys(record, fields, 'cached record', 'fetch_details');
  if (!MODES.includes(record.item_mode) || (record.category !== null && typeof record.category !== 'string') || (item.type === 'character' && typeof record.category !== 'string')) throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz 本地目录缓存记录缺少类型字段', { stage: 'fetch_details' });
  for (const field of ['id', 'name', 'prompt_text']) assertText(record[field], `cached record.${field}`, 'fetch_details');
  for (const field of ['thumbnail', 'lora_path', 'item_url']) if (record[field] !== null && typeof record[field] !== 'string') throw new TwoXNzSourceError('STRUCTURE_CHANGED', `cached record.${field} 类型无效`, { stage: 'fetch_details' });
  return item;
}

function rebuild2xNzDetailsFromRecordCache(cache, { baseModelIds = null, now = () => new Date() } = {}) {
  if (cache === null || typeof cache !== 'object' || Array.isArray(cache) || cache.cache_version !== 1 || !Array.isArray(cache.records)) {
    throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz 本地目录缓存格式无效', { stage: 'fetch_details' });
  }
  const records = cache.records.map(cachedRecord);
  const details = new Map();
  const categorySources = new Map();
  for (const item of records) {
    if (item.type === 'character' && typeof item.record.category === 'string' && item.record.category.length > 0) categorySources.set(`${item.mode}\u0000${item.record.category}`, item.source_url);
  }
  for (const [categoryKey, sourceUrl] of categorySources) {
    const [mode, category] = categoryKey.split('\u0000');
    const identity = workIdentity(mode, category);
    details.set(identityKey(identity), { identity, source_url: sourceUrl, name: category, aliases: [], category_name: category, source_version: mode, source_updated_at: null, fetched_at: timestamp(now), extensions: { content_count: 0 } });
  }
  for (const item of records) {
    const identity = itemIdentity(item.record, item.type, item.mode, baseModelIds);
    details.set(identityKey(identity), {
      identity, source_url: item.source_url, name: item.record.name, aliases: [],
      ...(item.type === 'style' ? { base_model_id: identity.base_model_id, style_description: null } : {}),
      ...(item.type !== 'style' ? { source_version: item.mode, source_updated_at: null } : {}),
      prompt_text: item.record.prompt_text, image_results: [], fetched_at: timestamp(now),
      extensions: {
        ...(item.type === 'style' && item.record.category ? { source_category: item.record.category } : {}),
        ...(item.type === 'style' ? { source_version: item.mode } : {}),
        ...(item.record.thumbnail ? { thumbnail_url: item.record.thumbnail } : {}),
        source_item_mode: item.record.item_mode,
        ...(item.record.lora_path ? { lora_path: item.record.lora_path } : {}),
        ...(item.record.item_url ? { source_item_url: item.record.item_url } : {})
      }
    });
  }
  for (const detail of details.values()) {
    if (detail.identity.kind !== 'work') continue;
    detail.extensions = { ...detail.extensions, content_count: [...details.values()].filter((item) => item.identity.kind === 'character' && item.identity.parent_work_identity.source_id === detail.identity.source_id).length };
  }
  return details;
}

function identityKey(identity) {
  return JSON.stringify(identity);
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function createCollectorCore({ mediaRoot, cachePath = null, request = globalThis.fetch, now = () => new Date(), minDelayMilliseconds = 3000, maxDelayMilliseconds = minDelayMilliseconds, random = Math.random, sleep = wait, globalPaging = false, emitImageBytes = false, baseModelIds = null } = {}) {
  if (typeof mediaRoot !== 'string' || mediaRoot.length === 0) throw new TypeError('mediaRoot is required');
  if (cachePath !== null && (typeof cachePath !== 'string' || cachePath.length === 0)) throw new TypeError('cachePath must be a non-empty string or null');
  if (typeof request !== 'function') throw new TypeError('request is required');
  if (!Number.isInteger(minDelayMilliseconds) || minDelayMilliseconds < 0) throw new TypeError('minDelayMilliseconds must be a non-negative integer');
  if (!Number.isInteger(maxDelayMilliseconds) || maxDelayMilliseconds < minDelayMilliseconds) throw new TypeError('maxDelayMilliseconds must be an integer no smaller than minDelayMilliseconds');
  if (typeof random !== 'function') throw new TypeError('random must be a function');
  if (typeof globalPaging !== 'boolean') throw new TypeError('globalPaging must be a boolean');
  let lastRequestAt = null;
  let nextDelayMilliseconds = minDelayMilliseconds;
  let recordsPromise = null;
  let detailsPromise = null;
  let runtimeGuard = () => false;
  let requestStopController = new AbortController();
  const unavailableThumbnailPaths = new Set();
  const thumbnailPaths = new Map();

  function writeCache(records, deduplications) {
    if (cachePath === null) return;
    const temporary = `${cachePath}.${process.pid}.tmp`;
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify({ cache_version: 1, records, deduplications })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { renameSync(temporary, cachePath); } catch (error) { try { if (existsSync(temporary)) rmSync(temporary, { force: true }); } catch {} throw error; }
  }

  async function throttle() {
    if (lastRequestAt === null) return;
    const remaining = nextDelayMilliseconds - (Date.now() - lastRequestAt);
    if (remaining > 0) await sleep(remaining);
  }

  function markRequestStarted() {
    lastRequestAt = Date.now();
    const range = maxDelayMilliseconds - minDelayMilliseconds + 1;
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new TypeError('random must return a number between 0 and 1');
    nextDelayMilliseconds = minDelayMilliseconds + Math.min(range - 1, Math.floor(sample * range));
  }

  async function requestJson(url) {
    assertSourceUrl(url, 'request URL');
    if (runtimeGuard()) throw new TwoXNzSourceError('RUN_TIME_LIMIT', '已达到采集运行时限；停止后续来源请求。', { stage: 'discover_catalog' });
    await throttle();
    if (runtimeGuard()) throw new TwoXNzSourceError('RUN_TIME_LIMIT', '已达到采集运行时限；停止后续来源请求。', { stage: 'discover_catalog' });
    markRequestStarted();
    let response;
    try {
      response = await request(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20_000), requestStopController.signal]) });
    } catch (error) {
      if (requestStopController.signal.aborted) throw new TwoXNzSourceError('PROCESS_INTERRUPTED', '采集进程收到中断信号；已停止当前来源请求。', { stage: 'discover_catalog' });
      if (error?.name === 'TimeoutError') throw new TwoXNzSourceError('TIMEOUT', '2x.nz API 请求超时', { stage: 'discover_catalog' });
      throw new TwoXNzSourceError('NETWORK_ERROR', '2x.nz API 请求失败', { stage: 'discover_catalog' });
    }
    if (!response || !Number.isInteger(response.status)) throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz API 响应缺少 HTTP 状态', { stage: 'discover_catalog' });
    if (response.status === 401) {
      let body = '';
      try { body = await response.text(); } catch {}
      throw new TwoXNzSourceError('AUTH_EXPIRED', '2x.nz API 返回 401；授权已失效。', { stage: 'discover_catalog', rawEvidence: { page_url: url, object: { status: 401, final_url: response.url ?? url, headers: responseHeaders(response), body } } });
    }
    if (response.status === 403) throw new TwoXNzSourceError('HTTP_403', '2x.nz API 返回 403；已停止，未尝试绕过。', { stage: 'discover_catalog' });
    if (response.status === 429) throw new TwoXNzSourceError('HTTP_429', '2x.nz API 返回 429；已停止，未重试。', { stage: 'discover_catalog' });
    if (response.status >= 500 && response.status <= 599) throw new TwoXNzSourceError('HTTP_5XX', `2x.nz API 返回 HTTP ${response.status}`, { stage: 'discover_catalog' });
    assertFinalResponseOrigin(response, url, '2x.nz API 请求', 'discover_catalog');
    if (response.status < 200 || response.status >= 300) throw new TwoXNzSourceError('AUTH_EXPIRED', `2x.nz API 返回 HTTP ${response.status}；已停止。`, { stage: 'discover_catalog' });
    const contentType = response.headers?.get?.('content-type') ?? '';
    let text;
    try { text = await response.text(); } catch (error) {
      if (error?.name === 'TimeoutError') throw new TwoXNzSourceError('TIMEOUT', '2x.nz API 响应读取超时', { stage: 'discover_catalog' });
      throw new TwoXNzSourceError('NETWORK_ERROR', '2x.nz API 响应读取失败', { stage: 'discover_catalog' });
    }
    if (!/^application\/json(?:;|$)/iu.test(contentType)) {
      if (/access\s+denied|forbidden|login\s+required|sign\s+in\s+required|captcha|cloudflare/iu.test(text)) {
        throw new TwoXNzSourceError('AUTH_EXPIRED', '2x.nz API 返回了登录或授权失效页面。', { stage: 'discover_catalog', rawEvidence: { page_url: url, object: { status: response.status, final_url: response.url ?? url, headers: responseHeaders(response), content_type: contentType, body: text } } });
      }
      throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz API 未返回 JSON', { stage: 'discover_catalog', rawEvidence: { page_url: url, object: { status: response.status, final_url: response.url ?? url, headers: responseHeaders(response), content_type: contentType, body: text } } });
    }
    try {
      scanUntrusted(text);
    } catch (error) {
      if (error instanceof TwoXNzSourceError && error.code === 'AUTH_EXPIRED') {
        throw new TwoXNzSourceError('AUTH_EXPIRED', error.message, { stage: 'discover_catalog', rawEvidence: { page_url: url, object: { status: response.status, final_url: response.url ?? url, headers: responseHeaders(response), content_type: contentType, body: text } } });
      }
      throw error;
    }
    try { return JSON.parse(text); } catch { throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz API 返回了无效 JSON', { stage: 'discover_catalog' }); }
  }

  async function loadRecords() {
    if (recordsPromise !== null) return recordsPromise;
    recordsPromise = (async () => {
      const collected = [];
      const seenItems = new Map();
      const discoveryDeduplications = [];
      function collect(mode, type, record, pageUrl) {
        const key = `${mode}\u0000${type}\u0000${record.id}`;
        const previous = seenItems.get(key);
        if (previous && JSON.stringify(previous.record) !== JSON.stringify(record)) {
          throw new TwoXNzSourceError('SOURCE_MAPPING_MISMATCH', `来源 ID ${record.id} 映射到冲突条目`, { stage: 'discover_catalog' });
        }
        if (previous) {
          discoveryDeduplications.push({
            kind: type,
            incoming_identity: itemIdentity(record, type, mode, baseModelIds),
            canonical_identity: itemIdentity(previous.record, type, mode, baseModelIds),
            reason: 'source_id',
            extensions: { first_source_url: previous.source_url, duplicate_source_url: pageUrl }
          });
        } else {
          seenItems.set(key, { record, source_url: pageUrl });
          collected.push({ mode, type, record, source_url: pageUrl });
        }
      }
      if (cachePath !== null && existsSync(cachePath)) {
        let cache;
        try {
          cache = JSON.parse(readFileSync(cachePath, 'utf8'));
          scanUntrusted(JSON.stringify(cache));
        } catch {
          throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz 本地目录缓存损坏；已停止。', { stage: 'discover_catalog' });
        }
        if (cache?.cache_version !== 1 || !Array.isArray(cache.records) || !Array.isArray(cache.deduplications)) {
          throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz 本地目录缓存结构不一致；已停止。', { stage: 'discover_catalog' });
        }
        for (const item of cache.records) {
          if (!item || !MODES.includes(item.mode) || !['character', 'style'].includes(item.type) || !item.record || typeof item.source_url !== 'string') {
            throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz 本地目录缓存条目不完整；已停止。', { stage: 'discover_catalog' });
          }
          collect(item.mode, item.type, item.record, item.source_url);
        }
        discoveryDeduplications.push(...cache.deduplications);
        const cachedResult = [...collected];
        Object.defineProperty(cachedResult, 'deduplications', { value: discoveryDeduplications, enumerable: false });
        return cachedResult;
      }
      for (const mode of MODES) {
        const categories = normalizeCategories(await requestJson(categoriesUrl(mode)));
        if (categories.characters.length !== categories.total.characters || categories.styles.length !== categories.total.styles) {
          throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${mode} 分类数量与来源 total 不一致`, { stage: 'discover_catalog' });
        }
        if (globalPaging) {
          if (categories.characters.length === 0 && categories.styles.length === 0) continue;
          const categoryNames = {
            character: new Set(categories.characters.map((category) => category.name)),
            style: new Set(categories.styles.map((category) => category.name))
          };
          let offset = 0;
          let expectedTotals = null;
          const recordsSeen = { character: 0, style: 0 };
          while (expectedTotals === null || offset < Math.max(expectedTotals.characters, expectedTotals.styles)) {
            const pageUrl = libraryUrl(mode, null, offset);
            const page = normalizeGlobalLibrary(await requestJson(pageUrl), mode, pageUrl);
            if (expectedTotals === null) expectedTotals = page.total;
            if (page.total.characters !== expectedTotals.characters || page.total.styles !== expectedTotals.styles) {
              throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${mode} 全量分页 total 发生变化`, { stage: 'discover_catalog' });
            }
            for (const [type, records] of [['character', page.characters], ['style', page.styles]]) {
              const expectedTotal = page.total[type === 'character' ? 'characters' : 'styles'];
              if (offset >= expectedTotal) {
                if (records.length !== 0) throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${mode} ${type} 全量分页超出 total 仍返回条目`, { stage: 'discover_catalog' });
                continue;
              }
              if (records.length === 0 || records.length > LIMIT) throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${mode} ${type} 全量分页返回空页或超出单页上限`, { stage: 'discover_catalog' });
              if (records.length < LIMIT && offset + records.length < expectedTotal) throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${mode} ${type} 全量分页提前短页`, { stage: 'discover_catalog' });
              if (offset + records.length > expectedTotal) throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${mode} ${type} 全量分页超过 total`, { stage: 'discover_catalog' });
              for (const record of records) {
                if (type === 'character' && (record.category === null || !categoryNames.character.has(record.category))) {
                  throw new TwoXNzSourceError('STRUCTURE_CHANGED', `角色 ${record.name} 的 category 不在来源分类目录中`, { stage: 'discover_catalog' });
                }
                if (type === 'style' && record.category !== null && !categoryNames.style.has(record.category)) {
                  throw new TwoXNzSourceError('STRUCTURE_CHANGED', `画风 ${record.name} 的 category 不在来源分类目录中`, { stage: 'discover_catalog' });
                }
                collect(mode, type, record, pageUrl);
              }
              recordsSeen[type] += records.length;
              if (offset + records.length >= expectedTotal && recordsSeen[type] !== expectedTotal) {
                throw new TwoXNzSourceError('STRUCTURE_CHANGED', `${mode} ${type} 全量分页未收齐 total`, { stage: 'discover_catalog' });
              }
            }
            offset += LIMIT;
          }
          continue;
        }
        for (const [type, categoryList] of [['character', categories.characters], ['style', categories.styles]]) {
          for (const category of categoryList) {
            if (category.count === 0) continue;
            let offset = 0;
            let expectedTotal = null;
            let recordsSeen = 0;
            while (expectedTotal === null || offset < expectedTotal) {
              const pageUrl = libraryUrl(mode, category.name, offset);

              const page = normalizeLibrary(await requestJson(pageUrl), type, mode, pageUrl);
              if (expectedTotal === null) expectedTotal = page.total;
              if (page.total !== expectedTotal || page.total !== category.count || page.records.length > LIMIT) {
                throw new TwoXNzSourceError('STRUCTURE_CHANGED', `分类 ${category.name} 的分页总数或条目数不一致`, { stage: 'discover_catalog' });
              }
              if (page.records.length === 0 && expectedTotal > 0) {
                throw new TwoXNzSourceError('STRUCTURE_CHANGED', `分类 ${category.name} 的固定分页无法继续推进`, { stage: 'discover_catalog' });
              }
              if (page.records.length < LIMIT && offset + page.records.length < expectedTotal) {
                throw new TwoXNzSourceError('STRUCTURE_CHANGED', `分类 ${category.name} 在达到 total 前返回短页`, { stage: 'discover_catalog' });
              }
              for (const record of page.records) {
                if (record.category !== null && record.category !== category.name) {
                  throw new TwoXNzSourceError('STRUCTURE_CHANGED', `条目 ${record.name} 的 category 与请求分类不一致`, { stage: 'discover_catalog' });
                }
                collect(mode, type, record, pageUrl);
              }
              recordsSeen += page.records.length;
              if (recordsSeen > expectedTotal) throw new TwoXNzSourceError('STRUCTURE_CHANGED', `分类 ${category.name} 的分页条目超过 total`, { stage: 'discover_catalog' });
              offset += LIMIT;
              if (offset >= expectedTotal && recordsSeen !== expectedTotal) {
                throw new TwoXNzSourceError('STRUCTURE_CHANGED', `分类 ${category.name} 的固定分页未收齐 total 条目`, { stage: 'discover_catalog' });
              }
            }
          }
        }
      }
      const result = [...collected];
      Object.defineProperty(result, 'deduplications', { value: discoveryDeduplications, enumerable: false });
      writeCache(result, discoveryDeduplications);
      return result;
    })();
    return recordsPromise;
  }

  async function loadDetails() {
    if (detailsPromise === null) detailsPromise = loadRecords().then((records) => makeDetails(records));
    return detailsPromise;
  }

  function makeDetails(records) {
    return rebuild2xNzDetailsFromRecordCache({ cache_version: 1, records }, { baseModelIds, now });
  }

  async function downloadThumbnail(detail) {
    const sourceUrl = detail.extensions?.thumbnail_url;
    if (!sourceUrl) return clone(detail);
    if (runtimeGuard()) throw new TwoXNzSourceError('RUN_TIME_LIMIT', '已达到采集运行时限；停止后续图片请求。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    let parsed;
    try {
      parsed = assertSourceUrl(sourceUrl, 'thumbnail URL', 'download_images');
    } catch (error) {
      if (error instanceof TwoXNzSourceError) {
        throw new TwoXNzSourceError(error.code, error.message, { stage: 'download_images', identity: detail.identity, scope: 'image' });
      }
      throw error;
    }
    if (!['/api/library/tag_thumb', '/api/library/thumb', '/api/style_thumbnail'].includes(parsed.pathname)) {
      throw new TwoXNzSourceError('STRUCTURE_CHANGED', 'thumbnail 路径与来源契约不一致', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    }
    const skippedThumbnail = (reason) => ({
      ...clone(detail),
      image_results: [{
        owner_identity: detail.identity,
        source_url: sourceUrl,
        sort_order: 0,
        status: 'skipped',
        reason
      }]
    });
    if (unavailableThumbnailPaths.has(parsed.pathname)) {
      return skippedThumbnail(`来源图片路由 ${parsed.pathname} 返回过统一 not found；跳过图片资源。`);
    }
    let response;
    await throttle();
    if (runtimeGuard()) throw new TwoXNzSourceError('RUN_TIME_LIMIT', '已达到采集运行时限；停止后续图片请求。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    markRequestStarted();
    try { response = await request(sourceUrl, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20_000), requestStopController.signal]), ownerSourceId: detail.identity.source_id }); } catch (error) {
      if (requestStopController.signal.aborted) throw new TwoXNzSourceError('PROCESS_INTERRUPTED', '采集进程收到中断信号；已停止当前图片请求。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
      if (error?.name === 'TimeoutError') throw new TwoXNzSourceError('TIMEOUT', '缩略图请求超时', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
      throw new TwoXNzSourceError('IMAGE_DOWNLOAD_FAILED', '缩略图下载失败', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    }
    if (response.status === 403) throw new TwoXNzSourceError('HTTP_403', '缩略图返回 403；已停止。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    if (response.status === 429) throw new TwoXNzSourceError('HTTP_429', '缩略图返回 429；已停止。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    if (response.status === 404) {
      let body = '';
      try { body = await response.text(); } catch {}
      if (body.includes('"error":"not found"')) unavailableThumbnailPaths.add(parsed.pathname);
      return skippedThumbnail('缩略图返回 HTTP 404；来源没有该图片资源。');
    }
    assertFinalResponseOrigin(response, sourceUrl, '缩略图请求', 'download_images', { identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    if (response.status < 200 || response.status >= 300) throw new TwoXNzSourceError('IMAGE_DOWNLOAD_FAILED', `缩略图返回 HTTP ${response.status}`, { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!/^image\//iu.test(contentType)) throw new TwoXNzSourceError('STRUCTURE_CHANGED', '缩略图未返回图片内容', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch (error) {
      if (error?.name === 'TimeoutError') throw new TwoXNzSourceError('TIMEOUT', '缩略图响应读取超时', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
      throw new TwoXNzSourceError('IMAGE_DOWNLOAD_FAILED', '缩略图响应读取失败', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    }
    if (bytes.length === 0) throw new TwoXNzSourceError('IMAGE_DOWNLOAD_FAILED', '缩略图为空', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    if (emitImageBytes) return {
      ...clone(detail),
      image_results: [{
        owner_identity: detail.identity,
        source_id: sourceId(detail.extensions?.source_item_mode ?? detail.identity.base_model_id, 'thumbnail', createHash('sha256').update(sourceUrl).digest('hex')),
        source_url: sourceUrl,
        content_hash: createHash('sha256').update(bytes).digest('hex'),
        sort_order: 0,
        status: 'downloaded',
        media_type: contentType.split(';', 1)[0].trim().toLocaleLowerCase('und'),
        bytes
      }]
    };
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const thumbnailKey = JSON.stringify([detail.identity.source_id, sourceUrl]);
    const cachedThumbnail = thumbnailPaths.get(thumbnailKey);
    const responseLocalPath = normalizeThumbnailLocalPath(response.cachedLocalPath);
    const reusableResponsePath = response.cachedOwnerSourceId === detail.identity.source_id ? responseLocalPath : null;
    let localPath = cachedThumbnail?.content_hash === contentHash ? cachedThumbnail.local_path : isGeneratedThumbnailPath(reusableResponsePath, contentHash) ? reusableResponsePath : null;
    let target = localPath ? resolveControlledPath(mediaRoot, `images/${localPath}`, { requiredPrefix: 'images/' }) : null;
    let status = 'downloaded';
    if (target && existsSync(target)) {
      if (createHash('sha256').update(readFileSync(target)).digest('hex') === contentHash) status = 'existing';
      else localPath = null;
    } else if (target) localPath = null;
    if (localPath === null) {
      do {
        localPath = twoXNzThumbnailLocalPath(contentHash);
        target = resolveControlledPath(mediaRoot, `images/${localPath}`, { requiredPrefix: 'images/' });
      } while (existsSync(target));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.tmp`;
      try { writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, target); } catch (error) { try { if (existsSync(temporary)) rmSync(temporary, { force: true }); } catch {} throw new TwoXNzSourceError('IMAGE_DOWNLOAD_FAILED', '缩略图无法安全写入本地目录', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl }); }
    }
    thumbnailPaths.set(thumbnailKey, { content_hash: contentHash, local_path: localPath });
    return { ...clone(detail), image_results: [{ owner_identity: detail.identity, source_id: sourceId(detail.extensions?.source_item_mode ?? detail.identity.base_model_id, 'thumbnail', createHash('sha256').update(sourceUrl).digest('hex')), source_url: sourceUrl, content_hash: contentHash, local_path: localPath, sort_order: 0, status }] };
  }

  return Object.freeze({
    kind: '2x-nz-api',
    sourceConfig: clone(TWO_X_NZ_SOURCE_CONFIG),
    resetRequestStop() {
      requestStopController = new AbortController();
    },
    requestStop() {
      requestStopController.abort();
    },
    setRuntimeGuard(guard) {
      if (typeof guard !== 'function') throw new TypeError('runtime guard must be a function');
      runtimeGuard = guard;
    },
    async smoke() {
      const result = {};
      for (const mode of MODES) {
        const categories = normalizeCategories(await requestJson(categoriesUrl(mode)));
        result[mode] = { character_categories: categories.characters.length, style_categories: categories.styles.length, character_count: categories.characters.reduce((sum, item) => sum + item.count, 0), style_count: categories.styles.reduce((sum, item) => sum + item.count, 0) };
      }
      return { source_url: TWO_X_NZ_DRAW_URL, selector: TWO_X_NZ_ROLE_STYLE_SELECTOR, api_origin: TWO_X_NZ_API_ORIGIN, modes: result };
    },
    async discoverCatalog() {
      const records = await loadRecords();
      const details = await loadDetails();
      const result = [...details.values()].map((detail) => ({
        identity: detail.identity,
        source_url: detail.source_url,
        name: detail.name,
        ...(detail.identity.kind === 'style'
          ? {
            ...(detail.extensions?.source_category !== undefined ? { category_name: detail.extensions.source_category } : {}),
            source_version: detail.extensions?.source_version ?? null,
            source_updated_at: null,
            extensions: { ...(detail.extensions?.source_category ? { source_category: detail.extensions.source_category } : {}), source_version: detail.extensions?.source_version ?? null }
          }
          : { ...(detail.category_name !== undefined ? { category_name: detail.category_name } : {}), ...(detail.source_version !== undefined ? { source_version: detail.source_version } : {}), source_updated_at: null }),
        discovered_at: timestamp(now)
      }));
      Object.defineProperty(result, 'deduplications', { value: records.deduplications ?? [], enumerable: false });
      return result;
    },
    async fetchDetail(task) {
      const details = await loadDetails();
      const detail = details.get(identityKey(task?.identity));
      if (!detail) throw new TwoXNzSourceError('DETAIL_PARSE_FAILED', '请求条目不在本轮 2x.nz API 目录中', { stage: 'fetch_details', identity: task?.identity ?? null });
      return clone(detail);
    },
    async downloadImages(detail) { return downloadThumbnail(detail); }
  });
}

const { max_run_minutes: _removedMaxRunMinutes, ...CRAWLEE_BASE_REQUEST_CONFIG } = TWO_X_NZ_SOURCE_CONFIG.request;
const CRAWLEE_REQUEST_CONFIG = Object.freeze({ ...CRAWLEE_BASE_REQUEST_CONFIG, max_delay_seconds: 5 });
export const TWO_X_NZ_CRAWLEE_SOURCE_CONFIG = Object.freeze({
  ...TWO_X_NZ_SOURCE_CONFIG,
  request: Object.freeze(CRAWLEE_REQUEST_CONFIG)
});

const THUMBNAIL_PATHS = new Set(['/api/library/tag_thumb', '/api/library/thumb', '/api/style_thumbnail']);
const CRAWLEE_TIMEOUT_SECS = 20;
const MAX_SAME_ORIGIN_REDIRECTS = 3;
const CRAWLEE_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml', 'application/octet-stream']);
const HTTP_5XX = Object.freeze(Array.from({ length: 100 }, (_, index) => 500 + index));

function headersFromObject(source = {}) {
  const values = new Map(Object.entries(source).map(([name, value]) => [name.toLowerCase(), String(value)]));
  return {
    get(name) { return values.get(String(name).toLowerCase()) ?? null; },
    entries() { return values.entries(); }
  };
}

function responseLike({ status, url, headers, body, cachedLocalPath = null, cachedOwnerSourceId = null }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  const response = {
    status,
    url,
    headers: headersFromObject(headers),
    async text() { return bytes.toString('utf8'); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  };
  if (cachedLocalPath !== null) response.cachedLocalPath = cachedLocalPath;
  if (cachedOwnerSourceId !== null) response.cachedOwnerSourceId = cachedOwnerSourceId;
  return response;
}

function isApiUrl(value, apiOrigin = TWO_X_NZ_API_ORIGIN) {
  try { return new URL(value).origin === apiOrigin; } catch { return false; }
}

function isThumbnailUrl(value, apiOrigin = TWO_X_NZ_API_ORIGIN) {
  try {
    const parsed = new URL(value);
    return parsed.origin === apiOrigin && THUMBNAIL_PATHS.has(parsed.pathname);
  } catch { return false; }
}

function credentialError(message) {
  return new TwoXNzSourceError('CREDENTIALS_INVALID', message, { stage: 'discover_catalog' });
}

function assertCredentialText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw credentialError(`${label} 格式无效。`);
  return value.trim();
}

function isApiCookieDomain(domain) {
  if (typeof domain !== 'string' || domain.trim().length === 0) return false;
  const apiHost = new URL(TWO_X_NZ_API_ORIGIN).hostname;
  const normalized = domain.trim().replace(/^\./u, '').toLowerCase();
  return normalized === apiHost || apiHost.endsWith(`.${normalized}`);
}

function cookiePair(name, value, label) {
  const checkedName = assertCredentialText(name, `${label} 名称`);
  const checkedValue = assertCredentialText(value, `${label} 值`);
  if (/[=;\s]/u.test(checkedName) || checkedValue.includes(';')) throw credentialError(`${label} 含有无效分隔符。`);
  return `${checkedName}=${checkedValue}`;
}

function cookieHeaderFromStorageState(cookies) {
  if (!Array.isArray(cookies)) throw credentialError('storageState.cookies 必须是数组。');
  const selected = [];
  for (const entry of cookies) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw credentialError('storageState cookie 格式无效。');
    if (!Object.hasOwn(entry, 'name') || !Object.hasOwn(entry, 'value') || !Object.hasOwn(entry, 'domain')) throw credentialError('storageState cookie 缺少名称、值或域名。');
    if (typeof entry.domain !== 'string' || entry.domain.trim().length === 0) throw credentialError('storageState cookie 域名无效。');
    const pair = cookiePair(entry.name, entry.value, 'storageState cookie');
    if (isApiCookieDomain(entry.domain)) selected.push(pair);
  }
  return selected.join('; ');
}

function authorizationFromStorageState(origins) {
  if (origins === undefined) return null;
  if (!Array.isArray(origins)) throw credentialError('storageState.origins 必须是数组。');
  for (const origin of origins) {
    if (origin === null || typeof origin !== 'object' || Array.isArray(origin) || typeof origin.origin !== 'string' || !Array.isArray(origin.localStorage)) {
      throw credentialError('storageState origin 格式无效。');
    }
    if (origin.origin !== TWO_X_NZ_API_ORIGIN) continue;
    for (const entry of origin.localStorage) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
        throw credentialError('storageState localStorage 格式无效。');
      }
      if (/^authorization$/iu.test(entry.name)) return assertCredentialText(entry.value, 'storageState authorization');
    }
  }
  return null;
}

function parseCookieHeader(value) {
  const pairs = assertCredentialText(value, 'Cookie').split(';').map((item) => item.trim());
  if (pairs.some((pair) => pair.length === 0)) throw credentialError('Cookie 含有空条目。');
  return pairs.map((pair) => {
    const separator = pair.indexOf('=');
    if (separator <= 0) throw credentialError('Cookie 格式无效。');
    return cookiePair(pair.slice(0, separator), pair.slice(separator + 1), 'Cookie');
  }).join('; ');
}

function parseNetscapeCookies(text) {
  const cookies = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length !== 7) throw credentialError('Netscape cookie 行字段数量无效。');
    const [domain, includeSubdomains, path, secure, expires, name, value] = fields;
    if (!isApiCookieDomain(domain)) continue;
    if (!['TRUE', 'FALSE'].includes(includeSubdomains) || !path.startsWith('/') || !['TRUE', 'FALSE'].includes(secure) || !/^\d+$/u.test(expires)) {
      throw credentialError('Netscape cookie 行格式无效。');
    }
    cookies.push(cookiePair(name, value, 'Netscape cookie'));
  }
  return cookies.join('; ');
}

function credentialsFromJson(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw credentialError('凭证 JSON 必须是对象。');
  const keys = new Set(Object.keys(value));
  const isSimple = keys.has('cookie') || keys.has('authorization');
  if (isSimple) {
    if ([...keys].some((key) => key !== 'cookie' && key !== 'authorization')) throw credentialError('凭证 JSON 包含不支持的字段。');
    const cookie = value.cookie === undefined ? null : parseCookieHeader(value.cookie);
    const authorization = value.authorization === undefined ? null : assertCredentialText(value.authorization, 'authorization');
    if (cookie === null && authorization === null) throw credentialError('凭证 JSON 为空。');
    return Object.freeze({ cookie, authorization });
  }
  if (!keys.has('cookies') || [...keys].some((key) => key !== 'cookies' && key !== 'origins')) throw credentialError('凭证 JSON 必须是 storageState 或 {cookie, authorization}。');
  const cookie = cookieHeaderFromStorageState(value.cookies);
  const authorization = authorizationFromStorageState(value.origins);
  if (!cookie && !authorization) throw credentialError('storageState 没有适用于 API 的凭证。');
  return Object.freeze({ cookie: cookie || null, authorization });
}

/** Read a browser storageState, {cookie, authorization}, Cookie header, or Netscape cookie file. */
export function read2xNzCredentials(credentialPath) {
  if (credentialPath === null || credentialPath === undefined) return {};
  if (typeof credentialPath !== 'string' || credentialPath.length === 0) throw new TypeError('credentialPath must be a non-empty string');
  let text;
  try { text = readFileSync(credentialPath, 'utf8'); } catch { throw credentialError('无法读取 2x.nz 凭证文件。'); }
  const trimmed = text.trim();
  if (!trimmed) throw credentialError('2x.nz 凭证文件为空。');
  if (trimmed.startsWith('{')) {
    let value;
    try { value = JSON.parse(trimmed); } catch { throw credentialError('2x.nz 凭证 JSON 无法解析。'); }
    return credentialsFromJson(value);
  }
  if (trimmed.includes('\t') || trimmed.startsWith('# Netscape HTTP Cookie File')) {
    const cookie = parseNetscapeCookies(trimmed);
    if (!cookie) throw credentialError('Netscape 凭证文件没有适用于 API 的 cookie。');
    return Object.freeze({ cookie, authorization: null });
  }
  if (/[\r\n]/u.test(trimmed)) throw credentialError('2x.nz 凭证文件格式不受支持。');
  return Object.freeze({ cookie: parseCookieHeader(trimmed), authorization: null });
}

function readHttpCache(cachePath) {
  if (cachePath === null || !existsSync(`${cachePath}.http.json`)) return {};
  try {
    const value = JSON.parse(readFileSync(`${cachePath}.http.json`, 'utf8'));
    return value && value.version === 1 && value.entries && typeof value.entries === 'object' ? value.entries : {};
  } catch {
    return {};
  }
}

function writeHttpCache(cachePath, entries) {
  if (cachePath === null) return;
  const target = `${cachePath}.http.json`;
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, entries })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { if (existsSync(temporary)) rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function cachedThumbnailPath(mediaRoot, localPath) {
  if (typeof localPath !== 'string' || localPath.length === 0) return null;
  try {
    const relativePath = localPath.startsWith('images/') ? localPath : `images/${localPath}`;
    return resolveControlledPath(mediaRoot, relativePath, { requiredPrefix: 'images/' });
  } catch {
    return null;
  }
}

function abortedError(reason = undefined) {
  if (reason instanceof Error) return reason;
  return Object.assign(new Error('Crawlee request aborted'), { name: 'AbortError' });
}

function transportUrl(sourceUrl, transportOrigin) {
  const parsed = new URL(sourceUrl);
  if (transportOrigin === TWO_X_NZ_API_ORIGIN) return parsed.toString();
  const target = new URL(transportOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  return target.toString();
}

function sourceUrlFromTransport(transportResponseUrl, sourceUrl, transportOrigin) {
  const parsed = new URL(transportResponseUrl);
  if (transportOrigin === TWO_X_NZ_API_ORIGIN) return parsed.toString();
  const source = new URL(sourceUrl);
  const normalized = new URL(source.origin);
  normalized.pathname = parsed.pathname;
  normalized.search = parsed.search;
  normalized.hash = parsed.hash;
  return normalized.toString();
}

async function crawleeRequest(url, options, { credentials, queueNumber, transportOrigin, activeRequests }) {
  if (!isApiUrl(url)) throw new TwoXNzSourceError('STRUCTURE_CHANGED', '请求地址超出 2x.nz API 来源边界。', { stage: 'discover_catalog' });
  const requestUrl = transportUrl(url, transportOrigin);
  const headers = { ...(options.headers ?? {}) };
  if (credentials.cookie) headers.cookie = credentials.cookie;
  if (credentials.authorization) headers.authorization = credentials.authorization;
  const config = new Configuration({ persistStorage: false });
  const queue = await RequestQueue.open(`2x-nz-${process.pid}-${queueNumber}`, { config });
  let captured = null;
  let failure = null;
  const abortController = new AbortController();
  const activeRequest = { abortController, crawler: null };
  activeRequests.add(activeRequest);
  const crawler = new HttpCrawler({
    requestQueue: queue,
    minConcurrency: 1,
    maxConcurrency: 1,
    maxRequestRetries: 0,
    maxSessionRotations: 0,
    retryOnBlocked: false,
    useSessionPool: false,
    persistCookiesPerSession: false,
    navigationTimeoutSecs: CRAWLEE_TIMEOUT_SECS,
    requestHandlerTimeoutSecs: CRAWLEE_TIMEOUT_SECS,
    ignoreHttpErrorStatusCodes: [400, 401, 403, 404, 405, 408, 409, 410, 412, 415, 418, 422, 423, 429, ...HTTP_5XX],
    additionalMimeTypes: CRAWLEE_IMAGE_TYPES,
    preNavigationHooks: [async (_context, gotOptions) => {
      gotOptions.headers = headers;
      gotOptions.followRedirect = false;
      gotOptions.throwHttpErrors = false;
      gotOptions.signal = options.signal ? AbortSignal.any([options.signal, abortController.signal]) : abortController.signal;
    }],
    requestHandler: async ({ request, response, body }) => {
      captured = responseLike({ status: response.statusCode, url: request.loadedUrl ?? request.url, headers: response.headers, body });
    },
    failedRequestHandler: async (_context, error) => { failure = error; }
  }, config);
  activeRequest.crawler = crawler;
  try {
    if (options.signal?.aborted) throw abortedError(options.signal.reason);
    await queue.addRequest({ url: requestUrl, method: options.method ?? 'GET', headers, uniqueKey: `${queueNumber}:${requestUrl}` });
    if (options.signal?.aborted || abortController.signal.aborted) throw abortedError(options.signal?.reason);
    await crawler.run();
    if (captured) return responseLike({ status: captured.status, url: sourceUrlFromTransport(captured.url, url, transportOrigin), headers: Object.fromEntries(captured.headers.entries()), body: await captured.arrayBuffer() });
    if (options.signal?.aborted || abortController.signal.aborted) throw abortedError(options.signal?.reason);
    if (failure?.name === 'TimeoutError' || /timed out/iu.test(failure?.message ?? '')) throw Object.assign(new Error('Crawlee request timed out'), { name: 'TimeoutError' });
    throw failure ?? new Error('Crawlee returned no response');
  } finally {
    activeRequests.delete(activeRequest);
  }
}

/**
 * Crawlee transport for 2x.nz.  Passing request keeps deterministic offline tests
 * fully isolated; production uses HttpCrawler and a RequestQueue for every request.
 */
export function create2xNzCrawleeAdapter({ mediaRoot, cachePath = null, request = null, credentialPath = null, cookie = null, authorization = null, apiOrigin = TWO_X_NZ_API_ORIGIN, ...options } = {}) {
  if (request !== null && typeof request !== 'function') throw new TypeError('request must be a function or null');
  let parsedTransportOrigin;
  try { parsedTransportOrigin = new URL(apiOrigin); } catch { throw new TypeError('apiOrigin must be a valid origin'); }
  const isLoopbackTestOrigin = parsedTransportOrigin.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(parsedTransportOrigin.hostname);
  if (parsedTransportOrigin.origin !== apiOrigin || (apiOrigin !== TWO_X_NZ_API_ORIGIN && !isLoopbackTestOrigin)) {
    throw new TypeError('apiOrigin must be the production API origin or a loopback test origin');
  }
  const fromFile = read2xNzCredentials(credentialPath);
  const credentials = {
    ...(typeof fromFile.cookie === 'string' ? { cookie: fromFile.cookie } : {}),
    ...(typeof fromFile.authorization === 'string' ? { authorization: fromFile.authorization } : {}),
    ...(typeof cookie === 'string' && cookie ? { cookie } : {}),
    ...(typeof authorization === 'string' && authorization ? { authorization } : {})
  };
  if (apiOrigin !== TWO_X_NZ_API_ORIGIN && (credentials.cookie || credentials.authorization)) {
    throw new TypeError('credentials are only supported for the production API origin');
  }
  const httpCache = readHttpCache(cachePath);
  let queueNumber = 0;
  const activeRequests = new Set();
  const transportFailures = new Map();
  let stopRequested = false;
  let runtimeGuard = null;
  const requestedMinDelayMilliseconds = options.minDelayMilliseconds;
  const minDelayMilliseconds = Number.isInteger(requestedMinDelayMilliseconds)
    ? requestedMinDelayMilliseconds
    : TWO_X_NZ_CRAWLEE_SOURCE_CONFIG.request.min_delay_seconds * 1000;
  const maxDelayMilliseconds = Number.isInteger(options.maxDelayMilliseconds)
    ? options.maxDelayMilliseconds
    : Number.isInteger(requestedMinDelayMilliseconds)
      ? requestedMinDelayMilliseconds
      : TWO_X_NZ_CRAWLEE_SOURCE_CONFIG.request.max_delay_seconds * 1000;
  const baseRequest = request ?? ((url, requestOptions) => crawleeRequest(url, requestOptions, { credentials, queueNumber: ++queueNumber, transportOrigin: apiOrigin, activeRequests }));
  const controlledRequest = async (url, requestOptions = {}) => {
    if (!isApiUrl(url)) throw new TwoXNzSourceError('STRUCTURE_CHANGED', '请求地址超出 2x.nz API 来源边界。', { stage: 'discover_catalog' });
    if (stopRequested || requestOptions.signal?.aborted) throw abortedError(requestOptions.signal?.reason);
    const redirectDepth = Number.isInteger(requestOptions.redirectDepth) ? requestOptions.redirectDepth : 0;
    const { redirectDepth: _redirectDepth, ...baseRequestOptions } = requestOptions;
    const headers = { ...(requestOptions.headers ?? {}) };
    if (isThumbnailUrl(url)) headers.accept = 'image/*';
    if (credentials.cookie) headers.cookie = credentials.cookie;
    if (credentials.authorization) headers.authorization = credentials.authorization;
    const cached = httpCache[url];
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    let received;
    try {
      received = await baseRequest(url, { ...baseRequestOptions, headers });
    } catch (error) {
      transportFailures.set(url, error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR');
      throw error;
    }
    if (received?.status >= 300 && received?.status < 400 && redirectDepth < MAX_SAME_ORIGIN_REDIRECTS) {
      const location = received.headers?.get?.('location');
      let redirectedUrl = null;
      try { redirectedUrl = typeof location === 'string' && location.trim().length > 0 ? new URL(location, url) : null; } catch {}
      if (redirectedUrl?.origin === TWO_X_NZ_API_ORIGIN && redirectedUrl.protocol === 'https:') {
        return controlledRequest(redirectedUrl.toString(), { ...baseRequestOptions, headers, redirectDepth: redirectDepth + 1 });
      }
    }
    const etag = received?.headers?.get?.('etag');
    const isSuccessfulResponse = received?.status >= 200 && received?.status < 300;
    const isReusableNotModified = received?.status === 304 && typeof cached?.etag === 'string' && cached.etag.length > 0;
    if (etag && (isSuccessfulResponse || isReusableNotModified)) {
      const contentType = received.headers.get('content-type');
      const body = /^application\/json(?:;|$)/iu.test(contentType ?? '') ? await received.text() : null;
      const nextCache = received.status === 304 ? { ...(cached ?? {}) } : {};
      nextCache.etag = etag;
      if (contentType) nextCache.content_type = contentType;
      if (received.status !== 304 && body !== null) nextCache.body = body;
      httpCache[url] = nextCache;
      writeHttpCache(cachePath, httpCache);
    }
    if (received?.status === 304 && typeof cached?.body === 'string') {
      return responseLike({ status: 200, url, headers: { 'content-type': cached.content_type || 'application/json', etag: cached.etag ?? '' }, body: cached.body });
    }
    if (received?.status === 304 && isThumbnailUrl(url)) {
      const cachedPath = cachedThumbnailPath(mediaRoot, cached?.local_path);
      const source = cachedPath !== null && existsSync(cachedPath) ? cachedPath : null;
      if (!source) return received;
      return responseLike({ status: 200, url, headers: { 'content-type': cached?.content_type || 'image/*', etag: cached?.etag ?? '' }, body: readFileSync(source), cachedLocalPath: cached?.local_path ?? null, cachedOwnerSourceId: cached?.owner_source_id ?? null });
    }
    if (isSuccessfulResponse && isThumbnailUrl(url) && typeof cached?.local_path === 'string' && cached?.owner_source_id === requestOptions.ownerSourceId) {
      try {
        received.cachedLocalPath = cached.local_path;
        received.cachedOwnerSourceId = cached.owner_source_id;
      } catch {}
    }
    return received;
  };
  const buildCollectorCore = () => createCollectorCore({ ...options, mediaRoot, cachePath, request: controlledRequest, minDelayMilliseconds, maxDelayMilliseconds });
  let collectorCore = buildCollectorCore();
  const interrupted = (error, stage, detail = null) => {
    if (!stopRequested) return error;
    return new TwoXNzSourceError('PROCESS_INTERRUPTED', '采集进程收到中断信号；已停止当前来源请求。', {
      stage, identity: detail?.identity, scope: stage === 'download_images' ? 'image' : undefined, imageSourceUrl: detail?.extensions?.thumbnail_url
    });
  };
  const invoke = async (operation, stage, detail = null) => {
    try { return await operation(); } catch (error) {
      if (stopRequested) throw interrupted(error, stage, detail);
      if (/HTTP 3(?!04)\d\d/u.test(error?.message ?? '')) {
        throw new TwoXNzSourceError('STRUCTURE_CHANGED', '2x.nz API 请求发生重定向；已停止。', { stage });
      }
      throw error;
    }
  };
  return Object.freeze({
    kind: collectorCore.kind,
    sourceConfig: TWO_X_NZ_CRAWLEE_SOURCE_CONFIG,
    resetRequestStop() {
      stopRequested = false;
      transportFailures.clear();
      collectorCore = buildCollectorCore();
      if (runtimeGuard !== null) collectorCore.setRuntimeGuard?.(runtimeGuard);
    },
    requestStop() {
      stopRequested = true;
      for (const activeRequest of activeRequests) {
        activeRequest.abortController.abort();
        void activeRequest.crawler?.autoscaledPool?.abort();
      }
      collectorCore.requestStop?.();
    },
    setRuntimeGuard(guard) {
      runtimeGuard = guard;
      collectorCore.setRuntimeGuard?.(guard);
    },
    async smoke() {
      return invoke(() => collectorCore.smoke(), 'discover_catalog');
    },
    async discoverCatalog() {
      return invoke(() => collectorCore.discoverCatalog(), 'discover_catalog');
    },
    async fetchDetail(task) {
      return invoke(() => collectorCore.fetchDetail(task), 'fetch_details');
    },
    async downloadImages(detail) {
      try {
        const result = await collectorCore.downloadImages(detail);
        const image = result.image_results?.find((item) => item.status === 'downloaded' || item.status === 'existing');
        if (image?.source_url && typeof image.owner_identity?.source_id === 'string' && image.owner_identity.source_id.length > 0) {
          httpCache[image.source_url] = {
            ...(httpCache[image.source_url] ?? {}),
            owner_source_id: image.owner_identity.source_id,
            ...(image.content_hash ? { content_hash: image.content_hash } : {}),
            ...(image.local_path ? { local_path: image.local_path } : {})
          };
          writeHttpCache(cachePath, httpCache);
        }
        return result;
      } catch (error) {
        if (stopRequested) throw interrupted(error, 'download_images', detail);
        if (transportFailures.get(detail?.extensions?.thumbnail_url) === 'TIMEOUT') {
          const imageSourceUrl = detail?.extensions?.thumbnail_url;
          return {
            ...JSON.parse(JSON.stringify(detail)),
            image_results: [{
              owner_identity: detail.identity,
              source_url: imageSourceUrl,
              sort_order: 0,
              status: 'failed',
              error: { code: 'TIMEOUT', message: '缩略图请求超时。' }
            }]
          };
        }
        const status = /HTTP (\d{3})/u.exec(error?.message ?? '')?.[1];
        if (status && /^3/u.test(status) && status !== '304') {
          throw new TwoXNzSourceError('STRUCTURE_CHANGED', '缩略图请求发生重定向；已停止。', { stage: 'download_images', identity: detail?.identity, scope: 'image', imageSourceUrl: detail?.extensions?.thumbnail_url });
        }
        if (error?.code === 'IMAGE_DOWNLOAD_FAILED' && status === '404') {
          return {
            ...JSON.parse(JSON.stringify(detail)),
            image_results: [{ owner_identity: detail.identity, source_url: detail.extensions?.thumbnail_url, sort_order: 0, status: 'skipped', reason: '缩略图返回 HTTP 404；来源没有该图片资源。' }]
          };
        }
        if (error?.code === 'IMAGE_DOWNLOAD_FAILED') {
          return {
            ...JSON.parse(JSON.stringify(detail)),
            image_results: [{
              owner_identity: detail.identity,
              source_url: detail.extensions?.thumbnail_url,
              sort_order: 0,
              status: 'failed',
              error: { code: status && /^5/u.test(status) ? 'HTTP_5XX' : 'IMAGE_DOWNLOAD_FAILED', message: error.message }
            }]
          };
        }
        throw error;
      }
    }
  });
}
