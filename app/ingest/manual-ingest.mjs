import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCrawlerCrossObjectConsistency,
  loadAuthoritativeContracts,
  validateJsonSample
} from '../contracts/authoritative-contracts.mjs';
import { inTransaction } from '../catalog/database.mjs';
import { createMediaStorage, hasSupportedImageSignature } from '../media/media-storage.mjs';
import { characterTextProjection } from '../vector/character-semantic.mjs';
import { styleTextProjection } from '../vector/style-semantic.mjs';
import { workTextProjection } from '../vector/work-semantic.mjs';
import { embedProjection, normalizeEmbedding, upsertVectorEntry } from '../vector/vector-store.mjs';
import {
  TRANSACTION_STATE,
  hasTransactionState,
  markTransactionState,
  preserveTransactionEvidence,
  transactionStateOf
} from '../transaction-state.mjs';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(moduleDirectory, '../..');
const STAGES = Object.freeze(['discover_catalog', 'fetch_details', 'download_images', 'persist', 'report']);
const CHECKPOINT_INTERVAL = 25;
const FATAL_CODES = new Set([
  'HTTP_403',
  'HTTP_429',
  'CAPTCHA_DETECTED',
  'AUTH_EXPIRED',
  'HTTP_5XX',
  'NETWORK_ERROR',
  'HIDDEN_CONTENT',
  'CONTROL_CHARACTER',
  'SCRIPT_CONTENT',
  'PAGE_INSTRUCTION',
  'ENCODED_CONTENT',
  'STRUCTURE_CHANGED',
  'PERSIST_FAILED',
  'TIMEOUT',
  'RUN_TIME_LIMIT',
  'SOURCE_MAPPING_MISMATCH'
]);
const SKIPPABLE_OBJECT_CODES = new Set(['DETAIL_PARSE_FAILED', 'SOURCE_MAPPING_MISMATCH']);
const STOP_SCAN = Object.freeze([
  ['CONTROL_CHARACTER', /[\u0000-\u001f\u007f-\u009f]/u],
  ['HIDDEN_CONTENT', /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/u],
  ['SCRIPT_CONTENT', /<\s*script\b|javascript\s*:/iu],
  ['HIDDEN_CONTENT', /<[^>]*\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden/iu],
  ['PAGE_INSTRUCTION', /ignore\s+(?:all|any|previous)\s+instructions|system\s+message/iu],
  ['ENCODED_CONTENT', /(?:data:[^,;]+;base64,|&#x?[0-9a-f]{2,};)/iu]
]);

const schemaNames = Object.freeze({
  config: 'crawl-config.schema.json',
  catalog: 'catalog-entry.schema.json',
  detail: 'detail-result.schema.json',
  image: 'image-result.schema.json',
  state: 'crawl-state.schema.json',
  report: 'crawl-report.schema.json'
});

function utc(now) {
  return now().toISOString();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function identityKey(identity) {
  return JSON.stringify(canonicalIdentity(identity));
}

function canonicalIdentity(identity) {
  if (!identity || typeof identity !== 'object') return identity;
  const result = { kind: identity.kind };
  if (identity.source_id !== null && identity.source_id !== undefined) result.source_id = identity.source_id;
  if (identity.kind === 'style' && identity.base_model_id !== null && identity.base_model_id !== undefined) result.base_model_id = identity.base_model_id;
  if (identity.kind === 'character') result.parent_work_identity = canonicalIdentity(identity.parent_work_identity);
  else result.parent_identity = identity.parent_identity ?? 'root';
  result.normalized_name = identity.normalized_name;
  return result;
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'source';
}

function extractDownloadedFiles(detail) {
  const files = [];
  for (const image of detail?.image_results ?? []) {
    if (!Buffer.isBuffer(image?.bytes)) continue;
    if (typeof image.source_url !== 'string' || typeof image.media_type !== 'string') {
      throw new ManualIngestError('INVALID_FIELD', 'downloaded image bytes must declare source_url and media_type', { stage: 'download_images', identity: detail?.identity, scope: 'image' });
    }
    files.push(Object.freeze({ source_url: image.source_url, bytes: image.bytes, media_type: image.media_type }));
  }
  return Object.freeze(files);
}

function withoutDownloadedBytes(detail) {
  if (!detail?.image_results?.some((image) => Buffer.isBuffer(image?.bytes))) return detail;
  return {
    ...detail,
    image_results: detail.image_results.map(({ bytes, media_type, ...image }) => image)
  };
}

function sanitizeMessage(message) {
  return String(message).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, 16000) || '采集失败';
}

function assertStage(stage) {
  if (!STAGES.includes(stage)) throw new TypeError(`unknown crawler stage ${stage}`);
}

export class ManualIngestError extends Error {
  constructor(code, message, { stage = 'report', scope = 'task', identity = null, evidence = null, differences = null, rawEvidence = null, imageSourceUrl = null } = {}) {
    super(message);
    this.name = 'ManualIngestError';
    this.code = code;
    this.stage = stage;
    this.scope = scope;
    this.identity = identity;
    this.evidence = evidence;
    this.differences = differences;
    this.rawEvidence = rawEvidence;
    this.imageSourceUrl = imageSourceUrl;
  }
}

export class ManualIngestInterrupted extends Error {
  constructor(message = 'manual ingest interrupted after checkpoint') {
    super(message);
    this.name = 'ManualIngestInterrupted';
  }
}

export class ImportConflictError extends ManualIngestError {
  constructor(message, options = {}) {
    super('SOURCE_MAPPING_MISMATCH', message, options);
    this.name = 'ImportConflictError';
  }
}

export function resolveControlledPath(root, relativePath, { requiredPrefix = null } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('controlled root is required');
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\u0000') || relativePath.includes('\\')) {
    throw new ManualIngestError('INVALID_FIELD', 'controlled path must be a relative slash-separated path');
  }
  if (relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '..') || /^(?:[A-Za-z]:|\\\\)/u.test(relativePath)) {
    throw new ManualIngestError('INVALID_FIELD', 'controlled path escapes its root');
  }
  if (requiredPrefix !== null && !relativePath.startsWith(requiredPrefix)) {
    throw new ManualIngestError('INVALID_FIELD', `controlled path must start with ${requiredPrefix}`);
  }
  const controlledRoot = resolve(root);
  const target = resolve(controlledRoot, relativePath);
  const escaped = relative(controlledRoot, target);
  if (escaped === '' || escaped === '..' || escaped.startsWith(`..${sep}`)) {
    throw new ManualIngestError('INVALID_FIELD', 'controlled path escapes its root');
  }
  let cursor = controlledRoot;
  for (const part of relativePath.split('/').slice(0, -1)) {
    cursor = resolve(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new ManualIngestError('INVALID_FIELD', 'controlled path crosses a symbolic link');
    }
  }
  return target;
}

export function writeControlledJson(root, relativePath, value) {
  const target = resolveControlledPath(root, relativePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    created = true;
    renameSync(temporary, target);
  } catch (error) {
    if (created) rmSync(temporary, { force: true });
    throw error;
  }
  return relative(root, target).split(sep).join('/');
}

function atomicWriteText(root, relativePath, text) {
  const target = resolveControlledPath(root, relativePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    created = true;
    renameSync(temporary, target);
  } catch (error) {
    if (created) rmSync(temporary, { force: true });
    throw error;
  }
  return relative(root, target).split(sep).join('/');
}

const atomicWriteJson = writeControlledJson;

function readJson(root, relativePath) {
  const target = resolveControlledPath(root, relativePath);
  return JSON.parse(readFileSync(target, 'utf8'));
}

function scanStrings(value, seen = new Set()) {
  if (typeof value === 'string') {
    for (const [code, pattern] of STOP_SCAN) {
      if (pattern.test(value)) throw new ManualIngestError(code, `unsafe source content detected: ${code}`);
    }
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => scanStrings(item, seen));
  } else {
    Object.entries(value).forEach(([key, item]) => {
      scanStrings(key, seen);
      scanStrings(item, seen);
    });
  }
}

export function scanUntrustedStrings(value) {
  scanStrings(value);
}

export function scanUntrustedText(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  scanStrings(value.replace(/\r?\n/gu, ' '));
}

function schemaPath(name, contracts) {
  return resolve(contracts.root, 'schema/crawler', name);
}

function validateSample(kind, value, contracts) {
  const errors = validateJsonSample(value, schemaPath(schemaNames[kind], contracts), contracts.schemas);
  if (errors.length > 0) {
    const control = errors.some((error) => error.includes('CONTROL') || error.includes('fails pattern')) && JSON.stringify(value).match(/[\u0000-\u001f\u007f-\u009f]/u);
    throw new ManualIngestError(control ? 'CONTROL_CHARACTER' : 'STRUCTURE_CHANGED', errors.join('; '), { stage: kind === 'catalog' ? 'discover_catalog' : 'fetch_details' });
  }
  return value;
}

function assertAllowedSourceUrl(value, allowedOrigins, label, { stage, identity = null } = {}) {
  if (typeof value !== 'string') throw new ManualIngestError('INVALID_FIELD', `${label} must be an HTTP or HTTPS URL`, { stage, identity });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ManualIngestError('INVALID_FIELD', `${label} must be an HTTP or HTTPS URL`, { stage, identity });
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !allowedOrigins.has(parsed.origin)) {
    throw new ManualIngestError('INVALID_FIELD', `${label} is outside the configured source origin allowlist`, { stage, identity });
  }
  return value;
}

