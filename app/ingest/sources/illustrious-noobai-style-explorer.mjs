import { createHash } from 'node:crypto';

import { inspectImage } from '../../media/media-storage.mjs';

const GALLERY_FIELDS = new Set([
  'id',
  'name',
  'p',
  'post_count',
  'uniqueness_score',
  'category_name',
  'style_description'
]);
const SAFE_PREVIEW_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

function fail(message) {
  throw new TypeError(`Illustrious NoobAI Style Explorer source is invalid: ${message}`);
}

function isIdentifierStart(character) {
  return /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character) {
  return /[A-Za-z0-9_$]/u.test(character);
}

function parseString(source, start) {
  const quote = source[start];
  let index = start + 1;
  let value = '';
  while (index < source.length) {
    const character = source[index];
    if (character === quote) return { value, index: index + 1 };
    if (character === '\\') {
      const escaped = source[index + 1];
      if (escaped === undefined) fail('unterminated string escape');
      const replacements = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (escaped === 'x' || escaped === 'u' || escaped === '\r' || escaped === '\n') fail('unsupported string escape');
      value += replacements[escaped] ?? escaped;
      index += 2;
      continue;
    }
    if (character === '\n' || character === '\r') fail('unterminated string literal');
    value += character;
    index += 1;
  }
  fail('unterminated string literal');
}

