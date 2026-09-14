import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUNTIME_MARKER = '<!-- NOOBAI_RUNTIME_CONFIG -->';
const APPLICATION_VERSION_MARKER = '<!-- NOOBAI_APPLICATION_VERSION -->';
const RUNTIME_ELEMENT_ID = 'noobai-runtime-config';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

function publicRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || !config.runtime) throw new Error('runtime configuration is required');
  const { config_version: version, api_public_prefix: apiPrefix, media_public_prefix: mediaPrefix } = config.runtime;
  if (typeof version !== 'string' || typeof apiPrefix !== 'string' || typeof mediaPrefix !== 'string') {
    throw new Error('runtime configuration is incomplete');
  }
  for (const field of ['http_request_timeout_ms']) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(`runtime configuration ${field} is required`);
  }
  return Object.freeze({
    config_version: version,
    api_public_prefix: apiPrefix,
    media_public_prefix: mediaPrefix,
    http_request_timeout_ms: config.http_request_timeout_ms
  });
}

function encodeRuntimeConfig(config) {
  return JSON.stringify(config)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

export function renderHtmlDocument(source, config, applicationVersion = null) {
  if (typeof source !== 'string') throw new TypeError('HTML source must be a string');
  const occurrences = source.split(RUNTIME_MARKER).length - 1;
  if (occurrences !== 1) throw new Error(`HTML must contain exactly one ${RUNTIME_MARKER} marker`);
  const element = `<script id="${RUNTIME_ELEMENT_ID}" type="application/json">${encodeRuntimeConfig(publicRuntimeConfig(config))}</script>`;
  let rendered = source.replace(RUNTIME_MARKER, element);
  if (rendered.includes(APPLICATION_VERSION_MARKER)) {
    if (typeof applicationVersion !== 'string' || applicationVersion.length === 0 || /[<>&]/u.test(applicationVersion)) throw new Error('application version is required for this HTML template');
    rendered = rendered.replace(APPLICATION_VERSION_MARKER, applicationVersion);
  }
  return rendered;
}

export function createWebRenderer({ webRoot, config, runtimeTemplateFileNames, applicationVersion = null } = {}) {
  if (typeof webRoot !== 'string' || webRoot.length === 0) throw new Error('webRoot is required');
  if (!Array.isArray(runtimeTemplateFileNames)) throw new Error('runtimeTemplateFileNames is required');
  const root = resolve(webRoot);
  const templates = new Map();
  for (const fileName of new Set(runtimeTemplateFileNames)) {
    const source = readFileSync(resolve(root, fileName), 'utf8');
    if ((source.split(RUNTIME_MARKER).length - 1) !== 1) {
      throw new Error(`HTML template ${fileName} is missing its runtime configuration marker`);
    }
    templates.set(fileName, source);
  }

  return Object.freeze({
    contentType: HTML_CONTENT_TYPE,
    isRuntimeTemplate: (fileName) => templates.has(fileName),
    render(fileName) {
      const source = templates.get(fileName);
      if (source === undefined) throw new Error(`HTML template ${fileName} is not registered`);
      return Buffer.from(renderHtmlDocument(source, config, applicationVersion));
    }
  });
}

export { APPLICATION_VERSION_MARKER, RUNTIME_MARKER, RUNTIME_ELEMENT_ID };
