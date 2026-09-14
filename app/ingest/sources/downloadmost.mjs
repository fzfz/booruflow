import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ManualIngestError, resolveControlledPath } from '../manual-ingest.mjs';

export const DOWNLOADMOST_ORIGIN = 'https://www.downloadmost.com';
export const DOWNLOADMOST_CATALOG_URL = `${DOWNLOADMOST_ORIGIN}/NoobAI-XL/danbooru-artist/`;
export const DOWNLOADMOST_PAGE_COUNT = 250;
export const DOWNLOADMOST_SOURCE_CONFIG = Object.freeze({
  schema_version: 1,
  source_name: 'downloadmost NoobAI-XL danbooru artist library',
  source_base_url: DOWNLOADMOST_CATALOG_URL,
  request: { concurrency: 1, min_delay_seconds: 3, max_delay_seconds: 3, timeout_seconds: 20, max_retries: 0, retry_wait_seconds: [30, 120], max_run_minutes: 60 }
});

const STOP_PATTERNS = Object.freeze([
  ['CONTROL_CHARACTER', /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u],
  ['HIDDEN_CONTENT', /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/u],
  ['PAGE_INSTRUCTION', /ignore\s+(?:all|any|previous)\s+instructions|system\s+message/iu],
  ['ENCODED_CONTENT', /(?:data:[^,;]+;base64,|&#x?[0-9a-f]{2,};)/iu],
  ['CAPTCHA_DETECTED', /captcha|cf-chl-|challenge-platform|verify\s+you\s+are\s+human|just\s+a\s+moment/iu]
]);

export class DownloadmostSourceError extends ManualIngestError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = 'DownloadmostSourceError';
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function timestamp(now) {
  return now().toISOString();
}

function sourceId(...parts) {
  const raw = `downloadmost:${parts.map((value) => encodeURIComponent(String(value))).join(':')}`;
  if (raw.length <= 256) return raw;
  return `downloadmost:${createHash('sha256').update(raw).digest('hex')}`;
}

function identityKey(identity) {
  return JSON.stringify(identity);
}

function styleBaseModelId(value, stage = 'discover_catalog') {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DownloadmostSourceError('STRUCTURE_CHANGED', 'downloadmost requires exactly one generation_base_models mapping', { stage });
  }
  return value;
}

function styleIdentity(name, pageUrl, baseModelId) {
  return {
    kind: 'style',
    base_model_id: styleBaseModelId(baseModelId),
    source_id: sourceId('style', createHash('sha256').update(pageUrl).digest('hex')),
    parent_identity: 'root',
    normalized_name: normalizeText(name, 'artist name')
  };
}

function normalizeText(value, label, stage = 'discover_catalog') {
  if (typeof value !== 'string') throw new DownloadmostSourceError('STRUCTURE_CHANGED', `${label} 缺失`, { stage });
  const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (text.length === 0 || text.length > 16_000) throw new DownloadmostSourceError('STRUCTURE_CHANGED', `${label} 为空或过长`, { stage });
  for (const [code, pattern] of STOP_PATTERNS) {
    if (pattern.test(text)) throw new DownloadmostSourceError(code, `${label} 触发安全停止：${code}`, { stage });
  }
  return text;
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

function catalogPageUrl(page) {
  if (!Number.isInteger(page) || page < 1 || page > DOWNLOADMOST_PAGE_COUNT) throw new RangeError('page must be within the official 1–250 range');
  if (page === 1) return DOWNLOADMOST_CATALOG_URL;
  const url = new URL(DOWNLOADMOST_CATALOG_URL);
  url.searchParams.set('page', String(page));
  return url.toString();
}

function assertDownloadmostUrl(value, label, stage = 'discover_catalog') {
  let parsed;
  try { parsed = new URL(value); } catch { throw new DownloadmostSourceError('STRUCTURE_CHANGED', `${label} 不是有效 URL`, { stage }); }
  if (parsed.protocol !== 'https:' || parsed.origin !== DOWNLOADMOST_ORIGIN || parsed.username || parsed.password) {
    throw new DownloadmostSourceError('STRUCTURE_CHANGED', `${label} 超出 downloadmost 来源边界`, { stage });
  }
  return parsed;
}

function visibleHtml(html) {
  return html.replace(/<!--[^]*?-->/gu, '').replace(/<script\b[^>]*>[^]*?<\/script\s*>/giu, '').replace(/<style\b[^>]*>[^]*?<\/style\s*>/giu, '');
}

function assertSafeHtml(html, pageUrl, stage) {
  if (typeof html !== 'string' || html.length === 0) throw new DownloadmostSourceError('STRUCTURE_CHANGED', 'HTML 响应为空', { stage });
  if (html.length > 10_000_000) throw new DownloadmostSourceError('STRUCTURE_CHANGED', 'HTML 响应超过允许大小', { stage });
  const visible = visibleHtml(html);
  for (const [code, pattern] of STOP_PATTERNS) {
    if (pattern.test(visible)) throw new DownloadmostSourceError(code, `downloadmost 页面触发安全停止：${code}`, { stage, rawEvidence: { page_url: pageUrl, object: { body: html } } });
  }
  return visible;
}

function textFromHtml(html) {
  return html
    .replace(/<\/(?:p|div|li|h[1-6]|br|tr|section|article)\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/[\t\f\r ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trim();
}

function attributes(tag) {
  const result = new Map();
  for (const match of tag.matchAll(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function resolveSourceUrl(raw, baseUrl, label, stage) {
  const value = normalizeText(raw, label, stage);
  if (/["'<>\\]/u.test(value) || /^javascript:/iu.test(value)) throw new DownloadmostSourceError('STRUCTURE_CHANGED', `${label} 不是可接受的静态 URL`, { stage });
  let resolved;
  try { resolved = new URL(value, baseUrl); } catch { throw new DownloadmostSourceError('STRUCTURE_CHANGED', `${label} 无法解析`, { stage }); }
  return assertDownloadmostUrl(resolved.toString(), label, stage).toString();
}

function canonicalDetailUrl(raw, pageUrl) {
  const url = new URL(resolveSourceUrl(raw, pageUrl, 'artist detail URL'));
  url.hash = '';
  if (url.pathname !== '/NoobAI-XL/danbooru-artist/searchartist.asp' || url.searchParams.getAll('artistname').length !== 1 || url.searchParams.get('artistname') === '' || [...url.searchParams.keys()].some((key) => key !== 'artistname')) {
    throw new DownloadmostSourceError('STRUCTURE_CHANGED', '目录条目没有指向约定的艺术家详情页', { stage: 'discover_catalog' });
  }
  return url.toString();
}

function hasClasses(tag, required) {
  const classes = new Set((attributes(tag).get('class') ?? '').split(/\s+/u).filter(Boolean));
  return required.every((className) => classes.has(className));
}

function extractCardBlocks(html) {
  const cards = [];
  const openCards = [];
  let depth = 0;
  for (const match of html.matchAll(/<\/?div\b[^>]*>/giu)) {
    const tag = match[0];
    if (/^<\/div\b/iu.test(tag)) {
      if (openCards.at(-1)?.depth === depth) {
        const card = openCards.pop();
        cards.push(html.slice(card.contentStart, match.index));
      }
      depth -= 1;
      if (depth < 0) throw new DownloadmostSourceError('STRUCTURE_CHANGED', '目录页 div 标签未正确闭合', { stage: 'discover_catalog' });
      continue;
    }
    depth += 1;
    if (hasClasses(tag, ['card'])) openCards.push({ depth, contentStart: match.index + tag.length });
  }
  if (depth !== 0 || openCards.length !== 0) throw new DownloadmostSourceError('STRUCTURE_CHANGED', '目录页 div 标签未正确闭合', { stage: 'discover_catalog' });
  return cards;
}

function assertSourceAvailable(html, pageUrl, stage) {
  const visibleText = textFromHtml(html);
  const unavailable = /\b(?:status|availability)\s*:\s*(?:deleted|removed|unavailable|disabled|inactive|invalid|offline)\b|\b(?:this|the)\s+(?:artist|entry|item|page)\s+(?:has\s+been|is)\s+(?:deleted|removed|unavailable|disabled|inactive|invalid|offline)\b|\bno\s+longer\s+available\b/iu;
  if (unavailable.test(visibleText)) {
    throw new DownloadmostSourceError('SOURCE_MAPPING_MISMATCH', '来源明确标记该艺术家已下架、删除或失效；已拒绝导入。', {
      stage,
      rawEvidence: { page_url: pageUrl, object: { body: html } }
    });
  }
}

function extractCatalogEntries(html, pageUrl) {
  const entries = [];
  const cards = extractCardBlocks(html);
  if (cards.length === 0) throw new DownloadmostSourceError('STRUCTURE_CHANGED', '目录页缺少 div.card 条目容器', { stage: 'discover_catalog', rawEvidence: { page_url: pageUrl, object: { body: html } } });
  for (const card of cards) {
    assertSourceAvailable(card, pageUrl, 'discover_catalog');
    const artist = [...card.matchAll(/<span\b[^>]*>([^]*?)<\/span\s*>/giu)].find((match) => hasClasses(match[0], ['user-select-all', 'fw-bold', 'text-warning']));
    if (!artist) throw new DownloadmostSourceError('STRUCTURE_CHANGED', '目录卡片缺少艺术家名称 span', { stage: 'discover_catalog', rawEvidence: { page_url: pageUrl, object: { body: html } } });
    const detailLinks = new Set();
    for (const match of card.matchAll(/<a\b([^>]*)>/giu)) {
      const href = attributes(`<a ${match[1]}>`).get('href');
      if (!href) continue;
      let resolved;
      try { resolved = new URL(href, pageUrl); } catch { throw new DownloadmostSourceError('STRUCTURE_CHANGED', '目录卡片含无效链接', { stage: 'discover_catalog' }); }
      if (resolved.pathname !== '/NoobAI-XL/danbooru-artist/searchartist.asp') continue;
      detailLinks.add(canonicalDetailUrl(href, pageUrl));
    }
    if (detailLinks.size !== 1) throw new DownloadmostSourceError('STRUCTURE_CHANGED', '目录卡片必须包含唯一的艺术家详情链接', { stage: 'discover_catalog', rawEvidence: { page_url: pageUrl, object: { body: html } } });
    const sourceUrl = [...detailLinks][0];
    const name = normalizeText(textFromHtml(artist[1]), 'artist name');
    entries.push({ name, source_url: sourceUrl });
  }
  if (entries.length === 0) throw new DownloadmostSourceError('STRUCTURE_CHANGED', '目录页未发现艺术家条目', { stage: 'discover_catalog', rawEvidence: { page_url: pageUrl, object: { body: html } } });
  return entries;
}

function extractPromptTrigger(html, pageUrl) {
  const lines = textFromHtml(html).split('\n').map((line) => line.trim()).filter(Boolean);
  const label = /^prompt\s*trigger\s*:\s*(.*)$/iu;
  for (let index = 0; index < lines.length; index += 1) {
    const match = label.exec(lines[index]);
    if (!match) continue;
    return normalizeText(match[1] || lines[index + 1], 'Prompt trigger', 'fetch_details');
  }
  throw new DownloadmostSourceError('STRUCTURE_CHANGED', '艺术家详情页缺少 Prompt trigger', { stage: 'fetch_details', rawEvidence: { page_url: pageUrl, object: { body: html } } });
}

function extractPreviewImages(html, pageUrl) {
  const marked = [];
  for (const match of html.matchAll(/<img\b[^>]*>/giu)) {
    const src = attributes(match[0]).get('src');
    if (!src) continue;
    const sourceUrl = resolveSourceUrl(src, pageUrl, 'preview image URL', 'fetch_details');
    const preview = /^\/NoobAI-XL\/danbooru-artist\/preview([12])\/[^/]+$/iu.exec(new URL(sourceUrl).pathname);
    if (!preview) continue;
    marked.push({ order: Number(preview[1]) - 1, source_url: sourceUrl });
  }
  const byOrder = new Map();
  for (const image of marked) {
    if (image.order < 0 || image.order > 1) continue;
    if (byOrder.has(image.order) && byOrder.get(image.order) !== image.source_url) {
      throw new DownloadmostSourceError('STRUCTURE_CHANGED', `Preview ${image.order + 1} 对应多个图片 URL`, { stage: 'fetch_details', rawEvidence: { page_url: pageUrl, object: { body: html } } });
    }
    byOrder.set(image.order, image.source_url);
  }
  if (!byOrder.has(0) || !byOrder.has(1) || byOrder.get(0) === byOrder.get(1)) {
    throw new DownloadmostSourceError('STRUCTURE_CHANGED', '艺术家详情页未提供两张不同的 Preview 1 与 Preview 2 图片', { stage: 'fetch_details', rawEvidence: { page_url: pageUrl, object: { body: html } } });
  }
  return [byOrder.get(0), byOrder.get(1)];
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function createDownloadmostAdapter({ mediaRoot, baseModelId = null, request = globalThis.fetch, now = () => new Date(), minDelayMilliseconds = 3000, sleep = wait, emitImageBytes = false } = {}) {
  if (typeof mediaRoot !== 'string' || mediaRoot.length === 0) throw new TypeError('mediaRoot is required');
  if (typeof request !== 'function') throw new TypeError('request is required');
  if (!Number.isInteger(minDelayMilliseconds) || minDelayMilliseconds < 0) throw new TypeError('minDelayMilliseconds must be a non-negative integer');
  let lastRequestAt = null;
  let catalogPromise = null;
  let requestStopController = new AbortController();
  let runtimeGuard = () => false;

  async function throttle() {
    if (lastRequestAt === null) return;
    const remaining = minDelayMilliseconds - (Date.now() - lastRequestAt);
    if (remaining > 0) await sleep(remaining);
  }

  async function requestHtml(url, stage, identity = null) {
    assertDownloadmostUrl(url, 'request URL', stage);
    if (runtimeGuard()) throw new DownloadmostSourceError('RUN_TIME_LIMIT', '已达到采集运行时限；停止后续来源请求。', { stage, identity });
    await throttle();
    if (runtimeGuard()) throw new DownloadmostSourceError('RUN_TIME_LIMIT', '已达到采集运行时限；停止后续来源请求。', { stage, identity });
    lastRequestAt = Date.now();
    let response;
    try {
      response = await request(url, { headers: { accept: 'text/html' }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20_000), requestStopController.signal]) });
    } catch (error) {
      if (requestStopController.signal.aborted) throw new DownloadmostSourceError('PROCESS_INTERRUPTED', '采集进程收到中断信号；已停止当前来源请求。', { stage, identity });
      if (error?.name === 'TimeoutError') throw new DownloadmostSourceError('TIMEOUT', 'downloadmost 页面请求超时', { stage, identity });
      throw new DownloadmostSourceError('NETWORK_ERROR', 'downloadmost 页面请求失败', { stage, identity });
    }
    let body = '';
    try { body = await response.text(); } catch (error) {
      if (error?.name === 'TimeoutError') throw new DownloadmostSourceError('TIMEOUT', 'downloadmost 页面响应读取超时', { stage, identity });
      throw new DownloadmostSourceError('NETWORK_ERROR', 'downloadmost 页面响应读取失败', { stage, identity });
    }
    const evidence = { page_url: url, object: { status: response?.status, final_url: response?.url ?? url, headers: responseHeaders(response), body } };
    if (!response || !Number.isInteger(response.status)) throw new DownloadmostSourceError('STRUCTURE_CHANGED', 'downloadmost 响应缺少 HTTP 状态', { stage, identity, rawEvidence: evidence });
    if (response.status === 403) throw new DownloadmostSourceError('HTTP_403', 'downloadmost 返回 403；已停止。', { stage, identity, rawEvidence: evidence });
    if (response.status === 429) throw new DownloadmostSourceError('HTTP_429', 'downloadmost 返回 429；已停止。', { stage, identity, rawEvidence: evidence });
    if (response.status >= 500 && response.status <= 599) throw new DownloadmostSourceError('HTTP_5XX', `downloadmost 返回 HTTP ${response.status}`, { stage, identity, rawEvidence: evidence });
    if (response.status < 200 || response.status >= 300) throw new DownloadmostSourceError('AUTH_EXPIRED', `downloadmost 返回 HTTP ${response.status}；已停止。`, { stage, identity, rawEvidence: evidence });
    if (response.url && response.url !== url) throw new DownloadmostSourceError('STRUCTURE_CHANGED', 'downloadmost 请求发生重定向；已停止。', { stage, identity, rawEvidence: evidence });
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!/^text\/html(?:;|$)/iu.test(contentType)) throw new DownloadmostSourceError('STRUCTURE_CHANGED', 'downloadmost 未返回 HTML', { stage, identity, rawEvidence: evidence });
    return assertSafeHtml(body, url, stage);
  }

  async function loadCatalog() {
    if (catalogPromise !== null) return catalogPromise;
    catalogPromise = (async () => {
      const resolvedBaseModelId = styleBaseModelId(baseModelId);
      const records = new Map();
      const recordsByName = new Map();
      const deduplications = [];
      for (let page = 1; page <= DOWNLOADMOST_PAGE_COUNT; page += 1) {
        const pageUrl = catalogPageUrl(page);
        const html = await requestHtml(pageUrl, 'discover_catalog');
        for (const entry of extractCatalogEntries(html, pageUrl)) {
          const identity = styleIdentity(entry.name, entry.source_url, resolvedBaseModelId);
          const previous = records.get(entry.source_url);
          if (previous && previous.name !== entry.name) throw new DownloadmostSourceError('SOURCE_MAPPING_MISMATCH', `详情页 ${entry.source_url} 对应冲突艺术家名称`, { stage: 'discover_catalog' });
          if (previous) {
            deduplications.push({ kind: 'style', incoming_identity: identity, canonical_identity: previous.identity, reason: 'source_id', extensions: { first_source_url: previous.catalog_url, duplicate_source_url: pageUrl } });
          } else {
            const sameName = recordsByName.get(identity.normalized_name);
            if (sameName && sameName.source_url !== entry.source_url) {
              throw new DownloadmostSourceError('SOURCE_MAPPING_MISMATCH', `艺术家名称 ${entry.name} 对应多个详情页`, { stage: 'discover_catalog' });
            }
            records.set(entry.source_url, { ...entry, identity, catalog_url: pageUrl });
            recordsByName.set(identity.normalized_name, { source_url: entry.source_url });
          }
        }
      }
      const result = [...records.values()];
      Object.defineProperty(result, 'deduplications', { value: deduplications, enumerable: false });
      return result;
    })();
    return catalogPromise;
  }

  async function downloadImage(detail, sourceUrl, sortOrder) {
    if (runtimeGuard()) throw new DownloadmostSourceError('RUN_TIME_LIMIT', '已达到采集运行时限；停止后续图片请求。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    assertDownloadmostUrl(sourceUrl, 'preview image URL', 'download_images');
    await throttle();
    if (runtimeGuard()) throw new DownloadmostSourceError('RUN_TIME_LIMIT', '已达到采集运行时限；停止后续图片请求。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    lastRequestAt = Date.now();
    let response;
    try { response = await request(sourceUrl, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20_000), requestStopController.signal]) }); } catch (error) {
      if (requestStopController.signal.aborted) throw new DownloadmostSourceError('PROCESS_INTERRUPTED', '采集进程收到中断信号；已停止当前图片请求。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
      if (error?.name === 'TimeoutError') throw new DownloadmostSourceError('TIMEOUT', '预览图请求超时', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
      throw new DownloadmostSourceError('IMAGE_DOWNLOAD_FAILED', '预览图下载失败', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    }
    if (response.status === 403) throw new DownloadmostSourceError('HTTP_403', '预览图返回 403；已停止。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    if (response.status === 429) throw new DownloadmostSourceError('HTTP_429', '预览图返回 429；已停止。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    if (response.status === 404) return { owner_identity: detail.identity, source_url: sourceUrl, sort_order: sortOrder, status: 'skipped', reason: '预览图返回 HTTP 404；来源没有该图片资源。' };
    if (response.status < 200 || response.status >= 300) throw new DownloadmostSourceError('IMAGE_DOWNLOAD_FAILED', `预览图返回 HTTP ${response.status}`, { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    if (response.url && response.url !== sourceUrl) throw new DownloadmostSourceError('STRUCTURE_CHANGED', '预览图请求发生重定向；已停止。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!/^image\//iu.test(contentType)) {
      let body = '';
      try { body = await response.text(); } catch {}
      if (/captcha|cloudflare|verify\s+you\s+are\s+human|just\s+a\s+moment/iu.test(body)) {
        throw new DownloadmostSourceError('CAPTCHA_DETECTED', '预览图请求返回验证码或 Cloudflare 页面；已停止。', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
      }
      throw new DownloadmostSourceError('STRUCTURE_CHANGED', '预览图未返回图片内容', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    }
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch (error) {
      if (error?.name === 'TimeoutError') throw new DownloadmostSourceError('TIMEOUT', '预览图响应读取超时', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
      throw new DownloadmostSourceError('IMAGE_DOWNLOAD_FAILED', '预览图响应读取失败', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    }
    if (bytes.length === 0) throw new DownloadmostSourceError('IMAGE_DOWNLOAD_FAILED', '预览图为空', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
    if (emitImageBytes) return {
      owner_identity: detail.identity,
      source_id: sourceId('image', createHash('sha256').update(sourceUrl).digest('hex')),
      source_url: sourceUrl,
      content_hash: createHash('sha256').update(bytes).digest('hex'),
      sort_order: sortOrder,
      status: 'downloaded',
      media_type: contentType.split(';', 1)[0].trim().toLocaleLowerCase('und'),
      bytes
    };
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const localPath = `downloadmost/${createHash('sha256').update(sourceUrl).digest('hex')}.img`;
    const target = resolveControlledPath(mediaRoot, `images/${localPath}`, { requiredPrefix: 'images/' });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    let status = 'downloaded';
    if (existsSync(target)) {
      if (createHash('sha256').update(readFileSync(target)).digest('hex') !== contentHash) throw new DownloadmostSourceError('SOURCE_MAPPING_MISMATCH', '同一预览图来源对应不同内容', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl });
      status = 'existing';
    } else {
      const temporary = `${target}.${process.pid}.tmp`;
      try { writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, target); } catch (error) { try { if (existsSync(temporary)) rmSync(temporary, { force: true }); } catch {} throw new DownloadmostSourceError('IMAGE_DOWNLOAD_FAILED', '预览图无法安全写入本地目录', { stage: 'download_images', identity: detail.identity, scope: 'image', imageSourceUrl: sourceUrl }); }
    }
    return { owner_identity: detail.identity, source_id: sourceId('image', createHash('sha256').update(sourceUrl).digest('hex')), source_url: sourceUrl, content_hash: contentHash, local_path: localPath, sort_order: sortOrder, status };
  }

  return Object.freeze({
    kind: 'downloadmost-html',
    sourceConfig: clone(DOWNLOADMOST_SOURCE_CONFIG),
    resetRequestStop() { requestStopController = new AbortController(); },
    requestStop() { requestStopController.abort(); },
    setRuntimeGuard(guard) { if (typeof guard !== 'function') throw new TypeError('runtime guard must be a function'); runtimeGuard = guard; },
    async smoke() {
      const html = await requestHtml(catalogPageUrl(1), 'discover_catalog');
      return { source_url: catalogPageUrl(1), official_page_count: DOWNLOADMOST_PAGE_COUNT, page_1_entries: extractCatalogEntries(html, catalogPageUrl(1)).length };
    },
    async discoverCatalog() {
      const records = await loadCatalog();
      const result = records.map((record) => ({ identity: record.identity, source_url: record.source_url, name: record.name, discovered_at: timestamp(now) }));
      Object.defineProperty(result, 'deduplications', { value: records.deduplications ?? [], enumerable: false });
      return result;
    },
    async fetchDetail(task) {
      const records = await loadCatalog();
      const record = records.find((item) => identityKey(item.identity) === identityKey(task?.identity));
      if (!record) throw new DownloadmostSourceError('DETAIL_PARSE_FAILED', '请求条目不在本轮 downloadmost 目录中', { stage: 'fetch_details', identity: task?.identity ?? null });
      const html = await requestHtml(record.source_url, 'fetch_details', record.identity);
      assertSourceAvailable(html, record.source_url, 'fetch_details');
      const promptText = extractPromptTrigger(html, record.source_url);
      const imageUrls = extractPreviewImages(html, record.source_url);
      return { identity: record.identity, base_model_id: record.identity.base_model_id, source_url: record.source_url, name: record.name, aliases: [], prompt_text: promptText, style_description: null, image_results: [], fetched_at: timestamp(now), extensions: { preview_image_urls: imageUrls } };
    },
    async downloadImages(detail) {
      const imageUrls = detail?.extensions?.preview_image_urls;
      if (!Array.isArray(imageUrls) || imageUrls.length !== 2) throw new DownloadmostSourceError('STRUCTURE_CHANGED', '详情缺少两张已解析的预览图 URL', { stage: 'download_images', identity: detail?.identity ?? null });
      const imageResults = [];
      for (const [sortOrder, sourceUrl] of imageUrls.entries()) imageResults.push(await downloadImage(detail, sourceUrl, sortOrder));
      return { ...clone(detail), image_results: imageResults };
    }
  });
}