function tokenize(sourceText) {
  if (typeof sourceText !== 'string' || sourceText.length === 0) fail('sourceText must be a non-empty string');
  const tokens = [];
  let index = 0;
  while (index < sourceText.length) {
    const character = sourceText[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && sourceText[index + 1] === '/') {
      index = sourceText.indexOf('\n', index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === '/' && sourceText[index + 1] === '*') {
      const end = sourceText.indexOf('*/', index + 2);
      if (end === -1) fail('unterminated block comment');
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const parsed = parseString(sourceText, index);
      tokens.push({ type: 'string', value: parsed.value });
      index = parsed.index;
      continue;
    }
    if ('[]{}:,;='.includes(character)) {
      tokens.push({ type: character, value: character });
      index += 1;
      continue;
    }
    if (character === '-' || /[0-9]/u.test(character)) {
      const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(sourceText.slice(index));
      if (!match) fail(`unsupported token at offset ${index}`);
      const boundary = sourceText[index + match[0].length];
      if (boundary !== undefined && /[A-Za-z0-9_$\.]/u.test(boundary)) fail(`unsupported token at offset ${index}`);
      tokens.push({ type: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < sourceText.length && isIdentifierPart(sourceText[end])) end += 1;
      tokens.push({ type: 'identifier', value: sourceText.slice(index, end) });
      index = end;
      continue;
    }
    fail(`unsupported token at offset ${index}`);
  }
  return tokens;
}

function parseLiteral(tokens, cursor) {
  const token = tokens[cursor.index];
  if (!token) fail('unexpected end of source');
  if (token.type === 'string' || token.type === 'number') {
    cursor.index += 1;
    return token.value;
  }
  if (token.type === 'identifier') {
    if (token.value === 'true' || token.value === 'false' || token.value === 'null') {
      cursor.index += 1;
      return token.value === 'null' ? null : token.value === 'true';
    }
    fail(`expression ${token.value} is not permitted`);
  }
  if (token.type === '[') return parseArray(tokens, cursor);
  if (token.type === '{') return parseObject(tokens, cursor);
  fail(`expression ${token.value} is not permitted`);
}

function parseArray(tokens, cursor) {
  cursor.index += 1;
  const values = [];
  if (tokens[cursor.index]?.type === ']') {
    cursor.index += 1;
    return values;
  }
  while (true) {
    values.push(parseLiteral(tokens, cursor));
    if (tokens[cursor.index]?.type === ']') {
      cursor.index += 1;
      return values;
    }
    if (tokens[cursor.index]?.type !== ',') fail('array values must be separated by commas');
    cursor.index += 1;
    if (tokens[cursor.index]?.type === ']') {
      cursor.index += 1;
      return values;
    }
  }
}

function parseObject(tokens, cursor) {
  cursor.index += 1;
  const value = Object.create(null);
  if (tokens[cursor.index]?.type === '}') {
    cursor.index += 1;
    return value;
  }
  while (true) {
    const key = tokens[cursor.index];
    if (!key || (key.type !== 'identifier' && key.type !== 'string')) fail('object keys must be static identifiers or strings');
    cursor.index += 1;
    if (Object.hasOwn(value, key.value)) fail(`duplicate object property ${key.value}`);
    if (tokens[cursor.index]?.type !== ':') fail(`object property ${key.value} must use a colon`);
    cursor.index += 1;
    value[key.value] = parseLiteral(tokens, cursor);
    if (tokens[cursor.index]?.type === '}') {
      cursor.index += 1;
      return value;
    }
    if (tokens[cursor.index]?.type !== ',') fail('object properties must be separated by commas');
    cursor.index += 1;
    if (tokens[cursor.index]?.type === '}') {
      cursor.index += 1;
      return value;
    }
  }
}

function parseGalleryDataDeclaration(sourceText) {
  const tokens = tokenize(sourceText);
  const cursor = { index: 0 };
  if (tokens[cursor.index]?.value !== 'const') fail('expected const galleryData declaration');
  cursor.index += 1;
  if (tokens[cursor.index]?.type !== 'identifier' || tokens[cursor.index]?.value !== 'galleryData') fail('expected galleryData declaration');
  cursor.index += 1;
  if (tokens[cursor.index]?.type !== '=') fail('galleryData must be assigned a static literal');
  cursor.index += 1;
  const galleryData = parseLiteral(tokens, cursor);
  if (tokens[cursor.index]?.type === ';') cursor.index += 1;
  if (cursor.index !== tokens.length) fail('source contains an unexpected declaration or expression');
  return galleryData;
}

function parseDeclarations(sourceText) {
  const tokens = tokenize(sourceText);
  const cursor = { index: 0 };
  const declarations = Object.create(null);
  for (const requiredName of ['galleryData', 'promptLines']) {
    if (tokens[cursor.index]?.value !== 'const') fail(`expected const ${requiredName} declaration`);
    cursor.index += 1;
    if (tokens[cursor.index]?.type !== 'identifier' || tokens[cursor.index]?.value !== requiredName) fail(`expected ${requiredName} declaration`);
    cursor.index += 1;
    if (tokens[cursor.index]?.type !== '=') fail(`${requiredName} must be assigned a static literal`);
    cursor.index += 1;
    declarations[requiredName] = parseLiteral(tokens, cursor);
    if (tokens[cursor.index]?.type === ';') cursor.index += 1;
  }
  if (cursor.index !== tokens.length) fail('source contains an unexpected declaration or expression');
  return declarations;
}

function canonicalText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail(`${label} must be non-empty text without control characters`);
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (normalized === '') fail(`${label} must contain non-whitespace text`);
  return normalized;
}

function normalizeName(value) {
  return canonicalText(value, 'name').toLocaleLowerCase('und');
}

function splitSourceName(value) {
  const decoded = value.replace(/\\([()])/gu, '$1');
  const match = /^\s*([^()\t]+?)(?:\s*\(([^()\t]+)\))*\s*$/u.exec(decoded);
  if (!match) fail(`name ${JSON.stringify(value)} must use "name (alias)" syntax`);
  const name = canonicalText(match[1], 'name');
  const aliases = [];
  for (const aliasMatch of decoded.matchAll(/\s*\(([^()\t]+)\)/gu)) {
    const alias = canonicalText(aliasMatch[1], 'alias');
    if (normalizeName(alias) !== normalizeName(name) && !aliases.some((item) => normalizeName(item) === normalizeName(alias))) aliases.push(alias);
  }
  return { name, aliases };
}

function assertSafePreviewSegment(value, label) {
  const normalized = Number.isInteger(value) && value >= 0 ? String(value) : value;
  if (typeof normalized !== 'string' || !SAFE_PREVIEW_SEGMENT.test(normalized)) fail(`${label} must be a safe preview path segment`);
  return normalized;
}

function assertGalleryData(galleryData) {
  if (!Array.isArray(galleryData) || galleryData.length === 0) fail('galleryData must be a non-empty array');
  const result = galleryData.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`galleryData[${index}] must be an object`);
    for (const field of Object.keys(entry)) if (!GALLERY_FIELDS.has(field)) fail(`galleryData[${index}] has unsupported property ${field}`);
    const id = assertSafePreviewSegment(entry.id, `galleryData[${index}].id`);
    const name = canonicalText(entry.name, `galleryData[${index}].name`);
    const rawPreviews = Array.isArray(entry.p) ? entry.p : [entry.p];
    if (rawPreviews.length === 0) fail(`galleryData[${index}].p must be a non-empty array or preview directory value`);
    const previews = rawPreviews.map((preview, previewIndex) => assertSafePreviewSegment(preview, `galleryData[${index}].p[${previewIndex}]`));
    if (new Set(previews).size !== previews.length) fail(`galleryData[${index}].p contains duplicate preview references`);
    return Object.freeze({ ...entry, id, name, p: Object.freeze(previews) });
  });
  if (new Set(result.map(({ id }) => id)).size !== result.length) fail('galleryData contains duplicate id values');
  return result;
}

