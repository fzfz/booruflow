import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';

import { REPOSITORY_ROOT } from '../contracts/authoritative-contracts.mjs';
import { resolveJsonPointer } from '../contracts/json-schema-validation.mjs';
import { resolveRepositoryContractFile } from '../contracts/repository-contract-paths.mjs';
import {
  CHARACTER_CATALOG_OPERATION_ID,
  assertCatalogMediaOrigin
} from '../contracts/catalog-contract.mjs';
import { assertSemanticHandlerRoutesMatchRuntime, SEMANTIC_HANDLER_ROUTE_MANIFEST } from './semantic-handler-routes.mjs';

const HTTP_METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const DISCOVERY_PREFIX = '/internal/semantic/';
const DISCOVERY_OPERATION_ID = 'getSemanticDiscovery';

export class SemanticDiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SemanticDiscoveryError';
  }
}

function fail(message) {
  throw new SemanticDiscoveryError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveDiscoveryPointer(value, pointer, source) {
  try {
    return resolveJsonPointer(value, pointer);
  } catch {
    if (pointer !== '' && pointer !== '/' && !pointer.startsWith('/')) fail(`unsupported JSON pointer #${pointer} in ${source}`);
    fail(`unresolved JSON pointer #${pointer} in ${source}`);
  }
}

function splitReference(reference) {
  const hashIndex = reference.indexOf('#');
  return hashIndex === -1
    ? { file: reference, pointer: '' }
    : { file: reference.slice(0, hashIndex), pointer: reference.slice(hashIndex + 1) };
}

function parseYamlFile(path) {
  if (!existsSync(path)) fail(`OpenAPI or referenced document is missing: ${path}`);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { fail(`cannot read OpenAPI document ${path}: ${error.message}`); }
  let document;
  try { document = parseDocument(text, { strict: true }); } catch (error) { fail(`OpenAPI YAML parsing failed: ${error.message}`); }
  if (document.errors.length > 0) fail(`OpenAPI YAML parsing failed: ${document.errors.map((error) => error.message).join('; ')}`);
  const value = document.toJS({ mapAsMap: false });
  if (!isObject(value)) fail(`OpenAPI document ${path} must contain an object`);
  return value;
}

function resolveReference(reference, sourcePath, sourceDocument, cache, repositoryRoot = undefined) {
  if (typeof reference !== 'string' || reference.length === 0) fail(`OpenAPI reference must be a non-empty string in ${sourcePath}`);
  const { file, pointer } = splitReference(reference);
  if (file === '') return { value: resolveDiscoveryPointer(sourceDocument, pointer, sourcePath), sourcePath, sourceDocument };
  if (/^(?:https?:|file:|\/\/)/iu.test(file)) fail(`external OpenAPI reference is not permitted: ${reference}`);
  const requestedPath = resolve(dirname(sourcePath), file);
  const referencedPath = repositoryRoot === undefined
    ? requestedPath
    : resolveRepositoryContractFile({
      repositoryRoot,
      relativePath: relative(repositoryRoot, requestedPath),
      label: `OpenAPI referenced document ${reference}`
    }).path;
  const key = referencedPath;
  const referencedDocument = cache.get(key) ?? parseYamlFile(referencedPath);
  cache.set(key, referencedDocument);
  return { value: resolveDiscoveryPointer(referencedDocument, pointer, referencedPath), sourcePath: referencedPath, sourceDocument: referencedDocument };
}

function collectReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
  } else if (isObject(value)) {
    if (typeof value.$ref === 'string') references.push(value.$ref);
    for (const item of Object.values(value)) collectReferences(item, references);
  }
  return references;
}

function validateAllReferences(value, sourcePath, sourceDocument, cache, repositoryRoot = undefined, visited = new Set()) {
  for (const reference of collectReferences(value)) {
    const resolved = resolveReference(reference, sourcePath, sourceDocument, cache, repositoryRoot);
    const visitKey = `${resolved.sourcePath}#${reference}`;
    if (!visited.has(visitKey)) {
      visited.add(visitKey);
      validateAllReferences(resolved.value, resolved.sourcePath, resolved.sourceDocument, cache, repositoryRoot, visited);
    }
  }
}

