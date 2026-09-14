import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG_PATH, loadConfig, validateConfig } from '../../app/config/load-config.mjs';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;

function validConfig() {
  return structuredClone(loadConfig({ environment: {} }));
}

function assertInvalid(change, message) {
  const config = validConfig();
  change(config);
  assert.throws(() => validateConfig(config), message);
}

test('loads the documented defaults without an environment override', () => {
  const config = loadConfig({ environment: {} });

  assert.equal(config.listeners.public.host, '0.0.0.0');
  assert.equal(config.listeners.public.port, 18082);
  assert.equal(config.listeners.internal.host, '127.0.0.1');
  assert.equal(config.listeners.internal.port, 18083);
  assert.equal(config.internal_api_timeout_ms, 60000);
  assert.equal(config.http_request_timeout_ms, 15000);
  assert.deepEqual(config.logging, { level: 'debug', directory: 'diagnostics', max_file_bytes: 10485760, max_archives: 5 });
  assert.deepEqual(config.runtime, { config_version: 'v0.11', api_public_prefix: '/api', media_public_prefix: '/media' });
  assert.deepEqual(config.uploads.allowed_media_types, ['image/jpeg', 'image/png', 'image/webp']);
  assert.deepEqual(config.generation_resources.file_format_suggestions, ['safetensors', 'ckpt', 'pt', 'pth', 'bin', 'gguf', 'onnx', 'dduf', 'diffusers', 'other']);
  assert.deepEqual(config.generation_resources.precision_or_quantization_suggestions, ['none', 'fp16', 'bf16', 'fp8', 'int8', 'int4', 'nf4', 'other']);
  assert.equal(Object.isFrozen(config.generation_resources), true);
  assert.equal(Object.isFrozen(config.generation_resources.file_format_suggestions), true);
  assert.equal(Object.isFrozen(config.generation_resources.precision_or_quantization_suggestions), true);
  assert.deepEqual(config.comfyui, { credential_encryption_key: 'local-development-key-replace-before-production' });
  assert.equal(config.data_directory, 'data');
  assert.deepEqual(config.crawler.allowed_source_origins, ['https://2x.nz', 'https://api-ai.acofork.com']);
  assert.equal(DEFAULT_CONFIG_PATH.endsWith('/config/defaults.json'), true);
});

test('keeps explicit valid environment port and timeout overrides', () => {
  const config = loadConfig({
    environment: {
      NOOBAI_PUBLIC_PORT: '1',
      NOOBAI_INTERNAL_PORT: '65535',
      NOOBAI_INTERNAL_API_TIMEOUT_MS: '7000',
      NOOBAI_HTTP_REQUEST_TIMEOUT_MS: '7001',
      NOOBAI_LOG_LEVEL: 'warn',
      NOOBAI_LOG_DIRECTORY: 'logs/runtime',
      NOOBAI_LOG_MAX_FILE_BYTES: '4096',
      NOOBAI_LOG_MAX_ARCHIVES: '3'
    }
  });

  assert.equal(config.listeners.public.port, 1);
  assert.equal(config.listeners.internal.port, 65535);
  assert.equal(config.internal_api_timeout_ms, 7000);
  assert.equal(config.http_request_timeout_ms, 7001);
  assert.deepEqual(config.logging, { level: 'warn', directory: 'logs/runtime', max_file_bytes: 4096, max_archives: 3 });
});

