import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

import { resolveJsonPointer, validationErrors } from './json-schema-validation.mjs';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
export const REPOSITORY_ROOT = resolve(moduleDirectory, '../..');
export const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const REQUIRED_AUTHORITATIVE_PATHS = Object.freeze([
  'schema/README.md',
  'schema/api/openapi.yaml',
  'schema/api/error-catalog.json',
  'schema/database/001-initial.sql',
  'schema/database/SCHEMA_NOTES.md',
  'schema/crawler',
  'schema/crawler/import-mapping.md',
  'schema/file-cleanup.schema.json'
]);

export class ContractViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractViolation';
  }
}

function fail(message) {
  throw new ContractViolation(message);
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    fail(`cannot read authoritative contract ${path}: ${error.message}`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch (error) {
    fail(`cannot parse JSON contract ${path}: ${error.message}`);
  }
}

function listFiles(directory, predicate) {
  if (!existsSync(directory)) {
    fail(`required directory is missing: ${directory}`);
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(entryPath, predicate);
    }
    return predicate(entryPath) ? [entryPath] : [];
  }).sort();
}

function resolveSchemaPointer(value, pointer, source) {
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

function collectReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') references.push(item);
      collectReferences(item, references);
    }
  }
  return references;
}

function collectVersionProperties(value, path = '', results = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectVersionProperties(item, `${path}/${index}`, results));
  } else if (value !== null && typeof value === 'object') {
    if (value.properties && typeof value.properties === 'object') {
      for (const [name, schema] of Object.entries(value.properties)) {
        if (name === 'version' || /^(?:schema|state|report|queue|contract)_version$/u.test(name)) {
          results.push({ path: `${path}/properties/${name}`, schema });
        }
      }
    }
    for (const [key, item] of Object.entries(value)) collectVersionProperties(item, `${path}/${key}`, results);
  }
  return results;
}

