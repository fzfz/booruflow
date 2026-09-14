import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ContractViolation,
  DRAFT_2020_12,
  REPOSITORY_ROOT,
  resolveSchemaReference
} from './authoritative-contracts.mjs';

const FILE_CLEANUP_SCHEMA = 'schema/file-cleanup.schema.json';
const COMMON_SCHEMA = 'schema/crawler/common.schema.json';

function fail(message) {
  throw new ContractViolation(message);
}

function readSchema(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot parse file-cleanup schema ${path}: ${error.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`file-cleanup schema ${path} must contain an object`);
  if (value.$schema !== DRAFT_2020_12) fail(`file-cleanup schema ${path} must declare JSON Schema Draft 2020-12`);
  if (typeof value.$id !== 'string' || value.$id.length === 0) fail(`file-cleanup schema ${path} must declare a non-empty $id`);
  return value;
}

function collectReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') references.push(child);
      collectReferences(child, references);
    }
  }
  return references;
}

export function loadFileCleanupContracts(repositoryRoot = REPOSITORY_ROOT) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim().length === 0) throw new TypeError('repositoryRoot must be a non-empty string');
  const root = resolve(repositoryRoot);
  const schemaPath = resolve(root, FILE_CLEANUP_SCHEMA);
  const commonSchemaPath = resolve(root, COMMON_SCHEMA);
  const schemas = new Map([
    [schemaPath, readSchema(schemaPath)],
    [commonSchemaPath, readSchema(commonSchemaPath)]
  ]);
  for (const [sourcePath, schema] of schemas) {
    for (const reference of collectReferences(schema)) resolveSchemaReference(reference, sourcePath, schemas);
  }
  return Object.freeze({ root, schemaPath, schemas });
}