function configuredSourceOrigins(config) {
  if (config === null || config.crawler === null || typeof config.crawler !== 'object' || !Array.isArray(config.crawler.allowed_source_origins) || config.crawler.allowed_source_origins.length === 0) {
    throw new ManualIngestError('INVALID_FIELD', '采集配置必须提供至少一个 allowed_source_origins');
  }
  const origins = new Set();
  for (const value of config.crawler.allowed_source_origins) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ManualIngestError('INVALID_FIELD', 'allowed_source_origins 必须是 HTTP 或 HTTPS origin');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== value) {
      throw new ManualIngestError('INVALID_FIELD', 'allowed_source_origins 必须是 HTTP 或 HTTPS origin');
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function validateDetailWithCrossObjectRules(value, contracts, allowedOrigins) {
  const detail = validateSample('detail', value, contracts);
  try {
    assertAllowedSourceUrl(detail.source_url, allowedOrigins, 'detail.source_url', { stage: 'fetch_details', identity: detail.identity });
    for (const [index, image] of (detail.image_results ?? []).entries()) {
      if (image.source_url !== null && image.source_url !== undefined) {
        assertAllowedSourceUrl(image.source_url, allowedOrigins, `detail.image_results[${index}].source_url`, { stage: 'download_images', identity: detail.identity });
      }
    }
    return assertCrawlerCrossObjectConsistency(detail);
  } catch (error) {
    if (error instanceof ManualIngestError) throw error;
    throw new ManualIngestError('STRUCTURE_CHANGED', error.message, {
      stage: 'fetch_details',
      identity: detail.identity,
      differences: [{ field: 'cross_object_consistency', expected: 'owner, sort_order, and source_url are unique and aligned', observed: error.message }]
    });
  }
}

export function assertManualStart({ sourceConfig, adapter, mode = 'manual', config = null, contracts = loadAuthoritativeContracts(repositoryRoot) }) {
  if (mode !== 'manual') throw new ManualIngestError('INVALID_FIELD', '采集只能由人工命令或显式 API 启动');
  if (!adapter || typeof adapter.discoverCatalog !== 'function' || typeof adapter.fetchDetail !== 'function' || typeof adapter.downloadImages !== 'function') {
    throw new TypeError('manual adapter must provide discoverCatalog, fetchDetail, and downloadImages');
  }
  validateSample('config', sourceConfig, contracts);
  if (adapter.kind !== 'fixed-local' && adapter.kind !== '2x-nz-api' && adapter.kind !== 'downloadmost-html' && adapter.kind !== 'illustrious-noobai-style-explorer') {
    throw new ManualIngestError('INVALID_FIELD', '当前步骤只允许固定本地样本或已批准的人工来源适配器');
  }
  const allowedOrigins = configuredSourceOrigins(config);
  assertAllowedSourceUrl(sourceConfig.source_base_url, allowedOrigins, 'source_config.source_base_url', { stage: 'discover_catalog' });
  if (adapter.kind === '2x-nz-api' && !allowedOrigins.has('https://api-ai.acofork.com')) {
    throw new ManualIngestError('INVALID_FIELD', '2x.nz API 采集必须显式允许 https://api-ai.acofork.com', { stage: 'discover_catalog' });
  }
  if (adapter.kind === 'downloadmost-html' && !allowedOrigins.has('https://www.downloadmost.com')) {
    throw new ManualIngestError('INVALID_FIELD', 'downloadmost 采集必须显式允许 https://www.downloadmost.com', { stage: 'discover_catalog' });
  }
  return Object.freeze({ allowedOrigins });
}

function detailIdentity(detail) {
  return detail.identity;
}

function toErrorRecord(error, { sourceName, stage, identity = null, pageUrl = null, evidenceStore }) {
  const code = error instanceof ManualIngestError && typeof error.code === 'string' ? error.code : stage === 'persist' ? 'PERSIST_FAILED' : stage === 'fetch_details' ? 'DETAIL_PARSE_FAILED' : 'UNKNOWN';
  const fatal = FATAL_CODES.has(code);
  const evidence = error?.evidence ?? evidenceStore.ensure(sourceName, stage, identity, pageUrl, error);
  const record = {
    occurred_at: new Date().toISOString(),
    stage,
    scope: error?.scope === 'image' ? 'image' : identity ? 'item' : 'task',
    code,
    message: sanitizeMessage(error?.message ?? code),
    ...(identity ? { identity } : {}),
    ...(error?.scope === 'image' && (error.imageSourceUrl ?? pageUrl) ? { image_source_url: error.imageSourceUrl ?? pageUrl } : {}),
    ...(error?.http_status ? { http_status: error.http_status } : {}),
    request_may_retry: !fatal,
    evidence
  };
  return { record, fatal };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialCounts() {
  return {
    discovered: 0,
    fetched: 0,
    created: 0,
    updated: 0,
    duplicates: 0,
    skipped: 0,
    skipped_existing: 0,
    failed: 0,
    pending: 0,
    images_downloaded: 0,
    images_skipped: 0,
    images_failed: 0
  };
}

function migrateLegacyV2State(savedState) {
  const legacyCounts = savedState.extensions?.counts ?? {};
  const failureQueue = Array.isArray(savedState.failure_queue) ? savedState.failure_queue : [];
  const skippedIdentities = failureQueue.filter((record) => record?.scope === 'item' && SKIPPABLE_OBJECT_CODES.has(record.code));
  const imageFailures = failureQueue.filter((record) => record?.scope === 'image');
  const identityKeys = new Set();
  const addIdentity = (identity) => {
    if (identity && typeof identity === 'object' && !Array.isArray(identity)) identityKeys.add(JSON.stringify(identity));
  };
  for (const identity of savedState.completed_identities ?? []) addIdentity(identity);
  for (const task of savedState.pending_details ?? []) addIdentity(task?.identity);
  for (const task of savedState.pending_persists ?? []) addIdentity(task?.identity);
  for (const task of savedState.pending_images ?? []) addIdentity(task?.owner_identity);
  for (const record of skippedIdentities) addIdentity(record.identity);
  const sourceCounts = { ...initialCounts(), ...legacyCounts };
  const counts = {
    ...sourceCounts,
    discovered: identityKeys.size,
    skipped: skippedIdentities.length,
    failed: skippedIdentities.length,
    images_failed: imageFailures.length
  };
  const legacyImagesFailed = Number.isInteger(legacyCounts.images_failed) ? legacyCounts.images_failed : 0;
  const legacySkipped = Number.isInteger(legacyCounts.skipped) ? legacyCounts.skipped : 0;
  return {
    ...savedState,
    state_version: 3,
    skipped_identities: skippedIdentities,
    extensions: {
      ...savedState.extensions,
      counts,
      legacy_v2_count_migration: {
        source_counts: sourceCounts,
        unattributed_counts: {
          skipped: legacySkipped,
          images_failed: Math.max(0, legacyImagesFailed - imageFailures.length)
        }
      }
    }
  };
}

function addCounts(left, right) {
  for (const key of Object.keys(left)) left[key] += right[key] ?? 0;
  return left;
}

function makeReport({ sourceName, startedAt, status, counts, errors, structureDiffs, deduplications, extensions, now }) {
  return {
    report_version: 1,
    source_name: sourceName,
    started_at: startedAt,
    finished_at: utc(now),
    status,
    counts,
    errors,
    structure_diffs: structureDiffs,
    deduplications,
    extensions
  };
}

function assertReportAndStateConsistency(state, report) {
  const pending = state.pending_details.length + state.pending_images.length + state.pending_persists.length;
  if (report.counts.pending !== pending) throw new Error('crawl report pending count does not match crawl state');
  if (state.failure_queue.length !== report.errors.length) throw new Error('crawl report errors do not match crawl state');
  if (state.status !== report.status) throw new Error('crawl report status does not match crawl state');
  if (state.report_path === null) throw new Error('finished crawl state must contain report_path');
}

function normalizeText(value) {
  if (typeof value !== 'string' || value.length === 0) throw new ImportConflictError('text field must be a non-empty string');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new ManualIngestError('CONTROL_CHARACTER', 'text field contains a control character');
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function normalizeAliases(aliases) {
  const result = [];
  const seen = new Set();
  for (const alias of aliases) {
    const normalized = normalizeText(alias);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function identityFromRow(kind, row, parentWork = null) {
  if (kind === 'work') return { kind, source_id: row.source_id, parent_identity: 'root', normalized_name: row.name_normalized };
  if (kind === 'style') return { kind, base_model_id: row.base_model_id, parent_identity: 'root', normalized_name: normalizedStyleKey(row.name) };
  return {
    kind,
    source_id: row.source_id,
    parent_work_identity: identityFromRow('work', parentWork),
    normalized_name: row.name_normalized
  };
}

function sameIdentity(left, right) {
  return identityKey(left) === identityKey(right);
}

export function createCatalogImporter({ database, mediaRoot, mediaStorage = createMediaStorage({ mediaRoot }), now = () => new Date(), modelClient = null, configuration = null } = {}) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required');
  if (typeof mediaRoot !== 'string' || mediaRoot.length === 0) throw new TypeError('mediaRoot is required');
  if (!mediaStorage || typeof mediaStorage.stageFiles !== 'function') throw new TypeError('mediaStorage is required');
  if (modelClient !== null && typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (configuration !== null && (typeof configuration.embedding_model !== 'string' || configuration.embedding_model.length === 0)) throw new TypeError('configuration.embedding_model is required');

  function prepareImages(detail, downloadedFiles) {
    const downloads = new Map((downloadedFiles ?? []).map((file) => [file?.source_url, file]));
    const candidates = [];
    for (const image of detail.image_results ?? []) {
      if (image.status === 'failed' || image.status === 'skipped' || image.status === 'duplicate') continue;
      const download = downloads.get(image.source_url);
      if (image.status === 'downloaded' && download) {
        candidates.push({ image, file: { bytes: download.bytes, media_type: download.media_type } });
        continue;
      }
      if (typeof image.local_path !== 'string') {
        throw new ManualIngestError('PERSIST_FAILED', 'downloaded image is missing a centralized media payload', { stage: 'persist', identity: detail.identity, scope: 'image' });
      }
      const relativeImagePath = image.local_path.startsWith('images/') ? image.local_path : `images/${image.local_path}`;
      const absolutePath = resolveControlledPath(mediaRoot, relativeImagePath, { requiredPrefix: 'images/' });
      if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile() || lstatSync(absolutePath).isSymbolicLink()) {
        throw new ManualIngestError('PERSIST_FAILED', `image file is unavailable: ${relativeImagePath}`, { stage: 'persist', identity: detail.identity, scope: 'image' });
      }
      const bytes = readFileSync(absolutePath);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== image.content_hash) throw new ImportConflictError(`image content hash mismatch: ${relativeImagePath}`, { stage: 'persist', identity: detail.identity, scope: 'image' });
      if (!hasSupportedImageSignature(bytes)) throw new ManualIngestError('PERSIST_FAILED', `image signature is unsupported: ${relativeImagePath}`, { stage: 'persist', identity: detail.identity, scope: 'image' });
      candidates.push({ image, file: { bytes } });
    }
    const staged = candidates.length === 0 ? [] : mediaStorage.stageFiles(candidates.map(({ file }) => file));
    const prepared = [];
    candidates.forEach(({ image }, index) => prepared.push({ ...image, content_hash: staged[index].content_hash, media_path: staged[index].media_path }));
    return Object.freeze({ images: Object.freeze(prepared), staged: Object.freeze(staged) });
  }

  function findWork(identity) {
    if (identity.source_id !== null && identity.source_id !== undefined) return database.prepare('SELECT * FROM works WHERE source_id = ?').get(identity.source_id);
    return database.prepare('SELECT * FROM works WHERE source_id IS NULL AND name_normalized = ?').get(identity.normalized_name);
  }

  function resolveStyleBaseModelId(detail) {
    const detailId = detail?.base_model_id;
    const identityId = detail?.identity?.base_model_id;
    if (!Number.isSafeInteger(detailId) || detailId < 1 || !Number.isSafeInteger(identityId) || identityId < 1) {
      throw new ImportConflictError('style import requires explicit detail.base_model_id and identity.base_model_id', { stage: 'persist', identity: detail?.identity });
    }
    if (detailId !== identityId) {
      throw new ImportConflictError('detail.base_model_id must match identity.base_model_id', { stage: 'persist', identity: detail?.identity });
    }
    if (!database.prepare('SELECT id FROM generation_base_models WHERE id = ?').get(detailId)) {
      throw new ImportConflictError(`base_model_id does not exist: ${detailId}`, { stage: 'persist', identity: detail?.identity });
    }
    return detailId;
  }

  function findStyle(name, baseModelId) {
    return database.prepare('SELECT * FROM styles WHERE base_model_id = ? AND name = ?').get(baseModelId, name);
  }

  function findCharacter(identity, workId) {
    if (identity.source_id !== null && identity.source_id !== undefined) return database.prepare('SELECT * FROM characters WHERE source_id = ?').get(identity.source_id);
    return database.prepare('SELECT * FROM characters WHERE source_id IS NULL AND work_id = ? AND name_normalized = ?').get(workId, identity.normalized_name);
  }

  function resolveParentWork(identity) {
    const work = findWork(identity.parent_work_identity);
    if (!work) throw new ImportConflictError(`parent work is missing for ${identity.normalized_name}`, { stage: 'persist', identity });
    if (!sameIdentity(identity.parent_work_identity, identityFromRow('work', work))) {
      throw new ImportConflictError(`parent work identity conflicts for ${identity.normalized_name}`, { stage: 'persist', identity });
    }
    return work;
  }

  function assertExistingCompatible(kind, incoming, existing, parentWork = null) {
    if (kind === 'style') {
      const incomingBaseModelId = incoming.base_model_id ?? incoming.identity?.base_model_id ?? existing.base_model_id;
      const incomingName = incoming.name ?? null;
      if (Number(incomingBaseModelId) !== Number(existing.base_model_id)
        || (incomingName !== null && incomingName !== existing.name)) {
        throw new ImportConflictError(`identity conflict for ${incoming.identity?.kind ?? incoming.kind}:${incoming.identity?.normalized_name ?? incoming.normalized_name}`, { stage: 'persist', identity: incoming.identity ?? incoming });
      }
      return;
    }
    const existingIdentity = identityFromRow(kind, existing, parentWork);
    const incomingIdentity = canonicalIdentity(incoming);
    const canonicalExistingIdentity = canonicalIdentity(existingIdentity);
    if (identityKey(incomingIdentity) !== identityKey(canonicalExistingIdentity)) {
      throw new ImportConflictError(`identity conflict for ${incoming.kind}:${incoming.normalized_name}`, { stage: 'persist', identity: incoming });
    }
  }

  function mergeAliases(existingJson, aliases) {
    return normalizeAliases([...JSON.parse(existingJson), ...aliases]);
  }

  function importImages(detail, kind, ownerId, deduplications, preparedImages) {
    const imageIds = [];
    const imageFailures = [];
    const committedMediaPaths = new Set();
    const insertedSortOrders = new Set();
    for (const image of preparedImages) {
      let existing = null;
      if (image.source_url !== null && image.source_url !== undefined) {
        existing = database.prepare('SELECT * FROM item_images WHERE owner_kind = ? AND owner_id = ? AND source_url = ?').get(kind, ownerId, image.source_url);
      }
      if (!existing) existing = database.prepare('SELECT * FROM item_images WHERE owner_kind = ? AND owner_id = ? AND content_hash = ?').get(kind, ownerId, image.content_hash);
      if (existing) {
        if (existing.content_hash !== image.content_hash) throw new ImportConflictError(`image content conflict: ${image.source_url ?? image.media_path}`, { stage: 'persist', identity: detail.identity, scope: 'image' });
        imageIds.push(existing.id);
        deduplications.push({
          kind: 'image',
          incoming_image: { owner_identity: detail.identity, ...(image.source_url ? { source_url: image.source_url } : {}), content_hash: image.content_hash },
          canonical_image: { owner_identity: detail.identity, ...(existing.source_url ? { source_url: existing.source_url } : {}), content_hash: existing.content_hash },
          reason: image.source_url && existing.source_url === image.source_url ? 'source_url' : 'content_hash'
        });
        continue;
      }
      const sortConflict = database.prepare('SELECT id FROM item_images WHERE owner_kind = ? AND owner_id = ? AND sort_order = ?').get(kind, ownerId, image.sort_order);
      if (sortConflict) {
        if (insertedSortOrders.has(image.sort_order)) {
          throw new ImportConflictError(`image sort order conflict: ${image.sort_order}`, { stage: 'persist', identity: detail.identity, scope: 'image' });
        }
        imageFailures.push({
          code: 'SOURCE_MAPPING_MISMATCH',
          message: `image sort order conflict: ${image.sort_order}`,
          image_source_url: image.source_url
        });
        continue;
      }
      const result = database.prepare(`INSERT INTO item_images(owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        kind, ownerId, image.source_id ?? null, image.source_url ?? null, image.content_hash, image.media_path, image.sort_order, utc(now), utc(now)
      );
      imageIds.push(Number(result.lastInsertRowid));
      committedMediaPaths.add(image.media_path);
      insertedSortOrders.add(image.sort_order);
    }
    for (const image of detail.image_results ?? []) {
      if (image.status !== 'duplicate') continue;
      const existing = image.content_hash
        ? database.prepare('SELECT * FROM item_images WHERE owner_kind = ? AND owner_id = ? AND content_hash = ?').get(kind, ownerId, image.content_hash)
        : null;
      if (!existing) throw new ImportConflictError(`duplicate image has no canonical local record`, { stage: 'persist', identity: detail.identity, scope: 'image' });
      imageIds.push(existing.id);
      deduplications.push({
        kind: 'image',
        incoming_image: { owner_identity: detail.identity, content_hash: image.content_hash },
        canonical_image: { owner_identity: detail.identity, content_hash: existing.content_hash },
        reason: 'content_hash'
      });
    }
    return { imageIds, imageFailures, committedMediaPaths };
  }

  async function importDetail(detail, downloadedFiles = [], { transaction = true, vectorOverride = null, descriptionOnly = false, forcePrompt = false } = {}) {
    if (typeof transaction !== 'boolean') throw new TypeError('transaction must be a boolean');
    if (vectorOverride !== null && !(vectorOverride instanceof Float32Array) && !Array.isArray(vectorOverride)) throw new TypeError('vectorOverride must be an embedding vector');
    if (typeof descriptionOnly !== 'boolean') throw new TypeError('descriptionOnly must be a boolean');
    if (typeof forcePrompt !== 'boolean') throw new TypeError('forcePrompt must be a boolean');
    if (!detail || typeof detail !== 'object') throw new ManualIngestError('INVALID_FIELD', 'detail must be an object', { stage: 'persist' });
    const kind = detail.identity.kind;
    if (descriptionOnly && kind !== 'style') throw new ManualIngestError('INVALID_FIELD', 'descriptionOnly import is only available for Style records', { stage: 'persist', identity: detail.identity });
    if (kind === 'work' && detail.extensions?.content_count === 0) {
      throw new ManualIngestError('SOURCE_MAPPING_MISMATCH', '空作品已跳过：没有角色、提示词或图片。', { stage: 'persist', identity: detail.identity });
    }
    const aliases = normalizeAliases(detail.aliases);
    const normalizedName = normalizeText(detail.name);
    const identityNormalizedName = normalizeText(detail.identity.normalized_name);
    const identityMatches = kind === 'style'
      ? normalizedName === identityNormalizedName || normalizedStyleKey(normalizedName) === identityNormalizedName
      : normalizedName === identityNormalizedName;
    if (!identityMatches) throw new ImportConflictError(`normalized name does not match identity for ${kind}`, { stage: 'persist', identity: detail.identity });
    const promptText = kind === 'work' ? null : normalizeText(detail.prompt_text);
    const styleDescription = kind === 'style' && detail.style_description !== undefined && detail.style_description !== null
      ? trimStyleDescription(detail.style_description)
      : null;
    const styleBaseModelId = kind === 'style' ? resolveStyleBaseModelId(detail) : null;
    const sourceId = detail.identity.source_id ?? null;
    const sourceUpdatedAt = detail.source_updated_at ?? null;
    const categoryName = detail.category_name ?? null;
    const parentWork = kind === 'character' ? resolveParentWork(detail.identity) : null;
    const existing = kind === 'work' ? findWork(detail.identity) : kind === 'style' ? findStyle(normalizedName, styleBaseModelId) : findCharacter(detail.identity, parentWork.id);
    if (existing) assertExistingCompatible(kind, kind === 'style' ? detail : detail.identity, existing, parentWork);

    const deduplications = [];
    const prepared = prepareImages(detail, downloadedFiles);
    if (!modelClient || !configuration) {
      mediaStorage.discard(prepared.staged);
      throw markTransactionState(new ManualIngestError('PERSIST_FAILED', 'vector embedding configuration is required for catalog import', { stage: 'persist', identity: detail.identity }), TRANSACTION_STATE.NOT_STARTED);
    }
    const mergedAliases = existing && descriptionOnly ? null : existing ? mergeAliases(existing.aliases_json, aliases) : aliases;
    const persistedName = existing && descriptionOnly ? existing.name : normalizedName;
    const persistedPromptText = existing && descriptionOnly && !forcePrompt ? existing.prompt_text : promptText;
    const workChanged = kind === 'work' && (!existing || JSON.stringify(mergedAliases) !== existing.aliases_json || existing.name !== normalizedName || existing.source_url !== detail.source_url || existing.category_name !== categoryName);
    const resolvedStyleDescription = kind === 'style'
      ? (styleDescription ?? existing?.style_description ?? null)
      : null;
    let styleChanged = false;
    if (kind === 'style') {
      if (!existing) styleChanged = true;
      else if (descriptionOnly) styleChanged = resolvedStyleDescription !== existing.style_description || (forcePrompt && existing.prompt_text !== promptText);
      else styleChanged = JSON.stringify(mergedAliases) !== existing.aliases_json || existing.name !== normalizedName || resolvedStyleDescription !== existing.style_description;
    }
    const characterChanged = kind === 'character' && (!existing || JSON.stringify(mergedAliases) !== existing.aliases_json || existing.name !== normalizedName || existing.source_url !== detail.source_url);
    const vectorPlans = [];
    if (workChanged) {
      vectorPlans.push({ kind: 'work', id: existing?.id ?? null, row: { id: existing?.id ?? null, name: normalizedName, aliases_json: JSON.stringify(mergedAliases), category_name: categoryName } });
      const childRows = database.prepare(`SELECT characters.id, characters.work_id, characters.name, characters.aliases_json, characters.prompt_text, ? AS work_name
        FROM characters WHERE characters.work_id = ? AND characters.is_available = 1 ORDER BY characters.id`).all(normalizedName, existing?.id ?? -1);
      childRows.forEach((row) => vectorPlans.push({ kind: 'character', id: row.id, row }));
    } else if (characterChanged) {
      vectorPlans.push({ kind: 'character', id: existing?.id ?? null, row: { id: existing?.id ?? null, work_id: parentWork.id, work_name: parentWork.name, name: normalizedName, aliases_json: JSON.stringify(mergedAliases), prompt_text: promptText } });
    } else if (styleChanged) {
      vectorPlans.push({ kind: 'style', id: existing?.id ?? null, row: { id: existing?.id ?? null, base_model_id: styleBaseModelId, name: persistedName, aliases_json: existing && descriptionOnly ? existing.aliases_json : JSON.stringify(mergedAliases), style_description: resolvedStyleDescription, prompt_text: persistedPromptText } });
    }
    try {
      if (vectorOverride !== null) {
        if (vectorPlans.length > 1) throw new ManualIngestError('PERSIST_FAILED', 'a prepared vector can only be applied to one changed catalog object', { stage: 'persist', identity: detail.identity });
        if (vectorPlans.length === 1) vectorPlans[0].vector = normalizeEmbedding(vectorOverride);
      } else {
        for (const plan of vectorPlans) {
          const projection = plan.kind === 'work' ? workTextProjection(plan.row) : plan.kind === 'character' ? characterTextProjection(plan.row) : styleTextProjection(plan.row);
          plan.vector = normalizeEmbedding(await embedProjection(modelClient, projection));
        }
      }
    } catch (error) {
      mediaStorage.discard(prepared.staged);
      throw markTransactionState(error, TRANSACTION_STATE.NOT_STARTED);
    }
    try {
    const persist = () => {
      let id;
      let action;
      if (kind === 'work') {
        if (!existing) {
          const inserted = database.prepare(`INSERT INTO works(source_id, source_url, source_version, source_updated_at, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(sourceId, detail.source_url, detail.source_version ?? null, sourceUpdatedAt, normalizedName, detail.identity.normalized_name, JSON.stringify(aliases), categoryName, utc(now), utc(now));
          id = Number(inserted.lastInsertRowid);
          action = 'created';
        } else {
          const changed = workChanged;
          database.prepare(`UPDATE works SET source_url = ?, source_version = ?, source_updated_at = ?, name = ?, aliases_json = ?, category_name = ?, is_available = 1, updated_at = ? WHERE id = ?`).run(detail.source_url, detail.source_version ?? null, sourceUpdatedAt, normalizedName, JSON.stringify(mergedAliases), categoryName, utc(now), existing.id);
          id = existing.id;
          action = changed ? 'updated' : 'duplicate';
          if (action === 'duplicate') deduplications.push({ kind: 'work', incoming_identity: detail.identity, canonical_identity: identityFromRow('work', existing), reason: sourceId ? 'source_id' : 'normalized_name' });
        }
      } else if (kind === 'style') {
        if (!existing) {
          const inserted = database.prepare(`INSERT INTO styles(base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
            VALUES (?, ?, ?, ?, ?, NULL)`).run(styleBaseModelId, normalizedName, JSON.stringify(aliases), promptText, styleDescription);
          id = Number(inserted.lastInsertRowid);
          action = 'created';
        } else {
          assertExistingCompatible(kind, detail, existing);
          if (!descriptionOnly && existing.prompt_text !== promptText) throw new ImportConflictError(`prompt_text conflict for ${normalizedName}`, { stage: 'persist', identity: detail.identity });
          const changed = styleChanged;
          if (descriptionOnly) {
            if (forcePrompt) database.prepare('UPDATE styles SET prompt_text = ?, style_description = ? WHERE id = ?').run(promptText, resolvedStyleDescription, existing.id);
            else database.prepare('UPDATE styles SET style_description = ? WHERE id = ?').run(resolvedStyleDescription, existing.id);
          } else {
            database.prepare('UPDATE styles SET name = ?, aliases_json = ?, style_description = ? WHERE id = ?').run(normalizedName, JSON.stringify(mergedAliases), resolvedStyleDescription, existing.id);
          }
          id = existing.id;
          action = changed ? 'updated' : 'duplicate';
          if (action === 'duplicate') deduplications.push({ kind: 'style', incoming_identity: detail.identity, canonical_identity: identityFromRow('style', existing), reason: sourceId ? 'source_id' : 'normalized_name' });
        }
      } else {
        if (!existing) {
          const inserted = database.prepare(`INSERT INTO characters(work_id, source_id, source_url, source_version, source_updated_at, name, name_normalized, aliases_json, prompt_text, is_available, updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(parentWork.id, sourceId, detail.source_url, detail.source_version ?? null, sourceUpdatedAt, normalizedName, detail.identity.normalized_name, JSON.stringify(aliases), promptText, utc(now), utc(now));
          id = Number(inserted.lastInsertRowid);
          action = 'created';
        } else {
          assertExistingCompatible(kind, detail.identity, existing, parentWork);
          if (existing.prompt_text !== promptText) throw new ImportConflictError(`prompt_text conflict for ${normalizedName}`, { stage: 'persist', identity: detail.identity });
          const changed = characterChanged;
          database.prepare(`UPDATE characters SET source_url = ?, source_version = ?, source_updated_at = ?, name = ?, aliases_json = ?, is_available = 1, updated_at = ? WHERE id = ?`).run(detail.source_url, detail.source_version ?? null, sourceUpdatedAt, normalizedName, JSON.stringify(mergedAliases), utc(now), existing.id);
          id = existing.id;
          action = changed ? 'updated' : 'duplicate';
          if (action === 'duplicate') deduplications.push({ kind: 'character', incoming_identity: detail.identity, canonical_identity: identityFromRow('character', existing, parentWork), reason: sourceId ? 'source_id' : 'normalized_name' });
        }
      }
      const importedImages = kind === 'work' ? { imageIds: [], imageFailures: [], committedMediaPaths: new Set() } : importImages(detail, kind, id, deduplications, prepared.images);
      if (kind !== 'work' && !(kind === 'style' && descriptionOnly && existing)) {
        const cover = database.prepare('SELECT id, media_path FROM item_images WHERE owner_kind = ? AND owner_id = ? ORDER BY sort_order, id LIMIT 1').get(kind, id);
        database.prepare(`UPDATE ${kind === 'character' ? 'characters' : 'styles'} SET cover_media_path = ? WHERE id = ?`).run(cover?.media_path ?? null, id);
      }
      for (const plan of vectorPlans) {
        const vectorId = plan.id ?? id;
        if (vectorId === null) plan.id = id;
        upsertVectorEntry(database, plan.kind, vectorId, plan.vector, { expectedModel: configuration.embedding_model });
      }
      const committed = prepared.staged.filter((entry) => importedImages.committedMediaPaths.has(entry.media_path));
      mediaStorage.commit(committed);
      mediaStorage.discard(prepared.staged.filter((entry) => !importedImages.committedMediaPaths.has(entry.media_path)));
      return { kind, id, action, imageIds: importedImages.imageIds, imageFailures: importedImages.imageFailures, deduplications };
    };
    const result = transaction ? inTransaction(database, persist) : persist();
    return result;
    } catch (error) {
      try {
        mediaStorage.discard(prepared.staged);
      } catch (mediaCleanupError) {
        const cleanupMessage = `staged media cleanup failed: ${mediaCleanupError instanceof Error ? mediaCleanupError.message : String(mediaCleanupError)}`;
        if (hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN)) {
          throw preserveTransactionEvidence(error, { mediaCleanupError }, {
            message: `${error.message}; ${cleanupMessage}`
          });
        }
        const aggregate = new AggregateError([error, mediaCleanupError], `${error instanceof Error ? error.message : String(error)}; ${cleanupMessage}`);
        const transactionState = transactionStateOf(error);
        if (transactionState !== null) markTransactionState(aggregate, transactionState);
        aggregate.originalError = error;
        aggregate.mediaCleanupError = mediaCleanupError;
        throw aggregate;
      }
      throw error;
    }
  }

  async function prepareStyleVector(detail) {
    if (!modelClient || !configuration) throw new ManualIngestError('PERSIST_FAILED', 'vector embedding configuration is required for catalog import', { stage: 'persist', identity: detail?.identity });
    const row = {
      name: normalizeText(detail.name),
      aliases_json: JSON.stringify(normalizeAliases(detail.aliases ?? [])),
      style_description: detail.style_description === undefined || detail.style_description === null ? null : trimStyleDescription(detail.style_description),
      prompt_text: normalizeText(detail.prompt_text)
    };
    return normalizeEmbedding(await embedProjection(modelClient, styleTextProjection(row)));
  }

  return Object.freeze({ importDetail, prepareStyleVector });
}

function trimStyleDescription(value, fieldName = 'style_description') {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ImportConflictError(`${fieldName} must be a non-empty string`);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new ManualIngestError('CONTROL_CHARACTER', `${fieldName} contains a control character`);
  return value;
}

export function normalizedStyleKey(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

const DIRECT_DESCRIPTION_SEPARATORS = Object.freeze(['', ' ', '\n', '\r\n', ',', ', ', '，', '，', ';', '; ', '；', '； ', '。', '。 ', '、', '、 ']);

function isDirectDescriptionConcatenation(confirmation, descriptions) {
  function consumes(offset, usedIndexes, count) {
    if (offset === confirmation.length) return count >= 2;
    for (let index = 0; index < descriptions.length; index += 1) {
      if (usedIndexes.has(index) || !confirmation.startsWith(descriptions[index], offset)) continue;
      const afterDescription = offset + descriptions[index].length;
      const usedNext = new Set(usedIndexes);
      usedNext.add(index);
      if (afterDescription === confirmation.length && count + 1 >= 2) return true;
      for (const separator of DIRECT_DESCRIPTION_SEPARATORS) {
        if (separator.length === 0 && afterDescription === offset) continue;
        if (confirmation.startsWith(separator, afterDescription) && consumes(afterDescription + separator.length, usedNext, count + 1)) return true;
      }
    }
    return false;
  }
  return consumes(0, new Set(), 0);
}

function normalizedStyleDescriptionRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('record must be an object');
  const name = normalizeText(record.name);
  const aliases = normalizeAliases(record.aliases ?? []);
  const styleDescription = trimStyleDescription(record.style_description);
  return Object.freeze({ ...record, name, aliases: Object.freeze(aliases), style_description: styleDescription });
}

function styleIdentityComponents(records) {
  const parents = records.map((_, index) => index);
  const find = (index) => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const firstRecordByIdentity = new Map();
  records.forEach((record, index) => {
    const identities = new Set([normalizedStyleKey(record.name), ...record.aliases.map(normalizedStyleKey)]);
    for (const identity of identities) {
      const first = firstRecordByIdentity.get(identity);
      if (first === undefined) firstRecordByIdentity.set(identity, index);
      else join(first, index);
    }
  });
  const components = new Map();
  records.forEach((record, index) => {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(record);
    components.set(root, component);
  });
  return [...components.values()];
}

function confirmedStyleDescription(component, confirmationsByName) {
  let mergedStyleDescription = null;
  for (const record of component) {
    const confirmation = confirmationsByName[record.name];
    const candidate = confirmation?.merged_style_description;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new ImportConflictError(`merged_style_description confirmation is required for duplicate ${record.name}`);
    }
    if (candidate !== candidate.trim()) throw new ImportConflictError(`merged_style_description confirmation is invalid for duplicate ${record.name}`);
    if (mergedStyleDescription !== null && candidate !== mergedStyleDescription) {
      throw new ImportConflictError(`merged_style_description confirmations conflict for duplicate ${record.name}`);
    }
    mergedStyleDescription = candidate;
  }
  const descriptions = component.map(({ style_description }) => style_description);
  if (descriptions.includes(mergedStyleDescription) || isDirectDescriptionConcatenation(mergedStyleDescription, descriptions)) {
    throw new ImportConflictError(`merged_style_description confirmation is invalid for duplicate ${component[0].name}`);
  }
  return mergedStyleDescription;
}

  function resolveStyleDescriptionRecords(records, { confirmationsByName } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!confirmationsByName || typeof confirmationsByName !== 'object' || Array.isArray(confirmationsByName)) throw new TypeError('confirmationsByName must be an object');
  const normalizedRecords = records.map(normalizedStyleDescriptionRecord);
  const resolved = [];
  for (const group of styleIdentityComponents(normalizedRecords)) {
    const first = group[0];
    if (group.length === 1) {
      resolved.push(first);
      continue;
    }
    const mergedStyleDescription = confirmedStyleDescription(group, confirmationsByName);
    const aliases = normalizeAliases(group.flatMap(({ aliases: sourceAliases }) => sourceAliases));
    resolved.push(Object.freeze({ ...first, aliases: Object.freeze(aliases), style_description: mergedStyleDescription }));
  }
  return Object.freeze(resolved);
}

function aliasesFromRow(row) {
  let aliases;
  try { aliases = JSON.parse(row.aliases_json); } catch { throw new ImportConflictError(`stored aliases are invalid for ${row.name}`); }
  if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== 'string')) throw new ImportConflictError(`stored aliases are invalid for ${row.name}`);
  return aliases;
}

export function createStyleDescriptionBatchImporter({ database, catalogImporter, baseModelId = null, now = () => new Date() } = {}) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required');
  if (!catalogImporter || typeof catalogImporter.importDetail !== 'function') throw new TypeError('catalogImporter.importDetail is required');
  if (typeof catalogImporter.prepareStyleVector !== 'function') throw new TypeError('catalogImporter.prepareStyleVector is required');
  if (typeof now !== 'function') throw new TypeError('now is required');

  function inspectStyleMatch(record) {
    if (!record || typeof record !== 'object') throw new TypeError('record must be an object');
    const recordName = normalizeText(record.name);
    const recordNameKey = normalizedStyleKey(recordName);
    const recordKeys = new Set([recordNameKey, ...(record.aliases ?? []).map(normalizedStyleKey)]);
    const requestedBaseModelId = record.base_model_id ?? baseModelId;
    const rows = requestedBaseModelId === null
      ? database.prepare('SELECT * FROM styles').all()
      : database.prepare('SELECT * FROM styles WHERE base_model_id = ?').all(requestedBaseModelId);
    // The database identity is the exact `(base_model_id, name)` pair. The
    // lower-cased key is used only for batch alias/duplicate semantics.
    const canonicalMatches = rows.filter((row) => row.name === recordName);
    if (canonicalMatches.length > 0) {
      return Object.freeze({
        kind: 'canonical',
        matches: Object.freeze(canonicalMatches),
        style: canonicalMatches.length === 1 ? canonicalMatches[0] : null
      });
    }
    const aliasMatches = rows.filter((row) => {
      const rowAliasKeys = aliasesFromRow(row).map(normalizedStyleKey);
      return rowAliasKeys.some((key) => recordKeys.has(key));
    });
    return Object.freeze({
      kind: aliasMatches.length === 0 ? 'unmatched' : 'alias',
      matches: Object.freeze(aliasMatches),
      style: aliasMatches.length === 1 ? aliasMatches[0] : null
    });
  }

  function matchingStyle(record) {
    const inspection = inspectStyleMatch(record);
    if (inspection.matches.length > 1) throw new ImportConflictError(`style match is ambiguous for ${record.name}`);
    return inspection.style;
  }

  function resolveRecords(records, options = {}) {
    const resolved = resolveStyleDescriptionRecords(records, options);
    const existingGroups = new Map();
    resolved.forEach((record, index) => {
      const existing = matchingStyle(record);
      const key = existing ? `existing:${existing.id}` : `input:${index}`;
      const group = existingGroups.get(key) ?? [];
      group.push(record);
      existingGroups.set(key, group);
    });
    const databaseResolved = [];
    for (const group of existingGroups.values()) {
      if (group.length === 1) {
        databaseResolved.push(group[0]);
        continue;
      }
      const mergedStyleDescription = confirmedStyleDescription(group, options.confirmationsByName);
      const aliases = normalizeAliases(group.flatMap(({ aliases: sourceAliases }) => sourceAliases));
      databaseResolved.push(Object.freeze({ ...group[0], aliases: Object.freeze(aliases), style_description: mergedStyleDescription }));
    }
    return Object.freeze(databaseResolved);
  }

  function detailForRecord(record) {
    if (!record || typeof record !== 'object') throw new TypeError('record must be an object');
    const name = normalizeText(record.name);
    const aliases = normalizeAliases(record.aliases ?? []);
    const promptText = normalizeText(record.prompt_text);
    const styleDescription = trimStyleDescription(record.style_description);
    const resolvedBaseModelId = record.base_model_id ?? baseModelId;
    if (!Number.isSafeInteger(resolvedBaseModelId) || resolvedBaseModelId < 1) throw new ImportConflictError('style description import requires base_model_id');
    const existing = matchingStyle({ name, aliases, base_model_id: resolvedBaseModelId });
    if (!existing) {
      return Object.freeze({
        identity: { kind: 'style', base_model_id: resolvedBaseModelId, parent_identity: 'root', normalized_name: normalizedStyleKey(name) },
        base_model_id: resolvedBaseModelId,
        source_url: null,
        name,
        aliases,
        prompt_text: promptText,
        style_description: styleDescription,
        image_results: []
      });
    }
    const existingAliases = aliasesFromRow(existing);
    const persistedStyleDescription = styleDescription;
    const seen = new Set([normalizedStyleKey(existing.name), ...existingAliases.map(normalizedStyleKey)]);
    const additionalAliases = aliases.filter((alias) => {
      const key = normalizedStyleKey(alias);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return Object.freeze({
      identity: { kind: 'style', base_model_id: existing.base_model_id, parent_identity: 'root', normalized_name: normalizedStyleKey(existing.name) },
      base_model_id: existing.base_model_id,
      source_url: null,
      name: existing.name,
      aliases: additionalAliases,
      prompt_text: promptText,
      style_description: persistedStyleDescription,
      image_results: []
    });
  }

  async function importRecords(records, { atomic = false } = {}) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    if (typeof atomic !== 'boolean') throw new TypeError('atomic must be a boolean');
    const normalizedRecords = records.map(normalizedStyleDescriptionRecord);
    if (styleIdentityComponents(normalizedRecords).some((component) => component.length > 1)) {
      throw new ImportConflictError('duplicate style records must be resolved with merged_style_description confirmations before import');
    }
    const prepared = [];
    for (const record of normalizedRecords) {
      const detail = detailForRecord(record);
      const vector = await catalogImporter.prepareStyleVector(detail);
      prepared.push(Object.freeze({ detail, vector }));
    }
    if (!atomic) {
      return Object.freeze(await Promise.all(prepared.map(({ detail, vector }) => catalogImporter.importDetail(detail, [], { vectorOverride: vector }))));
    }
    const imported = [];
    database.exec('BEGIN IMMEDIATE;');
    try {
      for (const { detail, vector } of prepared) imported.push(await catalogImporter.importDetail(detail, [], { transaction: false, vectorOverride: vector }));
      database.exec('COMMIT;');
    } catch (error) {
      try { database.exec('ROLLBACK;'); } catch {}
      throw error;
    }
    return Object.freeze(imported);
  }

  return Object.freeze({ resolveRecords, importRecords, inspectStyleMatch });
}

function createEvidenceStore({ dataRoot }) {
  const rawRoot = resolve(dataRoot, 'raw');
  return Object.freeze({
    save(sourceName, stage, identity, pageUrl, payload = null) {
      const key = safeName(identity ? identity.normalized_name : pageUrl ?? 'task');
      const base = `raw/${safeName(sourceName)}/${stage}-${key}`;
      const reportBase = `data/${base}`;
      const htmlPath = `${reportBase}.html`;
      const textPath = `${reportBase}.txt`;
      const rawText = typeof payload === 'string' ? payload : JSON.stringify(payload ?? { page_url: pageUrl, stage }, null, 2);
      atomicWriteJson(dataRoot, `${base}.html.json`, { page_url: pageUrl, stage, raw: rawText });
      atomicWriteText(dataRoot, `${base}.html`, rawText);
      atomicWriteText(dataRoot, `${base}.txt`, rawText.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim());
      return { html_path: htmlPath, visible_text_path: textPath };
    },
    saveRawJson(sourceName, stage, identity, pageUrl, rawEvidence) {
      const key = safeName(identity ? identity.normalized_name : pageUrl ?? 'task');
      const base = `raw/${safeName(sourceName)}/${stage}-${key}`;
      const jsonPath = `${base}.json`;
      const textPath = `${base}.txt`;
      const reportJsonPath = `data/${jsonPath}`;
      const reportTextPath = `data/${textPath}`;
      const rawJson = JSON.stringify(rawEvidence.object);
      const evidence = {
        page_url: rawEvidence.page_url ?? pageUrl,
        object: rawEvidence.object,
        sha256: createHash('sha256').update(rawJson).digest('hex')
      };
      atomicWriteJson(dataRoot, jsonPath, evidence);
      atomicWriteText(dataRoot, textPath, rawJson);
      return { html_path: reportJsonPath, visible_text_path: reportTextPath };
    },
    ensure(sourceName, stage, identity, pageUrl, error) {
      if (error?.rawEvidence && typeof error.rawEvidence.object === 'object') {
        return this.saveRawJson(sourceName, stage, identity, pageUrl, error.rawEvidence);
      }
      return this.save(sourceName, stage, identity, pageUrl, `采集错误 ${sanitizeMessage(error?.message ?? 'unknown')}`);
    },
    rawRoot
  });
}

function makeStructureDiff({ sourceName, stage, identity, pageUrl, differences, evidence }) {
  return {
    detected_at: new Date().toISOString(),
    source_name: sourceName,
    stage,
    page_url: pageUrl ?? 'https://source.example/',
    ...(identity ? { identity } : {}),
    severity: 'stop',
    status: 'task_stopped',
    differences: differences?.length > 0 ? differences : [{ field: 'structure', expected: 'fixed local contract', observed: 'schema mismatch' }],
    evidence
  };
}

function makeState({ sourceName, now, counts, startedAt }) {
  return {
    state_version: 3,
    source_name: sourceName,
    status: 'running',
    stage: 'discover_catalog',
    current_task: null,
    catalog_cursor: null,
    pending_details: [],
    pending_images: [],
    pending_persists: [],
    completed_identities: [],
    skipped_identities: [],
    failure_queue: [],
    consecutive_object_failures: 0,
    report_path: null,
    stop_reason: null,
    resume_allowed: true,
    updated_at: utc(now),
    extensions: { counts, started_at: startedAt, process_pid: process.pid, heartbeat_at: utc(now) }
  };
}

export function createFixedLocalAdapter({ samplePath } = {}) {
  if (typeof samplePath !== 'string' || samplePath.length === 0) throw new TypeError('samplePath is required for test-only fixed-local adapters');
  const sample = JSON.parse(readFileSync(resolve(samplePath), 'utf8'));
  if (!sample || !sample.source_config || !Array.isArray(sample.catalog) || !Array.isArray(sample.details)) throw new Error('fixed local sample is incomplete');
  const detailByIdentity = new Map(sample.details.map((detail) => [identityKey(detail.identity), detail]));
  return Object.freeze({
    kind: 'fixed-local',
    sourceConfig: clone(sample.source_config),
    async discoverCatalog() { return clone(sample.catalog); },
    async fetchDetail(task) {
      const detail = detailByIdentity.get(identityKey(task.identity));
      if (!detail) throw new ManualIngestError('DETAIL_PARSE_FAILED', `fixed local detail is missing for ${task.identity.normalized_name}`, { stage: 'fetch_details', identity: task.identity });
      return clone(detail);
    },
    async downloadImages(detail) { return clone(detail); }
  });
}

export function createManualIngestRunner({ dataRoot, sourceConfig, adapter, database, mediaRoot = resolve(dataRoot, 'media'), config = null, vectorConfiguration = null, modelClient = null, now = () => new Date(), runtimeNow = () => Date.now(), onProgress = null } = {}) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) throw new TypeError('dataRoot is required');
  if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function or null');
  const contracts = loadAuthoritativeContracts(repositoryRoot);
  const sourcePolicy = assertManualStart({ sourceConfig, adapter, mode: 'manual', config, contracts });
  mkdirSync(resolve(dataRoot), { recursive: true, mode: 0o700 });
  const evidenceStore = createEvidenceStore({ dataRoot });
  const importer = database
    ? createCatalogImporter({
      database,
      mediaRoot,
      now,
      modelClient,
      configuration: vectorConfiguration
    })
    : null;
  let stopRequested = false;
  let stopReason = 'RUN_TIME_LIMIT';
  let heartbeatTimer = null;
  let runLockPath = null;
  let runLockToken = null;
  const maxRunMinutes = Number.isInteger(sourceConfig?.request?.max_run_minutes) ? sourceConfig.request.max_run_minutes : null;

  function statePath() { return 'crawl_state.json'; }
  function reportPath(sourceName) { return `reports/${safeName(sourceName)}-latest.json`; }
  function lockToken() { return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function readLockOwner(lockPath) {
    try {
      const ownerPath = lstatSync(lockPath).isDirectory() ? resolve(lockPath, 'owner.json') : lockPath;
      return JSON.parse(readFileSync(ownerPath, 'utf8'));
    } catch {
      return null;
    }
  }
  function acquireRunLock() {
    const lockPath = resolve(dataRoot, '.crawl.lock');
    for (;;) {
      const token = lockToken();
      const temporaryPath = resolve(dataRoot, `.crawl.lock.${token}.tmp`);
      mkdirSync(temporaryPath, { recursive: false, mode: 0o700 });
      writeFileSync(resolve(temporaryPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        renameSync(temporaryPath, lockPath);
        runLockPath = lockPath;
        runLockToken = token;
        return;
      } catch (error) {
        rmSync(temporaryPath, { recursive: true, force: true });
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
        const owner = readLockOwner(lockPath);
        if (isProcessAlive(owner?.pid)) throw new ManualIngestError('STATE_VERSION_INCOMPATIBLE', '采集数据目录仍由另一个活动进程持有');
        const reclaimPath = resolve(lockPath, 'reclaim');
        const reclaimTempPath = resolve(dataRoot, `.crawl.lock.reclaim-${token}.tmp`);
        mkdirSync(reclaimTempPath, { recursive: false, mode: 0o700 });
        writeFileSync(resolve(reclaimTempPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: 'utf8', mode: 0o600 });
        try {
          renameSync(reclaimTempPath, reclaimPath);
        } catch (reclaimError) {
          rmSync(reclaimTempPath, { recursive: true, force: true });
          if (['EEXIST', 'ENOTEMPTY'].includes(reclaimError?.code)) {
            throw new ManualIngestError('STATE_VERSION_INCOMPATIBLE', '采集数据目录正在由另一个进程接管');
          }
          if (reclaimError?.code !== 'ENOENT') throw reclaimError;
          continue;
        }
        const latestOwner = readLockOwner(lockPath);
        if (latestOwner?.token !== owner?.token || isProcessAlive(latestOwner?.pid)) {
          rmSync(reclaimPath, { recursive: true, force: true });
          throw new ManualIngestError('STATE_VERSION_INCOMPATIBLE', '采集数据目录已被另一个活动进程接管');
        }
        rmSync(lockPath, { recursive: true, force: true });
      }
    }
  }
  function releaseRunLock() {
    if (runLockPath === null) return;
    const owner = readLockOwner(runLockPath);
    if (owner?.pid === process.pid && owner?.token === runLockToken) {
      const releasedPath = resolve(dataRoot, `.crawl.lock.released-${runLockToken}`);
      try {
        renameSync(runLockPath, releasedPath);
        rmSync(releasedPath, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    runLockPath = null;
    runLockToken = null;
  }
  function saveState(state) {
    state.updated_at = utc(now);
    const errors = validateJsonSample(state, schemaPath('crawl-state.schema.json', contracts), contracts.schemas);
    if (errors.length > 0) throw new Error(`crawl state is invalid: ${errors.join('; ')}`);
    atomicWriteJson(dataRoot, statePath(), state);
  }
  function loadState() {
    const savedState = readJson(dataRoot, statePath());
    const state = savedState.state_version === 2
      ? migrateLegacyV2State(savedState)
      : savedState;
    const errors = validateJsonSample(state, schemaPath('crawl-state.schema.json', contracts), contracts.schemas);
    if (errors.length > 0) throw new Error(`crawl state is invalid: ${errors.join('; ')}`);
    return state;
  }
  function saveReport(report) {
    assertCrawlerCrossObjectConsistency(report);
    const errors = validateJsonSample(report, schemaPath('crawl-report.schema.json', contracts), contracts.schemas);
    if (errors.length > 0) throw new Error(`crawl report is invalid: ${errors.join('; ')}`);
    const path = reportPath(report.source_name);
    atomicWriteJson(dataRoot, path, report);
    return `data/${path}`;
  }
  function setCounts(state, counts, deduplications, startedAt) {
    counts.pending = state.pending_details.length + state.pending_images.length + state.pending_persists.length;
    state.extensions = {
      ...state.extensions,
      counts,
      deduplications,
      started_at: startedAt,
      process_pid: process.pid,
      heartbeat_at: utc(now)
    };
  }
  function emitProgress(state, counts) {
    onProgress?.(clone(state), clone(counts));
  }
  function stopHeartbeat() {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  function startHeartbeat(state, counts, deduplications, startedAt) {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (state.status !== 'running') return;
      setCounts(state, counts, deduplications, startedAt);
      saveState(state);
    }, 30_000);
    heartbeatTimer.unref?.();
  }
  function makePendingFromCatalog(catalog) {
    return catalog.map((entry) => ({ identity: entry.identity, detail_url: entry.source_url, attempts: 0 }));
  }
  function countImages(detail, counts) {
    for (const image of detail.image_results ?? []) {
      if (image.status === 'downloaded' || image.status === 'existing') counts.images_downloaded += 1;
      if (image.status === 'failed') counts.images_failed += 1;
      if (image.status === 'skipped') counts.images_skipped += 1;
    }
  }
  function imageFailureKey(identity, sourceUrl) {
    return JSON.stringify({ identity: canonicalIdentity(identity), source_url: sourceUrl ?? null });
  }
  function recordImageFailures(detail, state, counts = null) {
    const recorded = new Set(state.failure_queue
      .filter((record) => record.scope === 'image')
      .map((record) => imageFailureKey(record.identity, record.image_source_url)));
    for (const image of detail.image_results ?? []) {
      if (image.status !== 'failed') continue;
      const key = imageFailureKey(detail.identity, image.source_url);
      if (recorded.has(key)) continue;
      const error = new ManualIngestError(image.error?.code ?? 'IMAGE_DOWNLOAD_FAILED', image.error?.message ?? '图片下载失败', {
        stage: 'download_images', scope: 'image', identity: detail.identity, imageSourceUrl: image.source_url ?? null
      });
      const failure = toErrorRecord(error, { sourceName: state.source_name, stage: 'download_images', identity: detail.identity, pageUrl: image.source_url ?? null, evidenceStore });
      state.failure_queue.push(failure.record);
      recorded.add(key);
      if (counts) counts.images_failed += 1;
    }
  }
  function recordPersistImageFailures(detail, imported, state, counts) {
    for (const imageFailure of imported.imageFailures ?? []) {
      const error = new ManualIngestError(imageFailure.code, imageFailure.message, {
        stage: 'persist',
        scope: 'image',
        identity: detail.identity,
        imageSourceUrl: imageFailure.image_source_url
      });
      const failure = toErrorRecord(error, {
        sourceName: state.source_name,
        stage: 'persist',
        identity: detail.identity,
        pageUrl: imageFailure.image_source_url,
        evidenceStore
      });
      state.failure_queue.push(failure.record);
      counts.images_failed += 1;
    }
  }
  function recordSkippedObject(state, counts, failure) {
    state.failure_queue.push(failure.record);
    state.skipped_identities.push(failure.record);
    state.completed_identities = state.completed_identities.filter((identity) => !sameIdentity(identity, failure.record.identity));
    counts.failed += 1;
    counts.skipped += 1;
    state.consecutive_object_failures = 0;
  }
  function markCompensationOutcome(state, identity, outcome, currentError = null) {
    const audit = state.extensions?.compensation_audit;
    if (!Array.isArray(audit)) return;
    const entry = [...audit].reverse().find((candidate) => candidate.outcome === 'pending' && sameIdentity(candidate.identity, identity));
    if (!entry) return;
    entry.outcome = outcome;
    entry.finished_at = utc(now);
    if (currentError !== null) entry.current_error = currentError;
  }
  async function finalize(state, counts, errors, structureDiffs, deduplications, startedAt, status, stopReason = null) {
    stopHeartbeat();
    counts.pending = state.pending_details.length + state.pending_images.length + state.pending_persists.length;
    const report = makeReport({ sourceName: state.source_name, startedAt, status, counts, errors, structureDiffs, deduplications, extensions: { compensation_audit: state.extensions?.compensation_audit ?? [] }, now });
    const path = saveReport(report);
    state.status = status;
    state.stage = 'report';
    state.current_task = null;
    state.report_path = path;
    state.stop_reason = stopReason;
    state.resume_allowed = status === 'paused' || status === 'failed';
    state.consecutive_object_failures = status === 'completed'
      ? 0
      : status === 'failed' && stopReason === 'THREE_CONSECUTIVE_OBJECT_FAILURES'
        ? 3
        : state.consecutive_object_failures;
    setCounts(state, counts, deduplications, startedAt);
    assertReportAndStateConsistency(state, report);
    saveState(state);
    emitProgress(state, counts);
    return { state: clone(state), report: clone(report) };
  }
  async function run({ resume = false, interruptAfter = null } = {}) {
    acquireRunLock();
    try {
      if (typeof adapter.resetRequestStop === 'function') adapter.resetRequestStop();
      if (resume) {
      stopRequested = false;
      stopReason = 'RUN_TIME_LIMIT';
      }
    const runtimeDeadline = maxRunMinutes === null ? null : runtimeNow() + maxRunMinutes * 60_000;
    if (typeof adapter.setRuntimeGuard === 'function') {
      adapter.setRuntimeGuard(() => runtimeDeadline !== null && runtimeNow() >= runtimeDeadline);
    }
    let state;
    let counts;
    let deduplications;
    let startedAt;
    if (resume) {
      state = loadState();
      if (!['running', 'paused', 'failed'].includes(state.status)) throw new ManualIngestError('STATE_VERSION_INCOMPATIBLE', '只有未完成的断点可以继续');
      const previousPid = state.extensions?.process_pid;
      if (previousPid !== process.pid && isProcessAlive(previousPid)) {
        throw new ManualIngestError('STATE_VERSION_INCOMPATIBLE', '采集断点仍由另一个活动进程持有');
      }
      if (previousPid !== process.pid && !isProcessAlive(previousPid)) {
        state.status = 'paused';
        state.stop_reason = 'PROCESS_INTERRUPTED';
        state.resume_allowed = true;
        state.report_path = null;
      }
      counts = { ...initialCounts(), ...(state.extensions?.counts ?? {}) };
      deduplications = [...(state.extensions?.deduplications ?? [])];
      startedAt = state.extensions?.started_at ?? utc(now);
      state.status = 'running';
      state.stop_reason = null;
      state.report_path = null;
      state.resume_allowed = true;
      setCounts(state, counts, deduplications, startedAt);
      saveState(state);
      emitProgress(state, counts);
      startHeartbeat(state, counts, deduplications, startedAt);
    } else {
      startedAt = utc(now);
      counts = initialCounts();
      deduplications = [];
      state = makeState({ sourceName: sourceConfig.source_name, now, counts, startedAt });
      saveState(state);
      emitProgress(state, counts);
      startHeartbeat(state, counts, deduplications, startedAt);
      let catalog;
      try {
        state.stage = 'discover_catalog';
        const discoveryResult = await adapter.discoverCatalog();
        const discoveryDeduplications = Array.isArray(discoveryResult)
          ? discoveryResult.deduplications ?? []
          : discoveryResult?.catalog && Array.isArray(discoveryResult.catalog)
            ? discoveryResult.deduplications ?? []
            : [];
        catalog = Array.isArray(discoveryResult) ? discoveryResult : discoveryResult?.catalog;
        if (!Array.isArray(catalog)) throw new ManualIngestError('STRUCTURE_CHANGED', 'discoverCatalog 必须返回目录数组或 { catalog, deduplications }');
        scanStrings(catalog);
        scanStrings(discoveryDeduplications);
        if (!Array.isArray(discoveryDeduplications)) throw new ManualIngestError('STRUCTURE_CHANGED', 'discovery deduplications 必须是数组');
        deduplications.push(...clone(discoveryDeduplications));
        catalog = catalog.map((entry) => {
          const validated = validateSample('catalog', entry, contracts);
          assertAllowedSourceUrl(validated.source_url, sourcePolicy.allowedOrigins, 'catalog.source_url', { stage: 'discover_catalog', identity: validated.identity });
          return validated;
        });
        const identities = new Set();
        for (const entry of catalog) {
          const key = identityKey(entry.identity);
          if (identities.has(key)) throw new ManualIngestError('STRUCTURE_CHANGED', `duplicate catalog identity ${entry.name}`, { stage: 'discover_catalog' });
          identities.add(key);
        }
        state.pending_details = makePendingFromCatalog(catalog);
        counts.discovered = catalog.length;
        setCounts(state, counts, deduplications, startedAt);
        saveState(state);
        emitProgress(state, counts);
      } catch (error) {
        const failure = toErrorRecord(error, { sourceName: state.source_name, stage: 'discover_catalog', evidenceStore });
        state.failure_queue.push(failure.record);
        counts.failed += 1;
        const structureDiffs = failure.record.code === 'STRUCTURE_CHANGED'
          ? [makeStructureDiff({
              sourceName: state.source_name,
              stage: 'discover_catalog',
              identity: error?.identity ?? null,
              pageUrl: error?.rawEvidence?.page_url ?? sourceConfig.source_base_url,
              differences: error?.differences,
              evidence: failure.record.evidence
            })]
          : [];
        if (failure.record.code === 'RUN_TIME_LIMIT' || failure.record.code === 'PROCESS_INTERRUPTED') {
          return finalize(state, counts, state.failure_queue, [], deduplications, startedAt, 'paused', failure.record.code);
        }
        if (failure.fatal) return finalize(state, counts, state.failure_queue, structureDiffs, deduplications, startedAt, 'failed', failure.record.code);
        return finalize(state, counts, state.failure_queue, structureDiffs, deduplications, startedAt, 'completed');
      }
    }

    let processed = 0;
    while (state.pending_details.length > 0) {
      if (stopRequested || (runtimeDeadline !== null && runtimeNow() >= runtimeDeadline)) {
        return finalize(state, counts, state.failure_queue, [], deduplications, startedAt, 'paused', stopRequested ? stopReason : 'RUN_TIME_LIMIT');
      }
      const task = state.pending_details[0];
      state.stage = 'fetch_details';
      state.current_task = { stage: 'fetch_details', identity: task.identity, source_url: task.detail_url };
      setCounts(state, counts, deduplications, startedAt);
      emitProgress(state, counts);
      try {
        const rawDetail = await adapter.fetchDetail(task);
        scanStrings(rawDetail);
        const detail = validateDetailWithCrossObjectRules(rawDetail, contracts, sourcePolicy.allowedOrigins);
        state.stage = 'download_images';
        state.current_task.stage = 'download_images';
        emitProgress(state, counts);
        const downloadResult = await adapter.downloadImages(detail);
        const downloadedFiles = extractDownloadedFiles(downloadResult);
        const withImages = withoutDownloadedBytes(downloadResult);
        scanStrings(withImages);
        validateDetailWithCrossObjectRules(withImages, contracts, sourcePolicy.allowedOrigins);
        countImages(withImages, counts);
        recordImageFailures(withImages, state);
        counts.fetched += 1;
        if (!importer) throw new ManualIngestError('PERSIST_FAILED', 'database importer is required', { stage: 'persist', identity: withImages.identity });
        state.stage = 'persist';
        state.current_task.stage = 'persist';
        emitProgress(state, counts);
        const imported = await importer.importDetail(withImages, downloadedFiles);
        recordPersistImageFailures(withImages, imported, state, counts);
        if (imported.action === 'created') counts.created += 1;
        if (imported.action === 'updated') counts.updated += 1;
        if (imported.action === 'duplicate') { counts.duplicates += 1; counts.skipped_existing += 1; }
        deduplications.push(...imported.deduplications);
        state.pending_details.shift();
        state.completed_identities.push(withImages.identity);
        markCompensationOutcome(state, withImages.identity, 'succeeded');
        state.consecutive_object_failures = 0;
        state.current_task = null;
        processed += 1;
        if (interruptAfter !== null && processed >= interruptAfter) {
          setCounts(state, counts, deduplications, startedAt);
          saveState(state);
          stopHeartbeat();
          throw new ManualIngestInterrupted();
        }
        if (processed % CHECKPOINT_INTERVAL === 0) {
          setCounts(state, counts, deduplications, startedAt);
          saveState(state);
        }
        emitProgress(state, counts);
      } catch (error) {
        if (error instanceof ManualIngestInterrupted) throw error;
        const failure = toErrorRecord(error, {
          sourceName: state.source_name,
          stage: state.stage,
          identity: task.identity,
          pageUrl: task.detail_url,
          evidenceStore
        });
        const structureDiffs = [];
        if (failure.record.code === 'STRUCTURE_CHANGED') {
          structureDiffs.push(makeStructureDiff({ sourceName: state.source_name, stage: state.stage, identity: task.identity, pageUrl: task.detail_url, differences: error.differences, evidence: failure.record.evidence }));
        }
        if (failure.record.code === 'PROCESS_INTERRUPTED') {
          return finalize(state, counts, state.failure_queue, structureDiffs, deduplications, startedAt, 'paused', 'PROCESS_INTERRUPTED');
        }
        if (failure.record.code === 'RUN_TIME_LIMIT') {
          return finalize(state, counts, state.failure_queue, structureDiffs, deduplications, startedAt, 'paused', 'RUN_TIME_LIMIT');
        }
        if (hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN)) {
          state.failure_queue.push(failure.record);
          counts.failed += 1;
          markCompensationOutcome(state, task.identity, 'failed', failure.record);
          if (error?.scope === 'image') counts.images_failed += 1;
          return finalize(state, counts, state.failure_queue, structureDiffs, deduplications, startedAt, 'failed', failure.record.code);
        }
        if (SKIPPABLE_OBJECT_CODES.has(failure.record.code)) {
          recordSkippedObject(state, counts, failure);
          markCompensationOutcome(state, task.identity, 'failed', failure.record);
          state.pending_details.shift();
          state.current_task = null;
          setCounts(state, counts, deduplications, startedAt);
          saveState(state);
          emitProgress(state, counts);
          continue;
        }
        state.failure_queue.push(failure.record);
        counts.failed += 1;
        markCompensationOutcome(state, task.identity, 'failed', failure.record);
        if (error?.scope === 'image' && failure.record.code !== 'RUN_TIME_LIMIT') counts.images_failed += 1;
        if (failure.fatal) {
          return finalize(state, counts, state.failure_queue, structureDiffs, deduplications, startedAt, 'failed', failure.record.code);
        }
        state.pending_details.shift();
        state.current_task = null;
        state.consecutive_object_failures += 1;
        setCounts(state, counts, deduplications, startedAt);
        emitProgress(state, counts);
        if (state.consecutive_object_failures >= 3) return finalize(state, counts, state.failure_queue, structureDiffs, deduplications, startedAt, 'failed', 'THREE_CONSECUTIVE_OBJECT_FAILURES');
        saveState(state);
      }
    }
      return finalize(state, counts, state.failure_queue, [], deduplications, startedAt, 'completed');
    } finally {
      stopHeartbeat();
      releaseRunLock();
    }
  }

  return Object.freeze({
    run,
    resume: () => run({ resume: true }),
    compensateSkipped: async () => {
      acquireRunLock();
      try {
        const state = loadState();
        if (state.skipped_identities.length === 0) throw new ManualIngestError('STATE_VERSION_INCOMPATIBLE', '没有可补偿的跳过对象');
        const skipped = [...state.skipped_identities];
        const skippedRecords = new Set(skipped.map((record) => JSON.stringify(record)));
        const counts = { ...initialCounts(), ...(state.extensions?.counts ?? {}) };
        if (counts.skipped < skipped.length || counts.failed < skipped.length) throw new ManualIngestError('STATE_VERSION_INCOMPATIBLE', '跳过对象计数与断点不一致');
        const keys = new Set(state.pending_details.map((task) => identityKey(task.identity)));
        const compensation = skipped.map((record) => ({ identity: record.identity, detail_url: record.page_url ?? 'https://source.example/recovery-compensation', attempts: 0 })).filter((task) => !keys.has(identityKey(task.identity)));
        state.pending_details = [...compensation, ...state.pending_details];
        state.skipped_identities = [];
        state.failure_queue = state.failure_queue.filter((record) => !skippedRecords.has(JSON.stringify(record)));
        counts.skipped -= skipped.length;
        counts.failed -= skipped.length;
        state.extensions = {
          ...state.extensions,
          counts,
          compensation_audit: [
            ...(Array.isArray(state.extensions?.compensation_audit) ? state.extensions.compensation_audit : []),
            ...skipped.map((record) => ({ identity: record.identity, previous_error: record, started_at: utc(now), outcome: 'pending' }))
          ]
        };
        state.status = 'paused'; state.stage = 'fetch_details'; state.stop_reason = null; state.resume_allowed = true;
        saveState(state);
      } finally { releaseRunLock(); }
      return run({ resume: true });
    },
    requestStop: (reason = 'RUN_TIME_LIMIT') => {
      stopRequested = true;
      stopReason = reason;
      adapter.requestStop?.();
    },
    readState: loadState,
    readReport: () => {
      const state = loadState();
      if (!state.report_path) return null;
      return readJson(dataRoot, state.report_path.replace(/^data\//u, ''));
    },
    dataRoot: resolve(dataRoot),
    sourceName: sourceConfig.source_name
  });
}