test('rejects invalid environment overrides before a listener can be created', () => {
  assert.throws(() => loadConfig({ environment: { NOOBAI_PUBLIC_PORT: '0' } }), /decimal TCP port/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_PUBLIC_PORT: '65536' } }), /between 1 and 65535/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_PUBLIC_PORT: 8080 } }), /decimal TCP port/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_INTERNAL_API_TIMEOUT_MS: '0' } }), /positive integer/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_INTERNAL_API_TIMEOUT_MS: '1.5' } }), /positive integer/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_HTTP_REQUEST_TIMEOUT_MS: '0' } }), /positive integer/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_HTTP_REQUEST_TIMEOUT_MS: '1.5' } }), /positive integer/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_LOG_LEVEL: 'verbose' } }), /NOOBAI_LOG_LEVEL/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_LOG_DIRECTORY: '../outside' } }), /NOOBAI_LOG_DIRECTORY/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_LOG_MAX_FILE_BYTES: '0' } }), /positive integer/);
  assert.throws(() => loadConfig({ environment: { NOOBAI_LOG_MAX_ARCHIVES: '0' } }), /positive integer/);
  assert.throws(
    () => loadConfig({ environment: { NOOBAI_PUBLIC_PORT: '18080', NOOBAI_INTERNAL_PORT: '18080' } }),
    /distinct ports/
  );
});

test('rejects unknown properties at every configuration object boundary', () => {
  const cases = [
    [(config) => { config.unexpected = true; }, /configuration has unknown property unexpected/],
    [(config) => { config.listeners.unexpected = true; }, /configuration\.listeners has unknown property unexpected/],
    [(config) => { config.listeners.public.unexpected = true; }, /configuration\.listeners\.public has unknown property unexpected/],
    [(config) => { config.listeners.internal.unexpected = true; }, /configuration\.listeners\.internal has unknown property unexpected/],
    [(config) => { config.comfyui.unexpected = true; }, /configuration\.comfyui has unknown property unexpected/],
    [(config) => { config.generation_resources.unexpected = true; }, /configuration\.generation_resources has unknown property unexpected/],
    [(config) => { config.uploads.unexpected = true; }, /configuration\.uploads has unknown property unexpected/],
    [(config) => { config.crawler.unexpected = true; }, /configuration\.crawler has unknown property unexpected/],
    [(config) => { config.logging.unexpected = true; }, /configuration\.logging has unknown property unexpected/]
  ];

  for (const [change, message] of cases) {
    assertInvalid(change, message);
  }
});

test('rejects missing required configuration fields', () => {
  const cases = [
    [(config) => { delete config.listeners; }, /configuration\.listeners is required/],
    [(config) => { delete config.data_directory; }, /configuration\.data_directory is required/],
    [(config) => { delete config.listeners.public; }, /configuration\.listeners\.public is required/],
    [(config) => { delete config.listeners.public.host; }, /configuration\.listeners\.public\.host is required/],
    [(config) => { delete config.listeners.internal.port; }, /configuration\.listeners\.internal\.port is required/],
    [(config) => { delete config.runtime; }, /configuration\.runtime is required/],
    [(config) => { delete config.comfyui.credential_encryption_key; }, /configuration\.comfyui\.credential_encryption_key is required/],
    [(config) => { delete config.generation_resources; }, /configuration\.generation_resources is required/],
    [(config) => { delete config.generation_resources.file_format_suggestions; }, /configuration\.generation_resources\.file_format_suggestions is required/],
    [(config) => { delete config.generation_resources.precision_or_quantization_suggestions; }, /configuration\.generation_resources\.precision_or_quantization_suggestions is required/],
    [(config) => { delete config.internal_api_timeout_ms; }, /configuration\.internal_api_timeout_ms is required/],
    [(config) => { delete config.http_request_timeout_ms; }, /configuration\.http_request_timeout_ms is required/],
    [(config) => { delete config.uploads; }, /configuration\.uploads is required/],
    [(config) => { delete config.uploads.allowed_media_types; }, /configuration\.uploads\.allowed_media_types is required/],
    [(config) => { delete config.crawler; }, /configuration\.crawler is required/],
    [(config) => { delete config.crawler.allowed_source_origins; }, /configuration\.crawler\.allowed_source_origins is required/],
    [(config) => { delete config.logging; }, /configuration\.logging is required/]
  ];

  for (const [change, message] of cases) {
    assertInvalid(change, message);
  }
});