function schemaHasConst(schema, schemaPath, schemas, seen = new Set()) {
  if (schema !== null && typeof schema === 'object' && Object.hasOwn(schema, 'const')) return true;
  if (!schema || typeof schema !== 'object' || typeof schema.$ref !== 'string') return false;
  const resolved = resolveSchemaReference(schema.$ref, schemaPath, schemas);
  const key = `${resolved.schemaPath}#${resolved.pointer}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return schemaHasConst(resolved.schema, resolved.schemaPath, schemas, seen);
}

export function loadAuthoritativeContracts(repositoryRoot = REPOSITORY_ROOT) {
  const root = resolve(repositoryRoot);
  for (const expectedPath of REQUIRED_AUTHORITATIVE_PATHS) {
    const path = resolve(root, expectedPath);
    if (!existsSync(path)) fail(`R11 required path is missing: ${expectedPath}`);
  }

  const schemaPaths = [
    ...listFiles(resolve(root, 'schema/crawler'), (path) => path.endsWith('.schema.json')),
    resolve(root, 'schema/file-cleanup.schema.json')
  ].sort();
  const schemas = new Map(schemaPaths.map((path) => [path, readJson(path)]));

  return {
    root,
    openapiPath: resolve(root, 'schema/api/openapi.yaml'),
    openapiText: readText(resolve(root, 'schema/api/openapi.yaml')),
    errorCatalogPath: resolve(root, 'schema/api/error-catalog.json'),
    errorCatalog: readJson(resolve(root, 'schema/api/error-catalog.json')),
    migrationDirectory: resolve(root, 'schema/database'),
    migrationPath: resolve(root, 'schema/database/001-initial.sql'),
    migrationSql: readText(resolve(root, 'schema/database/001-initial.sql')),
    schemaPaths,
    schemas
  };
}

export function resolveSchemaReference(reference, currentSchemaPath, schemas) {
  const { file, pointer } = splitReference(reference);
  if (file.startsWith('http:') || file.startsWith('https:') || file.startsWith('//')) {
    fail(`external JSON Schema reference is not permitted: ${reference}`);
  }
  const schemaPath = file === '' ? currentSchemaPath : resolve(dirname(currentSchemaPath), file);
  const schemaDocument = schemas.get(schemaPath);
  if (!schemaDocument) fail(`unresolved JSON Schema file reference ${reference} from ${currentSchemaPath}`);
  return { schemaPath, pointer, schema: resolveSchemaPointer(schemaDocument, pointer, schemaPath) };
}

export function assertJsonSchemaReferences(schemas) {
  let versionPropertyCount = 0;
  for (const [schemaPath, schema] of schemas) {
    if (schema.$schema !== DRAFT_2020_12) {
      fail(`${schemaPath} must declare JSON Schema Draft 2020-12`);
    }
    if (typeof schema.$id !== 'string' || schema.$id.length === 0) {
      fail(`${schemaPath} must declare a non-empty $id`);
    }
    for (const reference of collectReferences(schema)) {
      resolveSchemaReference(reference, schemaPath, schemas);
    }
    for (const versionProperty of collectVersionProperties(schema)) {
      versionPropertyCount += 1;
      if (!schemaHasConst(versionProperty.schema, schemaPath, schemas)) {
        fail(`${schemaPath}${versionProperty.path} must constrain its contract version`);
      }
    }
  }
  if (versionPropertyCount === 0) fail('no contract version fields were found in the authoritative schemas');
  return { schemaCount: schemas.size, versionPropertyCount };
}

const OPENAPI_METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const SUPPORTED_OPENAPI_COMPONENTS = new Set(['callbacks', 'examples', 'headers', 'links', 'parameters', 'requestBodies', 'responses', 'schemas', 'securitySchemes']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseOpenApiDocument(openapiText) {
  if (typeof openapiText !== 'string' || openapiText.length === 0) fail('OpenAPI text must be a non-empty string');
  let document;
  try {
    document = parseDocument(openapiText, { strict: true });
  } catch (error) {
    fail(`OpenAPI YAML parsing failed: ${error.message}`);
  }
  if (document.errors.length > 0) fail(`OpenAPI YAML parsing failed: ${document.errors.map((error) => error.message).join('; ')}`);
  const value = document.toJS({ mapAsMap: false });
  if (!isObject(value)) fail('OpenAPI document must contain an object');
  return value;
}

function componentSections(document) {
  if (!isObject(document.components)) fail('OpenAPI components must be an object');
  for (const [name, value] of Object.entries(document.components)) {
    if (!SUPPORTED_OPENAPI_COMPONENTS.has(name)) fail(`OpenAPI components.${name} is unsupported`);
    if (!isObject(value)) fail(`OpenAPI components.${name} must be an object`);
  }
  for (const name of ['parameters', 'responses', 'schemas']) {
    if (!isObject(document.components[name])) fail(`OpenAPI components.${name} is missing`);
  }
  return document.components;
}

function localComponentReference(reference, components, source) {
  if (typeof reference !== 'string' || reference.length === 0) fail(`${source} $ref must be a non-empty string`);
  if (!reference.startsWith('#/components/')) return null;
  const segments = reference.slice('#/components/'.length).split('/');
  if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) fail(`${source} has an invalid component reference: ${reference}`);
  const [collection, name] = segments.map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  if (!SUPPORTED_OPENAPI_COMPONENTS.has(collection) || !isObject(components[collection]) || !Object.hasOwn(components[collection], name)) {
    fail(`OpenAPI has an unresolved #/components/${collection}/${name} reference`);
  }
  return { collection, name, value: components[collection][name] };
}