function buildParsedSource(galleryData, promptLines) {
  const safeGalleryData = assertGalleryData(galleryData);
  if (!Array.isArray(promptLines) || promptLines.length === 0 || promptLines.some((line) => typeof line !== 'string' || line.length === 0)) fail('promptLines must be a non-empty array of strings');
  if (safeGalleryData.length !== promptLines.length) fail('galleryData and promptLines count mismatch');
  const records = safeGalleryData.map((entry, index) => {
    const rawPromptLine = promptLines[index];
    const tab = rawPromptLine.indexOf('\t');
    if (tab <= 0 || rawPromptLine.indexOf('\t', tab + 1) !== -1) fail(`promptLines[${index}] must contain exactly one name separator`);
    const galleryName = splitSourceName(entry.name);
    const promptName = splitSourceName(rawPromptLine.slice(0, tab));
    if (normalizeName(galleryName.name) !== normalizeName(promptName.name)
      || galleryName.aliases.some((galleryAlias) => !promptName.aliases.some((alias) => normalizeName(alias) === normalizeName(galleryAlias)))) {
      fail(`promptLines[${index}] name mismatch with galleryData[${index}].name`);
    }
    return Object.freeze({
      name: promptName.name,
      aliases: Object.freeze(promptName.aliases),
      prompt_text: canonicalText(rawPromptLine.slice(tab + 1), `promptLines[${index}] prompt body`),
      preview_refs: Object.freeze([...entry.p])
    });
  });
  return Object.freeze({ galleryData: Object.freeze(safeGalleryData), promptLines: Object.freeze([...promptLines]), records: Object.freeze(records) });
}

export function parseIllustriousNoobaiStyleExplorerSource(sourceText) {
  const { galleryData, promptLines } = parseDeclarations(sourceText);
  return buildParsedSource(galleryData, promptLines);
}

export function parseIllustriousNoobaiStyleExplorerGalleryData(sourceText) {
  return assertGalleryData(parseGalleryDataDeclaration(sourceText));
}

function parseExistingAliases(value, label) {
  if (value === undefined || value === null) return [];
  let aliases;
  try {
    aliases = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    fail(`${label} aliases must be a JSON array`);
  }
  if (!Array.isArray(aliases)) fail(`${label} aliases must be an array`);
  return aliases.map((alias, index) => canonicalText(alias, `${label} aliases[${index}]`));
}

function mergeAliases(canonicalName, aliasLists) {
  const aliases = [];
  for (const alias of aliasLists.flat()) {
    const normalized = normalizeName(alias);
    if (normalized !== normalizeName(canonicalName) && !aliases.some((item) => normalizeName(item) === normalized)) aliases.push(alias);
  }
  return aliases;
}

function prepareExistingStyles(existingStyles, baseModelId) {
  if (existingStyles === undefined) return [];
  if (!Array.isArray(existingStyles)) fail('existingStyles must be an array');
  return existingStyles.map((style, index) => {
    if (!style || typeof style !== 'object') fail(`existingStyles[${index}] must be an object`);
    return Object.freeze({
      base_model_id: baseModelId,
      row_id: style.id ?? null,
      name: canonicalText(style.name, `existingStyles[${index}].name`),
      aliases: Object.freeze(parseExistingAliases(style.aliases_json ?? style.aliases, `existingStyles[${index}]`)),
      prompt_text: canonicalText(style.prompt_text, `existingStyles[${index}].prompt_text`),
      style_description: style.style_description ?? null,
      cover_media_path: style.cover_media_path ?? null
    });
  });
}