test('rejects wrong object and scalar types', () => {
  const cases = [
    [(config) => { config.listeners = []; }, /configuration\.listeners must be an object/],
    [(config) => { config.listeners.public = null; }, /configuration\.listeners\.public must be an object/],
    [(config) => { config.listeners.internal.port = '8081'; }, /configuration\.listeners\.internal\.port must be a TCP port/],
    [(config) => { config.runtime.api_public_prefix = 'https://api.example.test/path/'; }, /public prefix/],
    [(config) => { config.runtime.api_public_prefix = '/a/../api'; }, /public prefix/],
    [(config) => { config.runtime.api_public_prefix = '/api?version=1'; }, /public prefix/],
    [(config) => { config.internal_api_timeout_ms = false; }, /configuration\.internal_api_timeout_ms must be a positive integer/],
    [(config) => { config.http_request_timeout_ms = false; }, /configuration\.http_request_timeout_ms must be a positive integer/],
    [(config) => { config.uploads = []; }, /configuration\.uploads must be an object/],
    [(config) => { config.generation_resources = []; }, /configuration\.generation_resources must be an object/],
    [(config) => { config.uploads.max_file_bytes = '1024'; }, /configuration\.uploads\.max_file_bytes must be between/],
    [(config) => { config.crawler = null; }, /configuration\.crawler must be an object/],
    [(config) => { config.crawler.allowed_source_origins = 'https://source.example'; }, /must be an array/],
    [(config) => { config.logging.level = 'verbose'; }, /configuration\.logging\.level must be a log level/],
    [(config) => { config.logging.directory = '../outside'; }, /configuration\.logging\.directory must be a relative data directory/]
  ];

  for (const [change, message] of cases) {
    assertInvalid(change, message);
  }
});

test('validates configurable model and LoRA file attribute suggestions', () => {
  const cases = [
    [(config) => { config.generation_resources.file_format_suggestions = []; }, /configuration\.generation_resources\.file_format_suggestions must contain at least 1 item/],
    [(config) => { config.generation_resources.file_format_suggestions = ['']; }, /configuration\.generation_resources\.file_format_suggestions\[0\].*non-empty/u],
    [(config) => { config.generation_resources.file_format_suggestions = ['  ']; }, /configuration\.generation_resources\.file_format_suggestions\[0\].*non-empty/u],
    [(config) => { config.generation_resources.file_format_suggestions = ['safe\u0000tensor']; }, /configuration\.generation_resources\.file_format_suggestions\[0\].*control character/u],
    [(config) => { config.generation_resources.file_format_suggestions = ['x'.repeat(65)]; }, /configuration\.generation_resources\.file_format_suggestions\[0\].*64/u],
    [(config) => { config.generation_resources.file_format_suggestions = ['custom', 'custom']; }, /configuration\.generation_resources\.file_format_suggestions must not contain duplicate items/],
    [(config) => { config.generation_resources.precision_or_quantization_suggestions = []; }, /configuration\.generation_resources\.precision_or_quantization_suggestions must contain at least 1 item/],
    [(config) => { config.generation_resources.precision_or_quantization_suggestions = ['\n']; }, /configuration\.generation_resources\.precision_or_quantization_suggestions\[0\].*control character/u],
    [(config) => { config.generation_resources.precision_or_quantization_suggestions = ['q'.repeat(65)]; }, /configuration\.generation_resources\.precision_or_quantization_suggestions\[0\].*64/u],
    [(config) => { config.generation_resources.precision_or_quantization_suggestions = ['fp16', 'fp16']; }, /configuration\.generation_resources\.precision_or_quantization_suggestions must not contain duplicate items/]
  ];

  for (const [change, message] of cases) assertInvalid(change, message);

  const config = validConfig();
  config.generation_resources.file_format_suggestions = ['custom-format'];
  config.generation_resources.precision_or_quantization_suggestions = ['custom-precision'];
  assert.doesNotThrow(() => validateConfig(config));
});

