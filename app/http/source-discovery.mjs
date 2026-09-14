import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';

import { resolveRepositoryContractFile } from '../contracts/repository-contract-paths.mjs';
import { SOURCE_DISCOVERY_OPERATION_ID, SOURCE_DISCOVERY_PATH } from '../contracts/source-contract.mjs';

const HTTP_METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const SOURCE_PREFIX = `${SOURCE_DISCOVERY_PATH}/`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`Source discovery contract is invalid: ${message}`);
}

function parseOpenApi(sourcePath) {
  let document;
  try { document = parseDocument(readFileSync(sourcePath, 'utf8'), { strict: true }); }
  catch (error) { fail(`OpenAPI could not be read: ${error.message}`); }
  if (document.errors.length > 0) fail(`OpenAPI could not be parsed: ${document.errors.map((error) => error.message).join('; ')}`);
  const root = document.toJS({ mapAsMap: false });
  if (!isObject(root) || root.openapi !== '3.1.0') fail('OpenAPI must declare version 3.1.0');
  return root;
}

function collectReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') references.push(child);
      collectReferences(child, references);
    }
  }
  return references;
}

function componentFromReference(reference) {
  const match = /^#\/components\/(schemas|responses|parameters|requestBodies|headers|securitySchemes)\/([A-Za-z0-9_.-]+)$/u.exec(reference);
  if (!match) fail(`source discovery only permits local component references: ${reference}`);
  return { section: match[1], name: match[2] };
}

function sourceOperations(root) {
  if (!isObject(root.paths)) fail('OpenAPI paths must be an object');
  const discoveryPathItem = root.paths[SOURCE_DISCOVERY_PATH];
  if (!isObject(discoveryPathItem)) fail(`OpenAPI must declare ${SOURCE_DISCOVERY_PATH} discovery GET`);
  const discoveryMethods = HTTP_METHODS.filter((method) => Object.hasOwn(discoveryPathItem, method));
  if (discoveryMethods.length !== 1 || discoveryMethods[0] !== 'get') fail(`${SOURCE_DISCOVERY_PATH} must declare exactly one GET operation`);
  const discoveryOperation = discoveryPathItem.get;
  if (!isObject(discoveryOperation) || discoveryOperation.operationId !== SOURCE_DISCOVERY_OPERATION_ID) {
    fail(`${SOURCE_DISCOVERY_PATH} GET operationId must be ${SOURCE_DISCOVERY_OPERATION_ID}`);
  }
  if (discoveryOperation['x-harness-tool-name'] !== undefined) fail(`${SOURCE_DISCOVERY_OPERATION_ID} must not declare x-harness-tool-name`);
  if (!isObject(discoveryOperation.responses) || !Object.hasOwn(discoveryOperation.responses, '200')) {
    fail(`${SOURCE_DISCOVERY_OPERATION_ID} must declare a 200 response`);
  }
  const operations = [];
  for (const [path, pathItem] of Object.entries(root.paths)) {
    if (!path.startsWith(SOURCE_PREFIX)) continue;
    if (!isObject(pathItem)) fail(`${path} must be an object`);
    const methods = HTTP_METHODS.filter((method) => Object.hasOwn(pathItem, method));
    if (methods.length !== 1) fail(`${path} must declare exactly one HTTP operation`);
    const method = methods[0];
    if (method !== 'get') fail(`${path} must declare GET`);
    const operation = pathItem[method];
    if (!isObject(operation) || typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
      fail(`GET ${path} must declare an operationId`);
    }
    if (operation['x-harness-tool-name'] !== undefined) fail(`${operation.operationId} must not declare x-harness-tool-name`);
    if (!isObject(operation.responses) || !Object.hasOwn(operation.responses, '200')) {
      fail(`${operation.operationId} must declare a 200 response`);
    }
    operations.push(Object.freeze({ path, method, operationId: operation.operationId }));
  }
  if (operations.length < 1) fail('source discovery requires at least one Source operation');
  return operations;
}

function cloneDiscovery(root, operations) {
  const paths = {};
  const queue = [];
  for (const operation of operations) {
    paths[operation.path] = { [operation.method]: root.paths[operation.path][operation.method] };
    queue.push(...collectReferences(paths[operation.path]).map(componentFromReference));
  }
  const components = {};
  const seen = new Set();
  while (queue.length > 0) {
    const reference = queue.shift();
    const key = `${reference.section}/${reference.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = root.components?.[reference.section]?.[reference.name];
    if (source === undefined) fail(`discovery reference is unresolved: #/components/${reference.section}/${reference.name}`);
    components[reference.section] ??= {};
    components[reference.section][reference.name] = source;
    queue.push(...collectReferences(source).map(componentFromReference));
  }
  return {
    openapi: root.openapi,
    info: { title: 'NoobAI Host Source discovery', version: root.info?.version ?? '1.0.0', description: 'Only implemented internal Host Source operations are published here.' },
    paths,
    components
  };
}

export function buildSourceDiscovery({ repositoryRoot = undefined, openapiPath = undefined } = {}) {
  let sourcePath;
  let canonicalRoot;
  if (repositoryRoot !== undefined) {
    const source = resolveRepositoryContractFile({ repositoryRoot, relativePath: 'schema/api/openapi.yaml', label: 'source OpenAPI contract' });
    canonicalRoot = source.repositoryRoot;
    sourcePath = source.path;
    if (openapiPath !== undefined && resolve(openapiPath) !== sourcePath) fail(`OpenAPI path must resolve to the repository contract path: ${sourcePath}`);
  } else {
    sourcePath = resolve(openapiPath ?? resolve(new URL('../..', import.meta.url).pathname, 'schema/api/openapi.yaml'));
  }
  const root = parseOpenApi(sourcePath);
  return Object.freeze(cloneDiscovery(root, sourceOperations(root)));
}

export const SOURCE_DISCOVERY_PREFIX = SOURCE_PREFIX;