function prepareExistingStyleIndex(existingStyles) {
  const byName = new Map();
  const byAlias = new Map();
  const add = (index, key, style) => {
    const entries = index.get(key) ?? [];
    entries.push(style);
    index.set(key, entries);
  };
  for (const style of existingStyles) {
    add(byName, normalizeName(style.name), style);
    for (const alias of style.aliases) add(byAlias, normalizeName(alias), style);
  }
  return Object.freeze({ byName, byAlias });
}

function matchExistingStyle(existingStyleIndex, record, { sourceCanonicalNames, sourceNameIsUnique }) {
  const scores = new Map();
  const add = (styles, score, distinguishing) => {
    for (const style of styles ?? []) {
      const existing = scores.get(style) ?? { score: -1, distinguishing: false };
      scores.set(style, { score: Math.max(existing.score, score), distinguishing: existing.distinguishing || distinguishing });
    }
  };
  add(existingStyleIndex.byName.get(normalizeName(record.name)), 4, false);
  add(existingStyleIndex.byAlias.get(normalizeName(record.name)), 2, true);
  for (const alias of record.aliases) {
    if (sourceCanonicalNames.has(normalizeName(alias))) continue;
    add(existingStyleIndex.byName.get(normalizeName(alias)), 3, true);
    add(existingStyleIndex.byAlias.get(normalizeName(alias)), 1, true);
  }
  const candidates = [...scores.entries()];
  if (candidates.length === 0) return null;
  const promptMatches = candidates.filter(([style]) => style.prompt_text === record.prompt_text).map(([style]) => style);
  const promptCandidates = promptMatches.length > 0 ? promptMatches : null;
  const usableCandidates = sourceNameIsUnique || promptCandidates
    ? candidates
    : candidates.filter(([, match]) => match.distinguishing);
  if (usableCandidates.length === 0) return null;
  const scoredCandidates = promptCandidates
    ? usableCandidates.filter(([style]) => promptCandidates.includes(style))
    : usableCandidates;
  const highestScore = Math.max(...scoredCandidates.map(([, match]) => match.score));
  const highest = scoredCandidates.filter(([, match]) => match.score === highestScore).map(([style]) => style);
  if (highest.length === 1) return highest[0];
  const equivalent = highest.every((style) => style.name === highest[0].name && style.prompt_text === highest[0].prompt_text);
  if (!equivalent) fail(`source record ${JSON.stringify(record.name)} matches multiple existing Style rows`);
  return [...highest].sort((left, right) => {
    if (Number.isInteger(left.row_id) && Number.isInteger(right.row_id)) return left.row_id - right.row_id;
    return String(left.name).localeCompare(String(right.name));
  })[0];
}

function assertHttpUrl(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an HTTP or HTTPS URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an HTTP or HTTPS URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') fail(`${label} must be an HTTP or HTTPS URL without credentials`);
  return parsed;
}

function assertPreviewUrl(previewRoot, sourceId, previewReference) {
  const expected = new URL(`${encodeURIComponent(sourceId)}/${encodeURIComponent(previewReference)}.png`, previewRoot);
  if (expected.origin !== previewRoot.origin || !expected.pathname.startsWith(previewRoot.pathname) || expected.search !== '' || expected.hash !== '') {
    fail('preview URL escapes the configured source origin or preview path');
  }
  return expected;
}

function makeIdentity(baseModelId, name) {
  return Object.freeze({ kind: 'style', base_model_id: baseModelId, parent_identity: 'root', normalized_name: canonicalText(name, 'name') });
}

function identityKey(identity) {
  return JSON.stringify(identity);
}

function cloneDetail(record, identity, sourceUrl, now) {
  return {
    identity,
    base_model_id: identity.base_model_id,
    source_url: sourceUrl,
    name: record.name,
    aliases: [...record.aliases],
    prompt_text: record.prompt_text,
    style_description: record.style_description ?? null,
    image_results: [],
    fetched_at: now().toISOString()
  };
}