test('accepts same-origin, root-relative and absolute public URL prefixes', () => {
  for (const [apiPrefix, mediaPrefix] of [['', ''], ['/', ''], ['/backend/api', '/assets'], ['https://api.example.test/v1', 'https://cdn.example.test/assets']]) {
    const config = validConfig();
    config.runtime.api_public_prefix = apiPrefix;
    config.runtime.media_public_prefix = mediaPrefix;
    assert.doesNotThrow(() => validateConfig(config), `${apiPrefix} ${mediaPrefix}`);
  }
  assertInvalid((config) => { config.runtime.api_public_prefix = '/backend'; config.runtime.media_public_prefix = '/backend/media'; }, /must not overlap/);
  assertInvalid((config) => { config.runtime.api_public_prefix = ''; config.runtime.media_public_prefix = '/media'; }, /empty API public prefix/);
});

test('enforces listener ports and internal timeout value boundaries', () => {
  for (const port of [0, 65536, 1.5]) {
    assertInvalid((config) => { config.listeners.public.port = port; }, /configuration\.listeners\.public\.port must be a TCP port/);
  }
  assertInvalid((config) => { config.listeners.public.port = 18083; }, /distinct ports/);
  assertInvalid((config) => { config.internal_api_timeout_ms = 0; }, /positive integer/);
  assertInvalid((config) => { config.internal_api_timeout_ms = Number.MAX_SAFE_INTEGER + 1; }, /positive integer/);
  assertInvalid((config) => { config.http_request_timeout_ms = 0; }, /positive integer/);
  assertInvalid((config) => { config.http_request_timeout_ms = Number.MAX_SAFE_INTEGER + 1; }, /positive integer/);
});

test('enforces upload limits and the JPEG PNG WebP media-type whitelist', () => {
  const config = validConfig();
  config.uploads.max_file_bytes = 1;
  config.uploads.max_files_per_request = 1;
  config.uploads.allowed_media_types = ['image/jpeg'];
  assert.doesNotThrow(() => validateConfig(config));

  const cases = [
    [(config) => { config.uploads.max_file_bytes = 0; }, /max_file_bytes must be between/],
    [(config) => { config.uploads.max_file_bytes = MAX_UPLOAD_BYTES + 1; }, /max_file_bytes must be between/],
    [(config) => { config.uploads.max_files_per_request = 0; }, /max_files_per_request must be between/],
    [(config) => { config.uploads.max_files_per_request = MAX_UPLOAD_FILES + 1; }, /max_files_per_request must be between/],
    [(config) => { config.uploads.allowed_media_types = []; }, /must contain at least 1 item/],
    [(config) => { config.uploads.allowed_media_types = ['image/gif']; }, /must be an allowed media type/],
    [(config) => { config.uploads.allowed_media_types = ['image/jpeg', 'image/jpeg']; }, /must not contain duplicate items/]
  ];

  for (const [change, message] of cases) {
    assertInvalid(change, message);
  }
});

test('enforces a canonical unique HTTP or HTTPS source-origin whitelist', () => {
  const config = validConfig();
  config.crawler.allowed_source_origins = ['https://source.example', 'http://source.example:8080'];
  assert.doesNotThrow(() => validateConfig(config));

  const cases = [
    [(config) => { config.crawler.allowed_source_origins = ['ftp://source.example']; }, /HTTP or HTTPS origin/],
    [(config) => { config.crawler.allowed_source_origins = ['https://source.example/path']; }, /HTTP or HTTPS origin/],
    [(config) => { config.crawler.allowed_source_origins = ['https://source.example/']; }, /HTTP or HTTPS origin/],
    [(config) => { config.crawler.allowed_source_origins = ['https://source.example', 'https://source.example']; }, /must not contain duplicate items/],
    [(config) => { config.crawler.allowed_source_origins = [null]; }, /HTTP or HTTPS origin/]
  ];

  for (const [change, message] of cases) {
    assertInvalid(change, message);
  }
});