function nonEmptyText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must have a concrete description`);
  return value;
}

function schemaExample(schema) {
  return Object.hasOwn(schema, 'example') || (Array.isArray(schema.examples) && schema.examples.length > 0);
}

function resolvedSchema(schema, sourcePath, sourceDocument, cache, repositoryRoot = undefined) {
  if (isObject(schema) && typeof schema.$ref === 'string') return resolveReference(schema.$ref, sourcePath, sourceDocument, cache, repositoryRoot).value;
  return schema;
}

function mergeSchemaObjects(base, overlay) {
  const merged = { ...base, ...overlay };
  if (isObject(base?.properties) || isObject(overlay?.properties)) {
    const properties = { ...(base?.properties ?? {}) };
    for (const [name, property] of Object.entries(overlay?.properties ?? {})) {
      properties[name] = isObject(properties[name]) && isObject(property)
        ? mergeSchemaObjects(properties[name], property)
        : property;
    }
    merged.properties = properties;
  }
  if (Array.isArray(base?.required) || Array.isArray(overlay?.required)) {
    merged.required = [...new Set([...(base?.required ?? []), ...(overlay?.required ?? [])])];
  }
  return merged;
}

function mergeAllOfSchema(schema, sourcePath, sourceDocument, cache, repositoryRoot = undefined) {
  const resolved = resolvedSchema(schema, sourcePath, sourceDocument, cache, repositoryRoot);
  if (!isObject(resolved) || !Array.isArray(resolved.allOf)) return resolved;
  let merged = { ...resolved };
  delete merged.allOf;
  for (const child of resolved.allOf) {
    merged = mergeSchemaObjects(merged, mergeAllOfSchema(child, sourcePath, sourceDocument, cache, repositoryRoot));
  }
  return merged;
}

function assertDocumentedSchema(schema, label, sourcePath, sourceDocument, cache, repositoryRoot = undefined, seen = new Set()) {
  const resolved = mergeAllOfSchema(schema, sourcePath, sourceDocument, cache, repositoryRoot);
  if (!isObject(resolved)) return;
  if (seen.has(resolved)) return;
  seen.add(resolved);
  for (const child of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(resolved[child])) resolved[child].forEach((item, index) => assertDocumentedSchema(item, `${label}.${child}[${index}]`, sourcePath, sourceDocument, cache, repositoryRoot, seen));
  }
  if (isObject(resolved.items)) assertDocumentedSchema(resolved.items, `${label}.items`, sourcePath, sourceDocument, cache, repositoryRoot, seen);
  if (isObject(resolved.properties)) {
    for (const [name, property] of Object.entries(resolved.properties)) {
      if (!isObject(property)) fail(`${label}.${name} must be a schema object`);
      const documentedProperty = mergeAllOfSchema(property, sourcePath, sourceDocument, cache, repositoryRoot);
      nonEmptyText(documentedProperty.description, `${label}.${name}`);
      if (!schemaExample(documentedProperty)) fail(`${label}.${name} must declare an example`);
      assertDocumentedSchema(property, `${label}.${name}`, sourcePath, sourceDocument, cache, repositoryRoot, seen);
    }
  }
}

function assertDocumentedResponse(response, label, sourcePath, sourceDocument, cache, repositoryRoot = undefined) {
  const resolved = resolvedSchema(response, sourcePath, sourceDocument, cache, repositoryRoot);
  if (!isObject(resolved)) fail(`${label} response must be an object`);
  nonEmptyText(resolved.description, `${label}.description`);
  const content = resolved.content?.['application/json'];
  if (!isObject(content) || !isObject(content.schema) || !isObject(content.examples) || Object.keys(content.examples).length === 0) {
    fail(`${label} response must declare JSON schema and example`);
  }
  assertDocumentedSchema(content.schema, `${label}.schema`, sourcePath, sourceDocument, cache, repositoryRoot);
}

function validateDiscoveryOperation(root, repositoryRoot = undefined) {
  const pathItem = root.paths?.[SEMANTIC_DISCOVERY_PATH];
  if (!isObject(pathItem)) fail(`OpenAPI must declare ${SEMANTIC_DISCOVERY_PATH} discovery GET`);
  const methods = HTTP_METHODS.filter((method) => Object.hasOwn(pathItem, method));
  if (methods.length !== 1 || methods[0] !== 'get') fail(`${SEMANTIC_DISCOVERY_PATH} must declare exactly one GET operation`);
  const operation = pathItem.get;
  if (!isObject(operation)) fail(`${SEMANTIC_DISCOVERY_PATH} GET operation must be an object`);
  const operationId = nonEmptyText(operation.operationId, `${SEMANTIC_DISCOVERY_PATH}.get.operationId`);
  if (operationId !== DISCOVERY_OPERATION_ID) fail(`${SEMANTIC_DISCOVERY_PATH} GET operationId must be ${DISCOVERY_OPERATION_ID}`);
  nonEmptyText(operation.summary, `${DISCOVERY_OPERATION_ID}.summary`);
  nonEmptyText(operation.description, `${DISCOVERY_OPERATION_ID}.description`);
  if (!isObject(operation.responses) || !Object.hasOwn(operation.responses, '200')) fail(`${DISCOVERY_OPERATION_ID} must declare a 200 response`);
  for (const [status, response] of Object.entries(operation.responses)) {
    assertDocumentedResponse(response, `${DISCOVERY_OPERATION_ID}.responses.${status}`, root.__sourcePath, root, root.__cache, repositoryRoot);
  }
}

function validateCatalogBranch(schema, label, mode, requiredFields, allowedSearchFields = []) {
  if (!isObject(schema) || schema.type !== 'object' || schema.additionalProperties !== false) fail(`${label} must be a closed object`);
  if (!Array.isArray(schema.required) || JSON.stringify(schema.required) !== JSON.stringify(requiredFields)) fail(`${label} required fields are invalid`);
  if (schema.properties?.mode?.const !== mode) fail(`${label}.mode must be const ${mode}`);
  const expectedProperties = Object.keys(schema.properties ?? {});
  if (mode === 'search' && JSON.stringify(expectedProperties) !== JSON.stringify(['mode', 'query', 'page', 'page_size', ...allowedSearchFields])) fail(`${label} declares unexpected search fields`);
  if (mode === 'resolve' && JSON.stringify(expectedProperties) !== JSON.stringify(['mode', 'id'])) fail(`${label} declares unexpected resolve fields`);
}

function semanticOperations(root, repositoryRoot = undefined) {
  if (!isObject(root.paths)) fail('OpenAPI paths must be an object');
  const operations = [];
  const operationIds = new Set();
  const toolNames = new Set();
  for (const [path, pathItem] of Object.entries(root.paths)) {
    if (!path.startsWith(DISCOVERY_PREFIX)) continue;
    if (!isObject(pathItem)) fail(`semantic OpenAPI path ${path} must be an object`);
    const methods = HTTP_METHODS.filter((method) => Object.hasOwn(pathItem, method));
    if (methods.length !== 1) fail(`semantic OpenAPI path ${path} must declare exactly one HTTP operation`);
    const method = methods[0];
    if (method !== 'post') fail(`semantic OpenAPI path ${path} must declare POST`);
    const operation = pathItem[method];
    if (!isObject(operation)) fail(`semantic OpenAPI operation ${method.toUpperCase()} ${path} must be an object`);
    const operationId = nonEmptyText(operation.operationId, `${method.toUpperCase()} ${path}.operationId`);
    if (operationIds.has(operationId)) fail(`semantic operationId is duplicated: ${operationId}`);
    operationIds.add(operationId);
    nonEmptyText(operation.summary, `${operationId}.summary`);
    nonEmptyText(operation.description, `${operationId}.description`);
    const toolName = nonEmptyText(operation['x-harness-tool-name'], `${operationId}.x-harness-tool-name`);
    if (toolNames.has(toolName)) fail(`semantic x-harness-tool-name is duplicated: ${toolName}`);
    toolNames.add(toolName);
    const requestBody = operation.requestBody;
    if (!isObject(requestBody) || requestBody.required !== true || !isObject(requestBody.content) || !isObject(requestBody.content['application/json'])) {
      fail(`${operationId} must declare a required application/json request body`);
    }
    const requestSchema = requestBody.content['application/json'].schema;
    const resolvedRequestSchema = resolvedSchema(requestSchema, root.__sourcePath, root, root.__cache, repositoryRoot);
    if (!isObject(resolvedRequestSchema) || resolvedRequestSchema.type !== 'object') fail(`${operationId} request schema must be an object`);
    assertDocumentedSchema(resolvedRequestSchema, `${operationId}.request`, root.__sourcePath, root, root.__cache, repositoryRoot);
    if (!Array.isArray(resolvedRequestSchema.oneOf) || resolvedRequestSchema.oneOf.length !== 2) fail(`${operationId} request schema must use search and resolve oneOf branches`);
    const searchSchema = resolvedSchema(resolvedRequestSchema.oneOf[0], root.__sourcePath, root, root.__cache, repositoryRoot);
    const resolveSchema = resolvedSchema(resolvedRequestSchema.oneOf[1], root.__sourcePath, root, root.__cache, repositoryRoot);
    const allowedSearchFields = Object.keys(searchSchema.properties ?? {}).slice(4);
    const allowedFilterField = operationId === CHARACTER_CATALOG_OPERATION_ID ? 'work_id' : 'base_model_id';
    if (allowedSearchFields.some((field) => field !== allowedFilterField)) fail(`${operationId}.search declares an unsupported filter field`);
    validateCatalogBranch(searchSchema, `${operationId}.search`, 'search', ['mode'], allowedSearchFields);
    if (allowedSearchFields.includes(allowedFilterField)) {
      const filterId = searchSchema.properties[allowedFilterField];
      if (filterId?.type !== 'string' || filterId.minLength !== 1 || filterId.maxLength !== 20 || filterId.pattern !== '^[1-9][0-9]{0,19}$') {
        fail(`${operationId}.search.${allowedFilterField} is invalid`);
      }
    }
    validateCatalogBranch(resolveSchema, `${operationId}.resolve`, 'resolve', ['mode', 'id']);
    if (searchSchema.properties.query?.type !== 'string' || searchSchema.properties.query.minLength !== 0 || searchSchema.properties.query.default !== '' || searchSchema.properties.query.maxLength !== 200) fail(`${operationId}.search.query is invalid`);
    if (searchSchema.properties.page?.type !== 'integer' || searchSchema.properties.page.default !== 1 || searchSchema.properties.page.minimum !== 1 || searchSchema.properties.page.maximum !== 100000) fail(`${operationId}.search.page is invalid`);
    if (searchSchema.properties.page_size?.type !== 'integer' || searchSchema.properties.page_size.default !== 20 || searchSchema.properties.page_size.minimum !== 1 || searchSchema.properties.page_size.maximum !== 100) fail(`${operationId}.search.page_size is invalid`);
    if (resolveSchema.properties.id?.type !== 'string' || resolveSchema.properties.id.minLength !== 1 || resolveSchema.properties.id.maxLength !== 20 || resolveSchema.properties.id.pattern !== '^[1-9][0-9]{0,19}$') fail(`${operationId}.resolve.id is invalid`);
    if (!isObject(operation.responses) || !Object.hasOwn(operation.responses, '200')) fail(`${operationId} must declare a 200 response`);
    for (const [status, response] of Object.entries(operation.responses)) {
      assertDocumentedResponse(response, `${operationId}.responses.${status}`, root.__sourcePath, root, root.__cache, repositoryRoot);
    }
    operations.push(Object.freeze({ path, method, operationId }));
  }
  if (operations.length === 0) fail(`discovery requires at least one internal semantic operation, found ${operations.length}`);
  return Object.freeze(operations);
}

function componentReference(reference) {
  const match = /^#\/components\/(schemas|responses|parameters|requestBodies|headers|securitySchemes)\/([A-Za-z0-9_.-]+)$/u.exec(reference);
  return match ? { section: match[1], name: match[2] } : null;
}

function requiredComponentReference(reference) {
  const component = componentReference(reference);
  if (!component) fail(`discovery only permits local component references: ${reference}`);
  return component;
}

function assertMediaOrigin(mediaOrigin) {
  try {
    return assertCatalogMediaOrigin(mediaOrigin);
  } catch {
    fail('x-imagegen-media-origin must be an HTTP loopback origin with a port from 1 to 65535');
  }
}

function cloneDiscovery(root, operations, mediaOrigin = undefined) {
  const paths = {};
  const refs = [];
  for (const operation of operations) {
    const pathItem = root.paths[operation.path];
    paths[operation.path] = { [operation.method]: pathItem[operation.method] };
    for (const reference of collectReferences(paths[operation.path])) {
      requiredComponentReference(reference);
      refs.push(reference);
    }
  }
  const components = {};
  const queue = refs.map(requiredComponentReference);
  const seen = new Set();
  while (queue.length > 0) {
    const reference = queue.shift();
    const key = `${reference.section}/${reference.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = root.components?.[reference.section]?.[reference.name];
    if (!source) fail(`discovery reference is unresolved: #/components/${reference.section}/${reference.name}`);
    components[reference.section] ??= {};
    components[reference.section][reference.name] = source;
    for (const child of collectReferences(source)) {
      queue.push(requiredComponentReference(child));
    }
  }
  return {
    openapi: root.openapi,
    info: { title: 'NoobAI Catalog discovery', version: root.info?.version ?? '1.0.0', description: 'Only implemented internal Catalog operations are published here.' },
    ...(mediaOrigin === undefined ? {} : { 'x-imagegen-media-origin': assertMediaOrigin(mediaOrigin) }),
    paths,
    components
  };
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function buildSemanticDiscovery({ repositoryRoot = undefined, openapiPath = undefined, mediaOrigin = undefined } = {}) {
  let sourcePath;
  let canonicalRoot;
  if (repositoryRoot !== undefined) {
    const repositorySource = resolveRepositoryContractFile({ repositoryRoot, relativePath: 'schema/api/openapi.yaml', label: 'semantic OpenAPI contract' });
    canonicalRoot = repositorySource.repositoryRoot;
    const requestedPath = openapiPath === undefined ? repositorySource.path : resolve(openapiPath);
    if (requestedPath !== repositorySource.path) fail(`semantic OpenAPI path must resolve to the repository contract path: ${repositorySource.path}`);
    sourcePath = repositorySource.path;
  } else {
    sourcePath = resolve(openapiPath ?? resolve(REPOSITORY_ROOT, 'schema/api/openapi.yaml'));
  }
  const root = parseYamlFile(sourcePath);
  if (root.openapi !== '3.1.0') fail('OpenAPI must declare version 3.1.0');
  if (!isObject(root.info)) fail('OpenAPI info must be an object');
  const cache = new Map([[sourcePath, root]]);
  Object.defineProperty(root, '__sourcePath', { value: sourcePath, enumerable: false });
  Object.defineProperty(root, '__cache', { value: cache, enumerable: false });
  validateAllReferences(root, sourcePath, root, cache, canonicalRoot);
  const operations = semanticOperations(root, canonicalRoot);
  validateDiscoveryOperation(root, canonicalRoot);
  const discovery = cloneDiscovery(root, operations, mediaOrigin);
  validateAllReferences(discovery, sourcePath, discovery, new Map([[sourcePath, discovery]]), canonicalRoot);
  return deepFreeze(discovery);
}

export function assertSemanticDiscoveryMatchesRuntime(discovery, runtimeRouteInventory) {
  if (!discovery || !isObject(discovery.paths)) throw new TypeError('discovery document is required');
  if (!Array.isArray(runtimeRouteInventory)) throw new TypeError('runtime route inventory is required');
  const declared = Object.entries(discovery.paths).flatMap(([path, pathItem]) => Object.entries(pathItem).map(([method, operation]) => `${method.toUpperCase()} ${path} ${operation.operationId}`));
  const implemented = runtimeRouteInventory.filter((route) => route.listener === 'internal' && route.path.startsWith(DISCOVERY_PREFIX)).map((route) => `${route.method.toUpperCase()} ${route.path} ${route.operationId}`);
  if (declared.length !== implemented.length || declared.some((identity, index) => identity !== implemented[index])) fail('semantic discovery operations differ from the implemented runtime routes');
  assertSemanticHandlerRoutesMatchRuntime({ manifest: SEMANTIC_HANDLER_ROUTE_MANIFEST, runtimeRouteInventory });
  return discovery;
}

export const SEMANTIC_DISCOVERY_PATH = '/internal/semantic';