async function requestPreview(request, sourceUrl) {
  try {
    if (typeof request !== 'function') fail('an injected request transport is required for selected previews');
    const response = await request(sourceUrl);
    if (!response || typeof response !== 'object' || response.redirected === true) fail('preview request returned an invalid redirect response');
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) fail('preview request must return an integer success status');
    if (typeof response.url !== 'string' || response.url !== sourceUrl) fail('preview request final URL does not match the selected preview URL');
    const declaredContentType = response.content_type ?? response.headers?.get?.('content-type');
    const contentType = typeof declaredContentType === 'string' ? declaredContentType.split(';', 1)[0].trim().toLocaleLowerCase('und') : null;
    if (!['image/png', 'image/webp'].includes(contentType)) fail('preview request content-type must be image/png or image/webp');
    if (!Buffer.isBuffer(response.bytes)) fail('preview request must return Buffer bytes');
    let image;
    try {
      image = inspectImage(response.bytes);
    } catch {
      fail('preview request returned unsupported image bytes');
    }
    if (image.mediaType !== contentType) fail('preview bytes do not match the declared image content type');
    return Object.freeze({ bytes: response.bytes, media_type: image.mediaType, content_hash: image.content_hash });
  } catch (error) {
    if (error && typeof error === 'object') {
      if (error.scope === undefined) error.scope = 'image';
      if (error.imageSourceUrl === undefined) error.imageSourceUrl = sourceUrl;
    }
    throw error;
  }
}

function imageFailure(detail, previewSourceId, previewReference, sourceUrl, error) {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    owner_identity: detail.identity,
    source_id: `preview:${createHash('sha256').update(`${previewSourceId}\u0000${previewReference}`).digest('hex')}`,
    source_url: sourceUrl,
    content_hash: null,
    sort_order: null,
    status: 'failed',
    error: { code: 'IMAGE_DOWNLOAD_FAILED', message: message.slice(0, 16_000) || 'local preview image read failed' }
  });
}

