(function installRuntimeUrls(global) {
  const configElement = global.document?.getElementById?.('noobai-runtime-config');
  if (!configElement) throw new Error('runtime configuration marker is missing from the HTML document');

  let config;
  try {
    config = JSON.parse(configElement.textContent);
  } catch (error) {
    throw new Error('runtime configuration is not valid JSON', { cause: error });
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('runtime configuration must be an object');
  for (const field of ['config_version', 'api_public_prefix', 'media_public_prefix']) {
    if (typeof config[field] !== 'string') throw new Error(`runtime configuration ${field} is required`);
  }
  for (const field of ['http_request_timeout_ms']) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(`runtime configuration ${field} is required`);
  }

  function locationUrl() {
    return global.window?.location?.href || global.location?.href || 'http://noobai.local/';
  }

  function prefixedUrl(prefix, suffix) {
    if (typeof suffix !== 'string' || !suffix.startsWith('/')) throw new Error('runtime URL suffix must be root-relative');
    const base = new URL(prefix || '/', locationUrl());
    const suffixUrl = new URL(suffix, 'http://noobai.local/');
    const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/u, '');
    base.pathname = `${basePath}${suffixUrl.pathname}` || '/';
    base.search = suffixUrl.search;
    base.hash = '';
    return base.toString();
  }

  function api(path) {
    return prefixedUrl(config.api_public_prefix, path);
  }

  function media(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes(String.fromCharCode(0)) || relativePath.includes('\\')) {
      throw new Error('media path must be a non-empty slash-separated relative path');
    }
    const segments = relativePath.split('/');
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new Error('media path contains an unsafe segment');
    }
    return prefixedUrl(config.media_public_prefix, `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`);
  }

  global.__NOOBAI_URLS__ = Object.freeze({ config: Object.freeze(config), api, media });
}(globalThis));
