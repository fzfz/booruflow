import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPrefixPath } from '../http/public-path.mjs';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_CONFIG_PATH = resolve(moduleDirectory, '../../config/defaults.json');
export const REPOSITORY_ROOT = resolve(moduleDirectory, '../..');

const PORT_MIN = 1;
const PORT_MAX = 65535;
const UPLOAD_MAX_FILE_BYTES = 10 * 1024 * 1024;
const UPLOAD_MAX_FILES_PER_REQUEST = 10;
const ALLOWED_MEDIA_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const LOG_LEVELS = Object.freeze(['error', 'warn', 'info', 'debug']);
const FILE_ATTRIBUTE_MAX_LENGTH = 64;

function isPublicPrefix(value) {
  if (typeof value !== 'string' || value.includes(String.fromCharCode(0)) || value.includes('\\') || value.includes('?') || value.includes('#') || value.includes('%')) return false;
  if (value === '') return true;
  if (value.startsWith('/')) {
    const segments = value.split('/');
    return !value.includes('//') && (value === '/' || !value.endsWith('/')) && !segments.some((segment) => segment === '.' || segment === '..');
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && !parsed.pathname.includes('//')
      && !parsed.pathname.split('/').some((segment) => segment === '.' || segment === '..')
      && (parsed.pathname === '/' || !parsed.pathname.endsWith('/'));
  } catch {
    return false;
  }
}

const CONFIG_RULES = Object.freeze({
  kind: 'object',
  fields: {
    data_directory: { kind: 'literal', value: 'data' },
    listeners: {
      kind: 'object',
      fields: {
        public: {
          kind: 'object',
          fields: {
            host: { kind: 'literal', value: '0.0.0.0' },
            port: { kind: 'integer', minimum: PORT_MIN, maximum: PORT_MAX, description: 'a TCP port' }
          }
        },
        internal: {
          kind: 'object',
          fields: {
            host: { kind: 'literal', value: '127.0.0.1' },
            port: { kind: 'integer', minimum: PORT_MIN, maximum: PORT_MAX, description: 'a TCP port' }
          }
        }
      }
    },
    runtime: {
      kind: 'object',
      fields: {
        config_version: { kind: 'literal', value: 'v0.11' },
        api_public_prefix: { kind: 'public-prefix', description: 'an empty, root-relative, HTTP, or HTTPS public prefix' },
        media_public_prefix: { kind: 'public-prefix', description: 'an empty, root-relative, HTTP, or HTTPS public prefix' }
      }
    },
    comfyui: {
      kind: 'object',
      fields: {
        credential_encryption_key: { kind: 'secret', minimumLength: 16, environment: 'NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY' }
      }
    },
    generation_resources: {
      kind: 'object',
      fields: {
        file_format_suggestions: {
          kind: 'array',
          minimumItems: 1,
          uniqueItems: true,
          item: { kind: 'file-attribute-suggestion' }
        },
        precision_or_quantization_suggestions: {
          kind: 'array',
          minimumItems: 1,
          uniqueItems: true,
          item: { kind: 'file-attribute-suggestion' }
        }
      }
    },
    internal_api_timeout_ms: {
      kind: 'integer',
      minimum: 1,
      description: 'a positive integer of milliseconds'
    },
    logging: {
      kind: 'object',
      fields: {
        level: { kind: 'string', allowedValues: LOG_LEVELS, description: 'a log level' },
        directory: { kind: 'relative-directory', description: 'a relative data directory' },
        max_file_bytes: { kind: 'integer', minimum: 1, description: 'a positive integer of bytes' },
        max_archives: { kind: 'integer', minimum: 1, maximum: 100, description: 'an integer between 1 and 100' }
      }
    },
    http_request_timeout_ms: {
      kind: 'integer',
      minimum: 1,
      description: 'a positive integer of milliseconds'
    },
    uploads: {
      kind: 'object',
      fields: {
        max_file_bytes: {
          kind: 'integer',
          minimum: 1,
          maximum: UPLOAD_MAX_FILE_BYTES,
          description: `between 1 and ${UPLOAD_MAX_FILE_BYTES}`
        },
        max_files_per_request: {
          kind: 'integer',
          minimum: 1,
          maximum: UPLOAD_MAX_FILES_PER_REQUEST,
          description: `between 1 and ${UPLOAD_MAX_FILES_PER_REQUEST}`
        },
        allowed_media_types: {
          kind: 'array',
          minimumItems: 1,
          uniqueItems: true,
          item: { kind: 'string', allowedValues: ALLOWED_MEDIA_TYPES, description: 'an allowed media type' }
        }
      }
    },
    crawler: {
      kind: 'object',
      fields: {
        allowed_source_origins: {
          kind: 'array',
          uniqueItems: true,
          item: { kind: 'http-origin' }
        }
      }
    }
  }
});

