import { readFileSync } from 'node:fs';

import { loadConfig } from './load-config.mjs';

export const REQUIRED_PRODUCTION_ENVIRONMENT_VALUES = Object.freeze([
  'NOOBAI_PUBLIC_PORT',
  'NOOBAI_INTERNAL_PORT',
  'NOOBAI_INTERNAL_API_TIMEOUT_MS',
  'NOOBAI_EMBEDDING_BASE_URL',
  'NOOBAI_EMBEDDING_API_KEY',
  'NOOBAI_EMBEDDING_MODEL',
  'NOOBAI_RERANKER_BASE_URL',
  'NOOBAI_RERANKER_API_KEY',
  'NOOBAI_RERANKER_MODEL'
]);

function fail(message) {
  throw new Error(message);
}

export function parseProductionEnvironment(text) {
  if (typeof text !== 'string') fail('production environment content must be text');

  const environment = Object.create(null);
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) fail('production environment contains an invalid entry');
    const name = line.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) fail('production environment contains an invalid setting name');
    if (Object.hasOwn(environment, name)) fail('production environment contains a duplicate setting');
    environment[name] = line.slice(separator + 1);
  }
  return Object.freeze(environment);
}

export function resolveProductionRuntimeConfiguration({
  environment,
  configPath,
  configLoader = loadConfig
} = {}) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('production environment must be an object');
  }
  for (const name of REQUIRED_PRODUCTION_ENVIRONMENT_VALUES) {
    if (typeof environment[name] !== 'string' || environment[name].length === 0) {
      fail(`production environment is missing a required value for ${name}`);
    }
  }
  const options = configPath === undefined ? { environment } : { configPath, environment };
  return configLoader(options);
}

export function loadProductionRuntimeConfiguration({
  environmentPath,
  configPath,
  readFile = readFileSync,
  configLoader = loadConfig
} = {}) {
  if (typeof environmentPath !== 'string' || environmentPath.length === 0) {
    fail('production environment path is required');
  }
  const environment = parseProductionEnvironment(readFile(environmentPath, 'utf8'));
  return resolveProductionRuntimeConfiguration({ environment, configPath, configLoader });
}