export function createIllustriousNoobaiStyleExplorerAdapter(options = {}) {
  const parsed = options.sourceText === undefined
    ? buildParsedSource(options.galleryData, options.promptLines)
    : parseIllustriousNoobaiStyleExplorerSource(options.sourceText);
  const sourceBaseUrl = assertHttpUrl(options.sourceBaseUrl, 'sourceBaseUrl');
  const sourceUrl = assertHttpUrl(options.sourceUrl ?? new URL('data.js', sourceBaseUrl).toString(), 'sourceUrl');
  if (sourceUrl.origin !== sourceBaseUrl.origin) fail('sourceUrl must remain on sourceBaseUrl origin');
  const previewRoot = assertHttpUrl(options.previewBaseUrl ?? new URL('preview/', sourceBaseUrl).toString(), 'previewBaseUrl');
  if (previewRoot.origin !== sourceBaseUrl.origin) fail('preview path must remain on sourceBaseUrl origin');
  const previewUrlBuilder = options.previewUrlBuilder ?? ((sourceId, previewReference) => assertPreviewUrl(previewRoot, sourceId, previewReference).toString());
  if (typeof previewUrlBuilder !== 'function') fail('previewUrlBuilder must be a function');
  const autoDownloadAllPreviews = options.autoDownloadAllPreviews === true;
  if (!Number.isSafeInteger(options.baseModelId) || options.baseModelId < 1) fail('baseModelId must be a positive integer');
  const baseModelId = options.baseModelId;
  if (options.readPreview !== undefined && typeof options.readPreview !== 'function') fail('readPreview must be a function');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const existingStyles = prepareExistingStyles(options.existingStyles, baseModelId);
  const existingStyleIndex = prepareExistingStyleIndex(existingStyles);
  const sourceNameCounts = new Map();
  for (const record of parsed.records) {
    const normalized = normalizeName(record.name);
    sourceNameCounts.set(normalized, (sourceNameCounts.get(normalized) ?? 0) + 1);
  }
  const resolvedRecords = parsed.galleryData.map((gallery, index) => {
    const record = parsed.records[index];
    const existing = matchExistingStyle(existingStyleIndex, record, {
      sourceCanonicalNames: sourceNameCounts,
      sourceNameIsUnique: sourceNameCounts.get(normalizeName(record.name)) === 1
    });
    const name = existing?.name ?? record.name;
    const aliases = existing ? mergeAliases(name, [existing.aliases, [record.name], record.aliases]) : record.aliases;
    const identity = makeIdentity(baseModelId, name);
    const promptText = existing?.prompt_text ?? record.prompt_text;
    return Object.freeze({ gallery, record: Object.freeze({ ...record, name, aliases: Object.freeze([...aliases]), prompt_text: promptText }), identity, existing });
  });
  const recordsByIdentity = new Map(resolvedRecords.map((entry) => [identityKey(entry.identity), entry]));
  if (recordsByIdentity.size !== resolvedRecords.length) fail('multiple source records resolve to the same Style identity');
  const selectedPreviews = new WeakMap();

  function getRecord(identity) {
    if (!identity || identity.kind !== 'style' || identity.parent_identity !== 'root' || identity.base_model_id !== baseModelId || typeof identity.normalized_name !== 'string') fail('Style identity must include the configured base_model_id, parent_identity, and normalized_name');
    const found = recordsByIdentity.get(identityKey(identity));
    if (!found) fail('Style identity is not in this source');
    return { previewSourceId: found.gallery.id, ...found };
  }

  async function fetchDetail(task = {}) {
    const { identity, record } = getRecord(task.identity);
    return cloneDetail(record, identity, sourceUrl.toString(), now);
  }

  return Object.freeze({
    kind: 'illustrious-noobai-style-explorer',
    sourceConfig: Object.freeze({ schema_version: 1, source_name: 'illustrious-noobai-style-explorer', source_base_url: sourceBaseUrl.toString() }),
    async discoverCatalog() {
      return resolvedRecords.map((entry) => Object.freeze({
        identity: entry.identity,
        source_url: sourceUrl.toString(),
        name: entry.record.name,
        discovered_at: now().toISOString()
      }));
    },
    fetchDetail,
    async fetchSelectedPreview(task = {}) {
      const { identity, record } = getRecord(task.identity);
      const previewIndex = task.preview_index;
      if (!Number.isInteger(previewIndex) || previewIndex < 0 || previewIndex >= record.preview_refs.length) fail('selected preview_index is out of range');
      const detail = cloneDetail(record, identity, sourceUrl.toString(), now);
      selectedPreviews.set(detail, previewIndex);
      return detail;
    },
    async downloadImages(detail) {
      const previewIndex = selectedPreviews.get(detail);
      if (previewIndex === undefined && !autoDownloadAllPreviews) return { ...detail, image_results: [] };
      const { previewSourceId, record } = getRecord(detail.identity);
      const previewIndexes = previewIndex === undefined ? record.preview_refs.map((_, index) => index) : [previewIndex];
      const imageResults = [];
      for (const currentIndex of previewIndexes) {
        const previewReference = record.preview_refs[currentIndex];
        const preview = assertHttpUrl(previewUrlBuilder(previewSourceId, previewReference), 'preview URL');
        if (preview.origin !== previewRoot.origin || !preview.pathname.startsWith(previewRoot.pathname) || preview.search !== '' || preview.hash !== '') fail('preview URL escapes the configured source origin or preview path');
        try {
          const image = options.readPreview
            ? await options.readPreview(Object.freeze({ sourceId: previewSourceId, previewReference, sourceUrl: preview.toString() }))
            : await requestPreview(options.request, preview.toString());
          if (!image || !Buffer.isBuffer(image.bytes)) fail('local preview reader must return Buffer bytes');
          const inspected = inspectImage(image.bytes);
          if (typeof image.media_type === 'string' && image.media_type !== inspected.mediaType) fail('local preview bytes do not match the declared image media type');
          imageResults.push({
            owner_identity: detail.identity,
            source_id: `preview:${createHash('sha256').update(`${previewSourceId}\u0000${previewReference}`).digest('hex')}`,
            source_url: preview.toString(),
            content_hash: inspected.content_hash,
            sort_order: currentIndex,
            status: 'downloaded',
            bytes: image.bytes,
            media_type: inspected.mediaType
          });
        } catch (error) {
          if (previewIndex !== undefined) throw error;
          imageResults.push({ ...imageFailure(detail, previewSourceId, previewReference, preview.toString(), error), sort_order: currentIndex });
        }
      }
      return {
        ...detail,
        image_results: imageResults
      };
    }
  });
}