function readPort(environment, name, fallback) {
  const rawValue = environment[name];
  if (rawValue === undefined) {
    return fallback;
  }

  if (typeof rawValue !== 'string' || !/^[1-9][0-9]{0,4}$/.test(rawValue)) {
    throw new Error(`${name} must be a decimal TCP port`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < PORT_MIN || value > PORT_MAX) {
    throw new Error(`${name} must be between ${PORT_MIN} and ${PORT_MAX}`);
  }

  return value;
}

function readTimeout(environment, name, fallback) {
  const rawValue = environment[name];
  if (rawValue === undefined) {
    return fallback;
  }

  if (typeof rawValue !== 'string' || !/^[1-9][0-9]*$/.test(rawValue)) {
    throw new Error(`${name} must be a positive integer of milliseconds`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer of milliseconds`);
  }

  return value;
}

function readPositiveInteger(environment, name, fallback) {
  const rawValue = environment[name];
  if (rawValue === undefined) return fallback;
  if (typeof rawValue !== 'string' || !/^[1-9][0-9]*$/u.test(rawValue)) throw new Error(`${name} must be a positive integer`);
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function readLogLevel(environment, fallback) {
  const value = environment.NOOBAI_LOG_LEVEL ?? fallback;
  if (!LOG_LEVELS.includes(value)) throw new Error(`NOOBAI_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  return value;
}

function isRelativeDataDirectory(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && !value.includes(String.fromCharCode(0)) && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function readLogDirectory(environment, fallback) {
  const value = environment.NOOBAI_LOG_DIRECTORY ?? fallback;
  if (!isRelativeDataDirectory(value)) throw new Error('NOOBAI_LOG_DIRECTORY must be a relative data directory');
  return value;
}

function requirePlainObject(value, path) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function validateValue(value, path, rule) {
  if (rule.kind === 'object') {
    const object = requirePlainObject(value, path);
    const fieldNames = Object.keys(rule.fields);

    for (const key of Object.keys(object)) {
      if (!Object.hasOwn(rule.fields, key)) {
        throw new Error(`${path} has unknown property ${key}`);
      }
    }
    for (const key of fieldNames) {
      if (!Object.hasOwn(object, key)) {
        throw new Error(`${path}.${key} is required`);
      }
      validateValue(object[key], `${path}.${key}`, rule.fields[key]);
    }
    return;
  }

  if (rule.kind === 'literal') {
    if (value !== rule.value) {
      throw new Error(`${path} must be ${rule.value}`);
    }
    return;
  }

  if (rule.kind === 'integer') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${path} must be ${rule.description}`);
    }
    if (value < rule.minimum || (rule.maximum !== undefined && value > rule.maximum)) {
      throw new Error(`${path} must be ${rule.description}`);
    }
    return;
  }

  if (rule.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${path} must be ${rule.description}`);
    }
    return;
  }

  if (rule.kind === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array`);
    }
    if (rule.minimumItems !== undefined && value.length < rule.minimumItems) {
      throw new Error(`${path} must contain at least ${rule.minimumItems} item`);
    }
    if (rule.uniqueItems && new Set(value).size !== value.length) {
      throw new Error(`${path} must not contain duplicate items`);
    }
    for (const [index, item] of value.entries()) {
      validateValue(item, `${path}[${index}]`, rule.item);
    }
    return;
  }

  if (rule.kind === 'string') {
    if (typeof value !== 'string' || !rule.allowedValues.includes(value)) {
      throw new Error(`${path} must be ${rule.description}`);
    }
    return;
  }

  if (rule.kind === 'non-empty-string') {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${path} must be ${rule.description}`);
    }
    return;
  }

  if (rule.kind === 'file-attribute-suggestion') {
    if (typeof value !== 'string') {
      throw new Error(`${path} must be a non-empty string`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`${path} must not contain a control character`);
    }
    if (value.trim().length === 0) {
      throw new Error(`${path} must be a non-empty string`);
    }
    if (value !== value.trim()) {
      throw new Error(`${path} must not contain leading or trailing whitespace`);
    }
    if (value.length > FILE_ATTRIBUTE_MAX_LENGTH) {
      throw new Error(`${path} must contain at most ${FILE_ATTRIBUTE_MAX_LENGTH} UTF-16 code units`);
    }
    return;
  }

  if (rule.kind === 'secret') {
    if (typeof value !== 'string' || value.length < rule.minimumLength) {
      throw new Error(`${path} must contain at least ${rule.minimumLength} characters`);
    }
    return;
  }

  if (rule.kind === 'http-origin') {
    if (typeof value !== 'string') {
      throw new Error(`${path} must be an HTTP or HTTPS origin`);
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${path} must be an HTTP or HTTPS origin`);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== value) {
      throw new Error(`${path} must be an HTTP or HTTPS origin`);
    }
    return;
  }

  if (rule.kind === 'public-prefix') {
    if (!isPublicPrefix(value)) throw new Error(`${path} must be ${rule.description}`);
    return;
  }

  if (rule.kind === 'relative-directory') {
    if (!isRelativeDataDirectory(value)) throw new Error(`${path} must be ${rule.description}`);
    return;
  }

  throw new Error(`unknown configuration rule for ${path}`);
}

export function validateConfig(config) {
  validateValue(config, 'configuration', CONFIG_RULES);
  const apiPrefix = publicPrefixPath(config.runtime.api_public_prefix);
  const mediaPrefix = publicPrefixPath(config.runtime.media_public_prefix);
  if (apiPrefix === '' && mediaPrefix !== '') {
    throw new Error('an empty API public prefix cannot be combined with a non-empty media public prefix');
  }
  if (apiPrefix !== '/' && mediaPrefix !== '/' && apiPrefix !== '' && mediaPrefix !== '' && (apiPrefix === mediaPrefix || apiPrefix.startsWith(`${mediaPrefix}/`) || mediaPrefix.startsWith(`${apiPrefix}/`))) {
    throw new Error('runtime API and media public prefixes must not overlap');
  }
  if (config.listeners.public.port === config.listeners.internal.port) {
    throw new Error('public and internal listeners must use distinct ports');
  }
  return config;
}

export function resolveProductionDataPaths(config, { repositoryRoot = REPOSITORY_ROOT } = {}) {
  if (!config || config.data_directory !== 'data') {
    throw new Error('configuration.data_directory must be data');
  }
  const root = resolve(repositoryRoot);
  const dataRoot = resolve(root, config.data_directory);
  if (dataRoot !== resolve(root, 'data')) {
    throw new Error('production data directory must resolve to repository data/');
  }
  return Object.freeze({
    dataRoot,
    databasePath: resolve(dataRoot, 'app.sqlite'),
    mediaRoot: resolve(dataRoot, 'media'),
    cachePath: resolve(dataRoot, '.2x-nz-crawlee-records.json')
  });
}

export function loadConfig({ configPath = DEFAULT_CONFIG_PATH, environment = process.env } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot load configuration from ${configPath}: ${error.message}`, { cause: error });
  }

  const config = validateConfig(parsed);
  const resolvedConfig = validateConfig({
    ...config,
    listeners: {
      public: {
        ...config.listeners.public,
        port: readPort(environment, 'NOOBAI_PUBLIC_PORT', config.listeners.public.port)
      },
      internal: {
        ...config.listeners.internal,
        port: readPort(environment, 'NOOBAI_INTERNAL_PORT', config.listeners.internal.port)
      }
    },
    internal_api_timeout_ms: readTimeout(
      environment,
      'NOOBAI_INTERNAL_API_TIMEOUT_MS',
      config.internal_api_timeout_ms
    ),
    http_request_timeout_ms: readTimeout(
      environment,
      'NOOBAI_HTTP_REQUEST_TIMEOUT_MS',
      config.http_request_timeout_ms
    ),
    logging: {
      level: readLogLevel(environment, config.logging.level),
      directory: readLogDirectory(environment, config.logging.directory),
      max_file_bytes: readPositiveInteger(environment, 'NOOBAI_LOG_MAX_FILE_BYTES', config.logging.max_file_bytes),
      max_archives: readPositiveInteger(environment, 'NOOBAI_LOG_MAX_ARCHIVES', config.logging.max_archives)
    },
    comfyui: {
      ...config.comfyui,
      credential_encryption_key: environment.NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY ?? config.comfyui.credential_encryption_key
    }
  });

  return Object.freeze({
    ...resolvedConfig,
    listeners: Object.freeze({
      public: Object.freeze(resolvedConfig.listeners.public),
      internal: Object.freeze(resolvedConfig.listeners.internal)
    }),
    comfyui: Object.freeze(resolvedConfig.comfyui),
    generation_resources: Object.freeze({
      file_format_suggestions: Object.freeze([...resolvedConfig.generation_resources.file_format_suggestions]),
      precision_or_quantization_suggestions: Object.freeze([...resolvedConfig.generation_resources.precision_or_quantization_suggestions])
    }),
    logging: Object.freeze(resolvedConfig.logging)
  });
}