function assertLocalComponentReferences(value, components, source = 'OpenAPI') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLocalComponentReferences(item, components, `${source}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  if (Object.hasOwn(value, '$ref')) {
    if (typeof value.$ref !== 'string') fail(`${source}.$ref must be a string`);
    localComponentReference(value.$ref, components, source);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== '$ref') assertLocalComponentReferences(child, components, `${source}.${key}`);
  }
}

function componentValue(value, components, expectedCollection, source) {
  if (isObject(value) && Object.hasOwn(value, '$ref')) {
    const reference = localComponentReference(value.$ref, components, source);
    if (reference === null || reference.collection !== expectedCollection) fail(`${source} must reference components.${expectedCollection}`);
    return reference.value;
  }
  if (!isObject(value)) fail(`${source} must be an object`);
  return value;
}

function parameterName(value, components, source) {
  const parameter = componentValue(value, components, 'parameters', source);
  if (typeof parameter.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(parameter.name)
    || typeof parameter.in !== 'string' || parameter.in.length === 0) fail(`${source} must declare a parameter name and location`);
  if (parameter.in === 'path' && parameter.required !== true) fail(`${source} path parameter must be required`);
  return parameter.in === 'path' ? parameter.name : null;
}

function responseSchema(value, components, source) {
  const response = componentValue(value, components, 'responses', source);
  const schema = response.content?.['application/json']?.schema;
  if (schema === undefined) return null;
  return schema;
}

function errorCodes(schema, components, source, seen = new Set(), state = 'none', rootObject = true) {
  if (schema === null || schema === undefined || typeof schema === 'boolean') return new Set();
  if (Array.isArray(schema)) return new Set(schema.flatMap((child) => [...errorCodes(child, components, source, seen, state, rootObject)]));
  if (!isObject(schema)) return new Set();
  const values = new Set();
  if (typeof schema.$ref === 'string') {
    const reference = localComponentReference(schema.$ref, components, source);
    if (reference !== null && reference.collection === 'schemas') {
      const key = `${reference.collection}/${reference.name}`;
      if (!seen.has(key)) {
        const nextSeen = new Set(seen).add(key);
        for (const value of errorCodes(reference.value, components, source, nextSeen, state, rootObject)) values.add(value);
      }
    }
  }
  if (state === 'code') {
    if (typeof schema.const === 'string') values.add(schema.const);
    if (Array.isArray(schema.enum)) for (const value of schema.enum) if (typeof value === 'string') values.add(value);
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key === '$ref') continue;
    if (key === 'properties' && isObject(child)) {
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        const childState = state === 'error' && propertyName === 'code'
          ? 'code'
          : rootObject && propertyName === 'error'
            ? 'error'
            : 'none';
        for (const value of errorCodes(
          propertySchema,
          components,
          `${source}.properties.${propertyName}`,
          seen,
          childState,
          false
        )) values.add(value);
      }
    } else if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
      for (const value of errorCodes(child, components, `${source}.${key}`, seen, state, rootObject)) values.add(value);
    }
  }
  return values;
}

function statusNumber(status, source) {
  const text = String(status);
  if (!/^\d{3}$/u.test(text)) fail(`${source} response status must be a three-digit status`);
  return Number(text);
}

function parseOperation(path, method, operation, components) {
  if (!isObject(operation)) fail(`OpenAPI ${method.toUpperCase()} ${path} operation must be an object`);
  if (typeof operation.operationId !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(operation.operationId)) fail(`OpenAPI ${method.toUpperCase()} ${path} is missing operationId`);
  if (!isObject(operation.responses) || Object.keys(operation.responses).length === 0) fail(`OpenAPI ${operation.operationId} has no response`);
  const responses = Object.entries(operation.responses)
    .map(([statusText, response], index) => ({ status: statusNumber(statusText, `${operation.operationId} response ${index}`), response }))
    .sort((left, right) => left.status - right.status)
    .map(({ status, response }) => {
      let responseName = null;
      if (isObject(response) && typeof response.$ref === 'string') {
        const reference = localComponentReference(response.$ref, components, `${operation.operationId} response ${status}`);
        if (reference === null || reference.collection !== 'responses') fail(`OpenAPI ${operation.operationId} response ${status} must reference a response component`);
        responseName = reference.name;
      }
      return { status, responseName, schema: responseSchema(response, components, `${operation.operationId} response ${status}`) };
    });
  return { path, method, operationId: operation.operationId, responses };
}

export function parseOpenApiStructure(openapiText) {
  const document = parseOpenApiDocument(openapiText);
  if (document.openapi !== '3.1.0') fail('OpenAPI must declare version 3.1.0');
  const components = componentSections(document);
  assertLocalComponentReferences(document, components);
  if (!isObject(document.paths) || Object.keys(document.paths).length === 0) fail('OpenAPI must declare at least one path');
  const operations = [];
  const pathNames = Object.keys(document.paths).sort();
  for (const path of pathNames) {
    if (!path.startsWith('/api/') && path !== '/internal/semantic' && !path.startsWith('/internal/semantic/') && path !== '/internal/comfyui-source' && !path.startsWith('/internal/comfyui-source/')) {
      fail(`OpenAPI path has an unsupported listener boundary: ${path}`);
    }
    const pathItem = document.paths[path];
    if (!isObject(pathItem)) fail(`OpenAPI path item must be an object: ${path}`);
    const pathParameters = Array.isArray(pathItem.parameters)
      ? pathItem.parameters.map((parameter, index) => parameterName(parameter, components, `${path} parameters[${index}]`)).filter(Boolean)
      : [];
    const methods = OPENAPI_METHODS.filter((method) => Object.hasOwn(pathItem, method));
    if (methods.length === 0) fail(`OpenAPI path has no operation: ${path}`);
    const pathVariables = [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map((match) => match[1]);
    for (const method of methods) {
      const operation = parseOperation(path, method, pathItem[method], components);
      const operationParameters = Array.isArray(pathItem[method].parameters)
        ? pathItem[method].parameters.map((parameter, index) => parameterName(parameter, components, `${operation.operationId} parameters[${index}]`)).filter(Boolean)
        : [];
      for (const variable of pathVariables) {
        if (!pathParameters.includes(variable) && !operationParameters.includes(variable)) fail(`OpenAPI path ${path} is missing a declared parameter for {${variable}}`);
      }
      operations.push(operation);
    }
  }
  const ids = new Set();
  for (const operation of operations) {
    if (ids.has(operation.operationId)) fail(`OpenAPI operationId is duplicated: ${operation.operationId}`);
    ids.add(operation.operationId);
  }
  const matrix = [];
  for (const operation of operations) {
    const usesStatusMessageErrors = operation.path.startsWith('/internal/semantic/')
      || operation.path.startsWith('/internal/comfyui-source/');
    for (const response of operation.responses.filter(({ status }) => status >= 400)) {
      if (response.schema === null) fail(`OpenAPI ${operation.operationId} error response ${response.responseName ?? response.status} has no error schema`);
      const codes = errorCodes(response.schema, components, `${operation.operationId} response ${response.status}`);
      if (codes.size === 0 && !usesStatusMessageErrors) fail(`OpenAPI ${operation.operationId} error response ${response.responseName ?? response.status} has no error schema`);
      for (const code of [...codes].sort()) matrix.push({ path: operation.path, method: operation.method, operationId: operation.operationId, status: response.status, code });
    }
  }
  const cleanOperations = operations.map(({ path, method, operationId, responses }) => ({ path, method, operationId, responses: responses.map(({ status, responseName }) => ({ status, responseName })) }));
  return { operations: cleanOperations, matrix, pathCount: pathNames.length };
}

export function assertErrorMatrix(openapi, errorCatalog) {
  if (!Number.isSafeInteger(errorCatalog.version) || errorCatalog.version < 1 || !errorCatalog.errors || typeof errorCatalog.errors !== 'object') {
    fail('error catalog must provide a positive integer version and errors object');
  }
  const operations = new Set(openapi.operations.map((operation) => operation.operationId));
  const statusMessageOperations = new Set(openapi.operations
    .filter(({ path }) => path.startsWith('/internal/semantic/') || path.startsWith('/internal/comfyui-source/'))
    .map(({ operationId }) => operationId));
  const expected = new Set();
  for (const [code, definition] of Object.entries(errorCatalog.errors)) {
    if (!Number.isInteger(definition.http_status) || definition.http_status < 400 || definition.http_status > 599) {
      fail(`error catalog ${code} has invalid http_status`);
    }
    if (!Array.isArray(definition.operationIds) || definition.operationIds.length === 0) {
      fail(`error catalog ${code} must list operationIds`);
    }
    for (const operationId of definition.operationIds) {
      if (!operations.has(operationId)) fail(`error catalog ${code} references unknown operationId ${operationId}`);
      if (statusMessageOperations.has(operationId)) continue;
      const key = `${operationId}|${definition.http_status}|${code}`;
      if (expected.has(key)) fail(`error catalog duplicates matrix tuple ${key}`);
      expected.add(key);
    }
  }
  const actual = new Set();
  for (const entry of openapi.matrix) {
    const definition = errorCatalog.errors[entry.code];
    if (!definition) fail(`OpenAPI ${entry.operationId} emits error code absent from catalog: ${entry.code}`);
    if (definition.http_status !== entry.status) {
      fail(`OpenAPI ${entry.operationId} emits ${entry.code} as ${entry.status}, catalog requires ${definition.http_status}`);
    }
    if (!definition.operationIds.includes(entry.operationId)) {
      fail(`OpenAPI ${entry.operationId} emits ${entry.code}, but catalog omits the operation`);
    }
    const key = `${entry.operationId}|${entry.status}|${entry.code}`;
    if (actual.has(key)) fail(`OpenAPI duplicates matrix tuple ${key}`);
    actual.add(key);
  }
  for (const key of expected) {
    if (!actual.has(key)) fail(`error catalog matrix tuple has no OpenAPI response: ${key}`);
  }
  return { operationCount: operations.size, matrixCount: actual.size, errorCount: Object.keys(errorCatalog.errors).length };
}

export function validateJsonSample(value, schemaPath, schemas) {
  const absoluteSchemaPath = resolve(schemaPath);
  const schema = schemas.get(absoluteSchemaPath);
  if (!schema) fail(`sample validation schema is not loaded: ${absoluteSchemaPath}`);
  return validationErrors(value, schema, {
    context: absoluteSchemaPath,
    resolveReference: (reference, currentSchemaPath) => {
      const resolved = resolveSchemaReference(reference, currentSchemaPath, schemas);
      return { schema: resolved.schema, context: resolved.schemaPath };
    }
  });
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertCrawlerCrossObjectConsistency(detailOrReport) {
  if (Array.isArray(detailOrReport.image_results)) {
    const imageResults = detailOrReport.image_results;
    const sortOrders = new Set();
    const sourceUrls = new Set();
    for (const [index, image] of imageResults.entries()) {
      if (!deepEqual(image.owner_identity, detailOrReport.identity)) {
        fail(`image_results[${index}].owner_identity must equal the detail identity`);
      }
      if (sortOrders.has(image.sort_order)) fail(`image_results[${index}].sort_order must be unique`);
      sortOrders.add(image.sort_order);
      if (image.source_url !== null && image.source_url !== undefined) {
        if (sourceUrls.has(image.source_url)) fail(`image_results[${index}].source_url must be unique when non-empty`);
        sourceUrls.add(image.source_url);
      }
    }
  }
  if (Array.isArray(detailOrReport.deduplications)) {
    for (const [index, entry] of detailOrReport.deduplications.entries()) {
      if (entry.incoming_identity && entry.canonical_identity) {
        if (entry.kind !== entry.incoming_identity.kind || entry.kind !== entry.canonical_identity.kind) {
          fail(`deduplications[${index}] kind must equal both identity kinds`);
        }
      }
    }
  }
  if (detailOrReport.started_at && detailOrReport.finished_at && Date.parse(detailOrReport.finished_at) < Date.parse(detailOrReport.started_at)) {
    fail('crawl report finished_at must not be earlier than started_at');
  }
  return detailOrReport;
}
