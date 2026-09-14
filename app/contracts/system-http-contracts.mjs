import { readFileSync } from 'node:fs';

import { ContractViolation, parseOpenApiStructure, REPOSITORY_ROOT } from './authoritative-contracts.mjs';
import { resolveRepositoryContractFile } from './repository-contract-paths.mjs';

const OPENAPI_RELATIVE_PATH = 'schema/api/openapi.yaml';
const ERROR_CATALOG_RELATIVE_PATH = 'schema/api/error-catalog.json';

function fail(message) {
  throw new ContractViolation(message);
}

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    fail(`cannot read system HTTP ${label} contract ${path}: ${error.message}`);
  }
}

function readOpenApi(path) {
  const text = readText(path, 'OpenAPI');
  let value;
  try {
    value = parseOpenApiStructure(text);
  } catch (error) {
    if (error instanceof ContractViolation) throw error;
    fail(`system HTTP OpenAPI parsing failed for ${path}: ${error.message}`);
  }
  return { text, value };
}

function readErrorCatalog(path) {
  let value;
  try {
    value = JSON.parse(readText(path, 'error catalog'));
  } catch (error) {
    fail(`cannot parse system HTTP error catalog ${path}: ${error.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`system HTTP error catalog ${path} must contain an object`);
  return value;
}

export function loadSystemHttpContracts(repositoryRoot = REPOSITORY_ROOT) {
  const openapiSource = resolveRepositoryContractFile({ repositoryRoot, relativePath: OPENAPI_RELATIVE_PATH, label: 'system HTTP OpenAPI' });
  const errorCatalogSource = resolveRepositoryContractFile({ repositoryRoot: openapiSource.repositoryRoot, relativePath: ERROR_CATALOG_RELATIVE_PATH, label: 'system HTTP error catalog' });
  const { repositoryRoot: root, path: openapiPath } = openapiSource;
  const { path: errorCatalogPath } = errorCatalogSource;
  const openapi = readOpenApi(openapiPath);
  const errorCatalog = readErrorCatalog(errorCatalogPath);
  return Object.freeze({
    root,
    openapiPath,
    openapiText: openapi.text,
    openapi: openapi.value,
    errorCatalogPath,
    errorCatalog
  });
}
