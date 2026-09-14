#!/usr/bin/env node

import { request as requestHttp } from 'node:http';
import { realpathSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const CLI_NAME = 'imagegen-semantic-query';
const CLI_VERSION = '2.0.0';
const DEFAULT_TIMEOUT_MS = 120000;
const DISCOVERY_PATH = '/internal/semantic';
const HTTP_METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const GLOBAL_OPTION_NAMES = new Set(['port', 'path', 'timeout-ms', 'help', 'version', 'discovery-json']);
const BUSINESS_OPTION_NAMES = new Set(['mode', 'query', 'page', 'page_size', 'base_model_id', 'work_id', 'id']);
const KNOWN_OPTION_NAMES = new Set([...GLOBAL_OPTION_NAMES, ...BUSINESS_OPTION_NAMES]);
const CATALOG_OPERATION_PATH_PATTERN = /^\/internal\/semantic\/[^/?#]+$/u;
const CLI_ERROR_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'CLI arguments are invalid.',
  DISCOVERY_HTTP_ERROR: 'Source discovery returned an error.',
  SOURCE_CONNECTION_FAILED: 'Source service is unavailable.',
  TOTAL_TIMEOUT: 'Source request timed out.',
  CONTRACT_PROTOCOL_ERROR: 'Source contract response is invalid.',
  INTERNAL_CLI_ERROR: 'Source CLI failed.'
});
const CATALOG_OPERATION_REGISTRY = Object.freeze({
  '/internal/semantic/base-models': Object.freeze({
    operationId: 'querySemanticBaseModelsForSkill',
    toolName: 'query_semantic_base_models',
    searchFields: Object.freeze([])
  }),
  '/internal/semantic/generation-models': Object.freeze({
    operationId: 'querySemanticGenerationModelsForSkill',
    toolName: 'query_semantic_generation_models',
    searchFields: Object.freeze(['base_model_id'])
  }),
  '/internal/semantic/loras': Object.freeze({
    operationId: 'querySemanticLorasForSkill',
    toolName: 'query_semantic_loras',
    searchFields: Object.freeze(['base_model_id'])
  }),
  '/internal/semantic/works': Object.freeze({
    operationId: 'querySemanticWorksForSkill',
    toolName: 'query_semantic_works',
    searchFields: Object.freeze([])
  }),
  '/internal/semantic/characters': Object.freeze({
    operationId: 'querySemanticCharactersForSkill',
    toolName: 'query_semantic_characters',
    searchFields: Object.freeze(['work_id'])
  }),
  '/internal/semantic/styles': Object.freeze({
    operationId: 'querySemanticStylesForSkill',
    toolName: 'query_semantic_styles',
    searchFields: Object.freeze(['base_model_id'])
  }),
  '/internal/semantic/prompt-terms': Object.freeze({
    operationId: 'querySemanticPromptTermsForSkill',
    toolName: 'query_semantic_prompt_terms',
    searchFields: Object.freeze([])
  }),
  '/internal/semantic/artist-prompt-strings': Object.freeze({
    operationId: 'querySemanticArtistPromptStringsForSkill',
    toolName: 'query_semantic_artist_prompt_strings',
    searchFields: Object.freeze(['base_model_id'])
  }),
  '/internal/semantic/comfyui-instances': Object.freeze({
    operationId: 'querySemanticComfyuiInstancesForSkill',
    toolName: 'query_semantic_comfyui_instances',
    searchFields: Object.freeze([])
  }),
  '/internal/semantic/comfyui-templates': Object.freeze({
    operationId: 'querySemanticComfyuiTemplatesForSkill',
    toolName: 'query_semantic_comfyui_templates',
    searchFields: Object.freeze(['base_model_id'])
  })
});
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'description', 'example', 'default', 'enum', 'minimum', 'maximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'items', 'properties',
  'required', 'additionalProperties', 'const', 'pattern', 'format', 'uniqueItems', 'oneOf'
]);
const UNSAFE_TEXT_PATTERN_SOURCE = '[\\u0000-\\u001f\\u061c\\u007f-\\u009f\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]';
const UNSAFE_TEXT_PATTERN = new RegExp(UNSAFE_TEXT_PATTERN_SOURCE, 'u');
const UNSAFE_TEXT_GLOBAL_PATTERN = new RegExp(UNSAFE_TEXT_PATTERN_SOURCE, 'gu');
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

class ServiceHttpError extends Error {
  constructor(responseBody, exitCode) {
    super('service returned an HTTP error');
    this.name = 'ServiceHttpError';
    this.responseBody = responseBody;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 2) {
  throw new CliError(code, message, exitCode);
}

function createExecutionContext(timeoutMs) {
  const controller = new AbortController();
  const timeoutError = new CliError('TOTAL_TIMEOUT', CLI_ERROR_MESSAGES.TOTAL_TIMEOUT, 5);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const signalHandlers = new Map([
    ['SIGINT', () => controller.abort(new CliError('PROCESS_CANCELLED', 'Source request was cancelled by SIGINT.', 130))],
    ['SIGTERM', () => controller.abort(new CliError('PROCESS_CANCELLED', 'Source request was cancelled by SIGTERM.', 143))]
  ]);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  return {
    signal: controller.signal,
    throwIfAborted() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    dispose() {
      clearTimeout(timer);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    }
  };
}

function parseDecimalInteger(value, label, minimum, maximum) {
  if (!/^[0-9]+$/u.test(value ?? '')) fail('INVALID_ARGUMENT', `${label} must be a decimal integer from ${minimum} to ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail('INVALID_ARGUMENT', `${label} must be a decimal integer from ${minimum} to ${maximum}`);
  return parsed;
}

function parseArguments(argv) {
  const parsed = {
    port: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    path: null,
    help: false,
    version: false,
    discoveryJson: false,
    dynamicArguments: [],
    businessArguments: Object.create(null)
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) fail('INVALID_ARGUMENT', `positional arguments are not supported: ${argument}`);
    if (argument.includes('=')) fail('INVALID_ARGUMENT', `equals-form arguments are not supported: ${argument}`);
    if (argument === '--help') {
      if (seen.has(argument)) fail('INVALID_ARGUMENT', '--help may appear only once');
      seen.add(argument);
      parsed.help = true;
      continue;
    }
    if (argument === '--version') {
      if (seen.has(argument)) fail('INVALID_ARGUMENT', '--version may appear only once');
      seen.add(argument);
      parsed.version = true;
      continue;
    }
    if (argument === '--discovery-json') {
      if (seen.has(argument)) fail('INVALID_ARGUMENT', '--discovery-json may appear only once');
      seen.add(argument);
      parsed.discoveryJson = true;
      continue;
    }
    const optionName = argument.slice(2);
    if (!KNOWN_OPTION_NAMES.has(optionName)) fail('INVALID_ARGUMENT', `unknown option: --${optionName}`);
    if (seen.has(argument)) fail('INVALID_ARGUMENT', `${argument} may appear only once`);
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('INVALID_ARGUMENT', `${argument} requires a value`);
    index += 1;
    if (argument === '--port') parsed.port = parseDecimalInteger(value, '--port', 1, 65535);
    if (argument === '--path') parsed.path = value;
    if (argument === '--timeout-ms') parsed.timeoutMs = parseDecimalInteger(value, '--timeout-ms', 1, 600000);
    if (BUSINESS_OPTION_NAMES.has(optionName)) {
      parsed.dynamicArguments.push({ name: optionName, value });
      parsed.businessArguments[optionName] = value;
    }
  }
  if (parsed.version && argv.length !== 1) fail('INVALID_ARGUMENT', '--version does not accept other arguments');
  if (parsed.discoveryJson && (parsed.path !== null || parsed.help || parsed.dynamicArguments.length > 0)) {
    fail('INVALID_ARGUMENT', '--discovery-json cannot be combined with path, help, or query parameters');
  }
  if (parsed.help && parsed.path === null && parsed.dynamicArguments.length > 0) {
    fail('INVALID_ARGUMENT', 'top-level help does not accept query parameters');
  }
  if (parsed.path === null && parsed.dynamicArguments.length > 0) {
    fail('INVALID_ARGUMENT', 'query parameters require --path');
  }
  if (parsed.path !== null && !CATALOG_OPERATION_PATH_PATTERN.test(parsed.path)) {
    fail('INVALID_ARGUMENT', `--path must be an exact discovered operation path: ${parsed.path}`);
  }
  return parsed;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUnsafeText(value) {
  return UNSAFE_TEXT_PATTERN.test(value);
}

function assertSafeText(value, label) {
  if (typeof value !== 'string' || hasUnsafeText(value)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} contains unsafe control text`, 6);
  return value;
}

async function fetchDiscovery(port, execution) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${DISCOVERY_PATH}`, {
      method: 'GET',
      redirect: 'manual',
      signal: execution.signal
    });
  } catch (error) {
    execution.throwIfAborted();
    fail('DISCOVERY_CONNECTION_FAILED', error.message, 4);
  }
  let responseBuffer;
  try {
    responseBuffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    execution.throwIfAborted();
    fail('DISCOVERY_CONNECTION_FAILED', error.message, 4);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new CliError('DISCOVERY_HTTP_ERROR', CLI_ERROR_MESSAGES.DISCOVERY_HTTP_ERROR, 3);
  }
  let text;
  try { text = UTF8_DECODER.decode(responseBuffer); } catch { fail('DISCOVERY_PROTOCOL_ERROR', 'discovery response must be valid UTF-8 JSON', 6); }
  let discovery;
  try { discovery = JSON.parse(text); } catch { fail('DISCOVERY_PROTOCOL_ERROR', 'discovery response must be JSON', 6); }
  if (!isObject(discovery)) fail('DISCOVERY_PROTOCOL_ERROR', 'discovery response must be a JSON object', 6);
  return { body: discovery, buffer: responseBuffer };
}

function collectOperations(discovery) {
  return collectCatalogOperations(discovery);
}

function requireCatalogText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail('DISCOVERY_PROTOCOL_ERROR', `${label} must be a non-empty string`, 6);
  assertSafeText(value, label);
  return value;
}

function requireLocalComponentReference(value, discovery, label, section) {
  if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.$ref !== 'string') {
    fail('DISCOVERY_PROTOCOL_ERROR', `${label} must use one local ${section} reference`, 6);
  }
  const expression = new RegExp(`^#/components/${section}/[A-Za-z0-9_.-]+$`, 'u');
  if (!expression.test(value.$ref)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} must use one local ${section} reference`, 6);
  return resolveComponent(value, discovery, label, [section]);
}

function catalogSchemaType(schema) {
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((item) => item !== 'null');
    const uniqueTypes = new Set(schema.type);
    if (uniqueTypes.size !== schema.type.length || schema.type.length === 0
      || schema.type.some((item) => !['string', 'integer', 'number', 'boolean', 'object', 'array', 'null'].includes(item))) return undefined;
    if (schema.type.length === 2 && nonNullTypes.length === 1 && schema.type.includes('null')) return nonNullTypes[0];
    return 'union';
  }
  if (schema.type !== undefined) return schema.type;
  if (!Object.hasOwn(schema, 'const')) return undefined;
  if (schema.const === null) return 'null';
  if (typeof schema.const === 'number' && Number.isInteger(schema.const)) return 'integer';
  return typeof schema.const;
}

function catalogFieldDetails({ schema, discovery, label, required }) {
  if (!isObject(schema)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} must be a Schema object`, 6);
  const resolved = resolveSchema(schema, discovery, label);
  const description = schema.description ?? resolved.description;
  if (typeof description !== 'string' || description.trim() === '') fail('DISCOVERY_PROTOCOL_ERROR', `${label} must declare a description`, 6);
  assertSafeText(description, `${label}.description`);
  const example = Object.hasOwn(schema, 'example') ? schema.example : resolved.example;
  if (example === undefined) fail('DISCOVERY_PROTOCOL_ERROR', `${label} must declare an example`, 6);
  const details = schemaDetails(schema, discovery, label);
  matchesSchemaValue(example, details, `${label}.example`);
  return { name: label.slice(label.lastIndexOf('.') + 1), location: 'requestBody', required, schema: details, description, example };
}

function validateCatalogBranch({ schema, discovery, label, mode, allowedSearchFields }) {
  if (!isObject(schema) || schema.type !== 'object' || schema.additionalProperties !== false || Object.hasOwn(schema, 'oneOf') || Object.hasOwn(schema, 'anyOf') || Object.hasOwn(schema, 'allOf')) {
    fail('DISCOVERY_PROTOCOL_ERROR', `${label} must be a closed object branch`, 6);
  }
  requireCatalogText(schema.description, `${label}.description`);
  const properties = schema.properties;
  if (!isObject(properties)) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.properties must be an object`, 6);
  const filterNames = mode === 'search' ? allowedSearchFields : [];
  const expected = mode === 'search' ? ['mode', 'query', 'page', 'page_size', ...filterNames] : ['mode', 'id'];
  if (!Array.isArray(schema.required) || JSON.stringify(schema.required) !== JSON.stringify(mode === 'search' ? ['mode'] : ['mode', 'id'])) {
    fail('DISCOVERY_PROTOCOL_ERROR', `${label}.required fields are invalid`, 6);
  }
  if (JSON.stringify(Object.keys(properties)) !== JSON.stringify(expected)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} declares unexpected fields`, 6);
  const fields = [];
  for (const name of expected) {
    const field = properties[name];
    if (!isObject(field)) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.${name} must be a Schema object`, 6);
    const details = catalogFieldDetails({ schema: field, discovery, label: `${label}.${name}`, required: schema.required.includes(name) });
    fields.push(details);
  }
  const modeField = fields[0].schema;
  if (modeField.const !== mode || modeField.type !== 'string') fail('DISCOVERY_PROTOCOL_ERROR', `${label}.mode must use const ${mode}`, 6);
  if (mode === 'search') {
    const query = fields.find((field) => field.name === 'query').schema;
    const page = fields.find((field) => field.name === 'page').schema;
    const pageSize = fields.find((field) => field.name === 'page_size').schema;
    if (query.type !== 'string' || query.minLength !== 0 || query.maxLength !== 200 || query.default !== '') fail('DISCOVERY_PROTOCOL_ERROR', `${label}.query is invalid`, 6);
    if (page.type !== 'integer' || page.minimum !== 1 || page.maximum !== 100000 || page.default !== 1) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.page is invalid`, 6);
    if (pageSize.type !== 'integer' || pageSize.minimum !== 1 || pageSize.maximum !== 100 || pageSize.default !== 20) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.page_size is invalid`, 6);
    for (const name of filterNames) {
      const filter = fields.find((field) => field.name === name).schema;
      if (filter.type !== 'string' || filter.minLength !== 1 || filter.maxLength !== 20 || filter.pattern !== '^[1-9][0-9]{0,19}$') fail('DISCOVERY_PROTOCOL_ERROR', `${label}.${name} is invalid`, 6);
    }
  } else {
    const id = fields.find((field) => field.name === 'id').schema;
    if (id.type !== 'string' || id.minLength !== 1 || id.maxLength !== 20 || id.pattern !== '^[1-9][0-9]{0,19}$') fail('DISCOVERY_PROTOCOL_ERROR', `${label}.id is invalid`, 6);
  }
  const example = Object.fromEntries(fields.map((field) => [field.name, field.example]));
  return { schema, fields, example };
}

function mergeCatalogSchemas(base, overlay) {
  const merged = { ...base, ...overlay };
  if (isObject(base?.properties) || isObject(overlay?.properties)) {
    merged.properties = { ...(base?.properties ?? {}) };
    for (const [name, property] of Object.entries(overlay?.properties ?? {})) {
      merged.properties[name] = isObject(merged.properties[name]) && isObject(property)
        ? mergeCatalogSchemas(merged.properties[name], property)
        : property;
    }
  }
  if (Array.isArray(base?.required) || Array.isArray(overlay?.required)) merged.required = [...new Set([...(base?.required ?? []), ...(overlay?.required ?? [])])];
  return merged;
}

function mergedCatalogSchema(value, discovery, label, ancestors = new Set()) {
  const resolved = resolveComponent(value, discovery, label, ['schemas']);
  if (!isObject(resolved)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} must be a Schema object`, 6);
  if (ancestors.has(resolved)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} contains a recursive schema`, 6);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(resolved);
  let merged = {};
  if (resolved.allOf !== undefined) {
    if (!Array.isArray(resolved.allOf) || resolved.allOf.length === 0) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.allOf must be a non-empty array`, 6);
    for (const [index, child] of resolved.allOf.entries()) merged = mergeCatalogSchemas(merged, mergedCatalogSchema(child, discovery, `${label}.allOf[${index}]`, nextAncestors));
  }
  const own = { ...resolved };
  delete own.allOf;
  return mergeCatalogSchemas(merged, own);
}

function catalogRequestDetails({ discovery, path, operation }) {
  const registryEntry = CATALOG_OPERATION_REGISTRY[path];
  if (registryEntry === undefined) fail('DISCOVERY_PROTOCOL_ERROR', `discovery path ${path} is not a registered Catalog operation`, 6);
  const body = isObject(operation.requestBody) && typeof operation.requestBody.$ref === 'string'
    ? requireLocalComponentReference(operation.requestBody, discovery, `${operation.operationId}.requestBody`, 'requestBodies')
    : operation.requestBody;
  if (!isObject(body) || body.required !== true || !isObject(body.content) || Object.keys(body.content).length !== 1 || !isObject(body.content['application/json'])) {
    fail('DISCOVERY_PROTOCOL_ERROR', `${operation.operationId} must declare a required application/json request body`, 6);
  }
  const content = body.content['application/json'];
  if (content.example !== undefined || !isObject(content.examples) || Object.keys(content.examples).length === 0) fail('DISCOVERY_PROTOCOL_ERROR', `${operation.operationId}.requestBody must declare named JSON examples`, 6);
  const requestSchemaSource = content.schema;
  const root = requireLocalComponentReference(requestSchemaSource, discovery, `${operation.operationId}.requestBody.schema`, 'schemas');
  requireCatalogText(root.description, `${operation.operationId}.requestBody.schema.description`);
  if (root.type !== 'object' || root.additionalProperties !== undefined || !Array.isArray(root.oneOf) || root.oneOf.length !== 2) fail('DISCOVERY_PROTOCOL_ERROR', `${operation.operationId}.requestBody.schema must declare search and resolve oneOf object branches`, 6);
  const searchSource = root.oneOf[0];
  const resolveSource = root.oneOf[1];
  const search = validateCatalogBranch({ schema: requireLocalComponentReference(searchSource, discovery, `${operation.operationId}.requestBody.schema.oneOf[0]`, 'schemas'), discovery, label: `${operation.operationId}.search`, mode: 'search', allowedSearchFields: registryEntry.searchFields });
  const resolve = validateCatalogBranch({ schema: requireLocalComponentReference(resolveSource, discovery, `${operation.operationId}.requestBody.schema.oneOf[1]`, 'schemas'), discovery, label: `${operation.operationId}.resolve`, mode: 'resolve', allowedSearchFields: [] });
  const exampleNames = Object.keys(content.examples).sort();
  if (exampleNames.length !== 2 || exampleNames[0] !== 'resolve' || exampleNames[1] !== 'search') fail('DISCOVERY_PROTOCOL_ERROR', `${operation.operationId}.requestBody must declare exactly search and resolve examples`, 6);
  for (const [name, sourceExample] of Object.entries(content.examples)) {
    assertSafeText(name, `${operation.operationId}.requestBody.example`);
    if (!isObject(sourceExample) || !Object.hasOwn(sourceExample, 'value') || !isObject(sourceExample.value)) fail('DISCOVERY_PROTOCOL_ERROR', `${operation.operationId}.requestBody example ${name} must contain an object value`, 6);
    if (sourceExample.value.mode !== name) fail('DISCOVERY_PROTOCOL_ERROR', `${operation.operationId}.requestBody example ${name} must match its named branch`, 6);
    const branch = name === 'resolve' ? resolve.schema : search.schema;
    if (branch === null) fail('DISCOVERY_PROTOCOL_ERROR', `${operation.operationId}.requestBody example ${name} has an invalid mode`, 6);
    const branchDetails = schemaDetails(branch, discovery, `${operation.operationId}.requestBody.example.${name}`);
    matchesSchemaValue(sourceExample.value, branchDetails, `${operation.operationId}.requestBody.example.${name}`);
  }
  if (Object.hasOwn(root, 'example')) {
    const rootDetails = schemaDetails(search.schema, discovery, `${operation.operationId}.requestBody.schema.example`);
    matchesSchemaValue(root.example, rootDetails, `${operation.operationId}.requestBody.schema.example`);
  }
  return {
    parameters: [],
    requestBody: {
      required: true,
      schema: search.schema,
      properties: search.fields,
      example: search.example,
      branches: { search, resolve }
    }
  };
}

function collectCatalogOperations(discovery) {
  if (discovery.openapi !== '3.1.0' || !isObject(discovery.paths)) fail('DISCOVERY_PROTOCOL_ERROR', 'discovery must be an OpenAPI 3.1 document with paths', 6);
  const operations = [];
  const operationIds = new Set();
  const toolNames = new Set();
  for (const [path, pathItem] of Object.entries(discovery.paths)) {
    if (!CATALOG_OPERATION_PATH_PATTERN.test(path) || hasUnsafeText(path) || path.includes('{') || !isObject(pathItem)) fail('DISCOVERY_PROTOCOL_ERROR', `discovery path ${path} is not a valid Catalog operation`, 6);
    const registryEntry = CATALOG_OPERATION_REGISTRY[path];
    if (registryEntry === undefined) fail('DISCOVERY_PROTOCOL_ERROR', `discovery path ${path} is not a registered Catalog operation`, 6);
    const methods = HTTP_METHODS.filter((method) => Object.hasOwn(pathItem, method));
    if (methods.length !== 1 || methods[0] !== 'post') fail('DISCOVERY_PROTOCOL_ERROR', `discovery path ${path} must declare exactly one POST operation`, 6);
    const operation = pathItem.post;
    if (!isObject(operation)) fail('DISCOVERY_PROTOCOL_ERROR', `discovery operation POST ${path} must be an object`, 6);
    const operationId = requireCatalogText(operation.operationId, `POST ${path}.operationId`);
    const toolName = requireCatalogText(operation['x-harness-tool-name'], `POST ${path}.x-harness-tool-name`);
    if (operationId !== registryEntry.operationId) fail('DISCOVERY_PROTOCOL_ERROR', `POST ${path}.operationId does not match the Catalog operation registry`, 6);
    if (toolName !== registryEntry.toolName) fail('DISCOVERY_PROTOCOL_ERROR', `POST ${path}.x-harness-tool-name does not match the Catalog operation registry`, 6);
    requireCatalogText(operation.summary, `POST ${path}.summary`);
    requireCatalogText(operation.description, `POST ${path}.description`);
    if (operationIds.has(operationId) || toolNames.has(toolName)) fail('DISCOVERY_PROTOCOL_ERROR', `discovery operation identity is duplicated: ${operationId}`, 6);
    operationIds.add(operationId);
    toolNames.add(toolName);
    const details = catalogRequestDetails({ discovery, path, operation });
    operations.push({ method: 'post', path, operation, catalog: true, details });
  }
  if (operations.length === 0) fail('DISCOVERY_PROTOCOL_ERROR', 'discovery requires at least one Catalog operation', 6);
  return operations;
}

function resolveComponent(value, discovery, label, sections) {
  let current = value;
  const seen = new Set();
  while (isObject(current) && typeof current.$ref === 'string') {
    if (Object.keys(current).length !== 1) fail('DISCOVERY_PROTOCOL_ERROR', `${label} reference siblings are not supported`, 6);
    if (!current.$ref.startsWith('#/components/')) fail('DISCOVERY_PROTOCOL_ERROR', `${label} uses a non-local schema reference`, 6);
    if (seen.has(current.$ref)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} contains a recursive schema reference`, 6);
    seen.add(current.$ref);
    const match = /^#\/components\/([A-Za-z0-9_.-]+)\/([^/]+)$/u.exec(current.$ref);
    if (!match || !sections.includes(match[1]) || !isObject(discovery.components?.[match[1]]) || !Object.hasOwn(discovery.components[match[1]], match[2])) {
      fail('DISCOVERY_PROTOCOL_ERROR', `${label} references an unsupported or unknown component`, 6);
    }
    current = discovery.components[match[1]][match[2]];
  }
  return current;
}

function resolveSchema(value, discovery, label) {
  return resolveComponent(value, discovery, label, ['schemas']);
}

function scalarType(schema, label, { allowOneOf = false } = {}) {
  if (!isObject(schema)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} schema must be an object`, 6);
  for (const key of Object.keys(schema)) if (!SUPPORTED_SCHEMA_KEYS.has(key)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} uses unsupported Schema keyword ${key}`, 6);
  if (schema.description !== undefined) assertSafeText(schema.description, `${label}.description`);
  if ((Object.hasOwn(schema, 'oneOf') && !allowOneOf) || Object.hasOwn(schema, 'anyOf') || Object.hasOwn(schema, 'allOf')
    || Object.hasOwn(schema, 'not') || Object.hasOwn(schema, 'if') || Object.hasOwn(schema, 'then') || Object.hasOwn(schema, 'else')) {
    fail('DISCOVERY_PROTOCOL_ERROR', `${label} uses an unsupported composed schema`, 6);
  }
  let type = schema.type;
  if (type === undefined && Object.hasOwn(schema, 'const')) {
    type = schema.const === null ? 'null' : Array.isArray(schema.const) ? 'array' : typeof schema.const;
    if (type === 'number' && Number.isInteger(schema.const)) type = 'integer';
  }
  let nullable = false;
  let types = null;
  if (Array.isArray(type)) {
    if (type.length === 0 || new Set(type).size !== type.length
      || type.some((item) => !['string', 'integer', 'number', 'boolean', 'object', 'array', 'null'].includes(item))) {
      fail('DISCOVERY_PROTOCOL_ERROR', `${label} uses an unsupported union type`, 6);
    }
    types = type;
    nullable = type.includes('null');
    if (type.length === 2 && nullable) type = type.find((item) => item !== 'null');
    else type = 'union';
  }
  if (!['string', 'integer', 'number', 'boolean', 'null', 'object', 'array', 'union'].includes(type)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} has an unsupported JSON type`, 6);
  return { type, types: types ?? [type], nullable };
}

function validInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function valuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => valuesEqual(item, right[index]));
  if (isObject(left)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]));
  }
  return false;
}

function jsonValueTypes(value) {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array'];
  if (typeof value === 'number') return Number.isSafeInteger(value) ? ['integer', 'number'] : ['number'];
  return [typeof value];
}

function matchesStringFormat(value, format) {
  if (format === undefined) return true;
  if (typeof value !== 'string') return false;
  if (format === 'uri') {
    if (!/^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/u.test(value) || /%(?![0-9A-Fa-f]{2})/u.test(value)) return false;
    const rawUri = /^(?:https?):\/\/[^/?#]+(?<suffix>.*)$/iu.exec(value);
    if (!rawUri || /[\[\]]/u.test(rawUri.groups.suffix)) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
    } catch {
      return false;
    }
  }
  if (format === 'uri-reference') {
    return /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*$/u.test(value) && !/%(?![0-9A-Fa-f]{2})/u.test(value);
  }
  if (format === 'date-time') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
    if (!match) return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText = '00', offsetMinuteText = '00'] = match;
    const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
      yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText
    ].map(Number);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
      && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
  }
  return false;
}

function matchesSchemaValue(value, details, label) {
  if (Array.isArray(details.oneOf)) {
    let matchingBranches = 0;
    for (const [index, branch] of details.oneOf.entries()) {
      try {
        matchesSchemaValue(value, branch, `${label}.oneOf[${index}]`);
        matchingBranches += 1;
      } catch {
        // A response oneOf is valid only when exactly one complete branch matches.
      }
    }
    if (matchingBranches !== 1) fail('DISCOVERY_PROTOCOL_ERROR', `${label} must match exactly one response branch`, 6);
  }
  if (details.type === 'union') {
    if (!jsonValueTypes(value).some((type) => details.types.includes(type))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
    if (Object.hasOwn(details, 'const') && !valuesEqual(details.const, value)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its const`, 6);
    if (Array.isArray(details.enum) && !details.enum.some((item) => valuesEqual(item, value))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default is outside its enum`, 6);
    return true;
  }
  if (value === null) {
    if (details.nullable || details.type === 'null') {
      if (Object.hasOwn(details, 'const') && !valuesEqual(details.const, value)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its const`, 6);
      if (Array.isArray(details.enum) && !details.enum.some((item) => item === null)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default is outside its enum`, 6);
      return true;
    }
    fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
  }
  if (details.type === 'null') fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
  if (details.type === 'string' && typeof value !== 'string') fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
  if (details.type === 'integer' && (!Number.isSafeInteger(value))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
  if (details.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
  if (details.type === 'boolean' && typeof value !== 'boolean') fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
  if (details.type === 'array') {
    if (!Array.isArray(value)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
    if (details.minItems !== undefined && value.length < details.minItems || details.maxItems !== undefined && value.length > details.maxItems) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default violates array size constraints`, 6);
    for (const [index, item] of value.entries()) matchesSchemaValue(item, details.item, `${label}[${index}]`);
    if (details.uniqueItems && value.some((item, index) => value.slice(0, index).some((previous) => valuesEqual(previous, item)))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default violates uniqueItems`, 6);
  }
  if (details.type === 'object') {
    if (!isObject(value)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its Schema`, 6);
    if (details.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(details.propertyDetails ?? {}, key))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example contains an unknown property`, 6);
    for (const name of details.required ?? []) if (!Object.hasOwn(value, name)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example is missing required property ${name}`, 6);
    for (const [name, property] of Object.entries(details.propertyDetails ?? {})) if (Object.hasOwn(value, name)) matchesSchemaValue(value[name], property, `${label}.${name}`);
  }
  if (details.type === 'string') {
    const length = Array.from(value).length;
    if (details.minLength !== undefined && length < details.minLength || details.maxLength !== undefined && length > details.maxLength) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default violates string length constraints`, 6);
  }
  if (details.type === 'number' || details.type === 'integer') {
    if (details.minimum !== undefined && value < details.minimum || details.maximum !== undefined && value > details.maximum) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default violates numeric range constraints`, 6);
  }
  if (Object.hasOwn(details, 'const') && !valuesEqual(details.const, value)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its const`, 6);
  if (details.pattern !== undefined) {
    let pattern;
    try { pattern = new RegExp(details.pattern, 'u'); } catch { fail('DISCOVERY_PROTOCOL_ERROR', `${label}.pattern must be a valid regular expression`, 6); }
    if (typeof value !== 'string' || !pattern.test(value)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its pattern`, 6);
  }
  if (details.format !== undefined && !matchesStringFormat(value, details.format)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default does not match its format`, 6);
  if (Array.isArray(details.enum) && !details.enum.some((item) => valuesEqual(item, value))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} example/default is outside its enum`, 6);
  return true;
}

function validateSchemaDefinition(schema, details, label, { validateExamples = true } = {}) {
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some((item, index) => schema.enum.slice(0, index).some((previous) => valuesEqual(previous, item))))) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.enum must be a non-empty unique array`, 6);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') fail('DISCOVERY_PROTOCOL_ERROR', `${label}.additionalProperties must be boolean`, 6);
  for (const [name, value] of [['minimum', schema.minimum], ['maximum', schema.maximum]]) if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.${name} must be a finite number`, 6);
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.minimum must not exceed maximum`, 6);
  for (const [name, value] of [['minLength', schema.minLength], ['maxLength', schema.maxLength], ['minItems', schema.minItems], ['maxItems', schema.maxItems]]) if (value !== undefined && !validInteger(value)) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.${name} must be a non-negative integer`, 6);
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.minLength must not exceed maxLength`, 6);
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.minItems must not exceed maxItems`, 6);
  const schemaTypes = details.types ?? [details.type];
  if ((schema.minimum !== undefined || schema.maximum !== undefined) && schemaTypes.some((type) => !['number', 'integer', 'null'].includes(type))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} has numeric constraints on a non-numeric type`, 6);
  if ((schema.minLength !== undefined || schema.maxLength !== undefined) && schemaTypes.some((type) => !['string', 'null'].includes(type))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} has string constraints on a non-string type`, 6);
  if ((schema.minItems !== undefined || schema.maxItems !== undefined) && schemaTypes.some((type) => !['array', 'null'].includes(type))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} has array constraints on a non-array type`, 6);
  if (schema.uniqueItems !== undefined && (typeof schema.uniqueItems !== 'boolean' || schemaTypes.some((type) => !['array', 'null'].includes(type)))) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.uniqueItems must be a boolean on an array schema`, 6);
  if (schema.format !== undefined && (schemaTypes.some((type) => !['string', 'null'].includes(type)) || !['uri', 'uri-reference', 'date-time'].includes(schema.format))) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.format is unsupported`, 6);
  if (schema.const !== undefined) {
    const { const: _ignoredConst, enum: _ignoredEnum, ...constDetails } = details;
    matchesSchemaValue(schema.const, constDetails, `${label}.const`);
  }
  if (schema.pattern !== undefined) {
    if (schemaTypes.some((type) => !['string', 'null'].includes(type)) || typeof schema.pattern !== 'string') fail('DISCOVERY_PROTOCOL_ERROR', `${label}.pattern must be declared on a string schema`, 6);
    try { new RegExp(schema.pattern, 'u'); } catch { fail('DISCOVERY_PROTOCOL_ERROR', `${label}.pattern must be a valid regular expression`, 6); }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string') || new Set(schema.required).size !== schema.required.length || schema.required.some((name) => !Object.hasOwn(schema.properties ?? {}, name))) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.required must contain unique property names`, 6);
  }
  if (schema.additionalProperties !== undefined && schemaTypes.some((type) => !['object', 'null'].includes(type))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} has object constraints on a non-object type`, 6);
  if ((schema.properties !== undefined || schema.required !== undefined) && schemaTypes.some((type) => !['object', 'null'].includes(type))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} has object constraints on a non-object type`, 6);
  if (schema.items !== undefined && schemaTypes.some((type) => !['array', 'null'].includes(type))) fail('DISCOVERY_PROTOCOL_ERROR', `${label} has array constraints on a non-array type`, 6);
  if (validateExamples && schema.default !== undefined) matchesSchemaValue(schema.default, details, `${label}.default`);
  if (validateExamples && schema.example !== undefined) matchesSchemaValue(schema.example, details, `${label}.example`);
  if (validateExamples && Array.isArray(schema.enum)) for (const [index, value] of schema.enum.entries()) matchesSchemaValue(value, { ...details, enum: undefined }, `${label}.enum[${index}]`);
}

function schemaDetails(schema, discovery, label, ancestors = new Set(), options = {}) {
  const resolved = resolveSchema(schema, discovery, label);
  if (ancestors.has(resolved)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} contains a recursive schema`, 6);
  const merged = mergedCatalogSchema(schema, discovery, label, ancestors);
  const descendants = new Set(ancestors);
  descendants.add(resolved);
  if (Object.hasOwn(merged, 'oneOf') && (!options.allowOneOf || !Array.isArray(merged.oneOf) || merged.oneOf.length < 2)) {
    fail('DISCOVERY_PROTOCOL_ERROR', `${label} uses an unsupported or invalid response oneOf`, 6);
  }
  const scalar = scalarType(merged, label, options);
  const type = scalar.type;
  const oneOf = [];
  if (Array.isArray(merged.oneOf)) {
    const branchBase = { ...merged };
    delete branchBase.oneOf;
    for (const [index, branch] of merged.oneOf.entries()) {
      const resolvedBranch = mergedCatalogSchema(branch, discovery, `${label}.oneOf[${index}]`, descendants);
      if (Object.hasOwn(resolvedBranch, 'oneOf')) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.oneOf[${index}] must not be recursive or composed`, 6);
      oneOf.push(schemaDetails(mergeCatalogSchemas(branchBase, resolvedBranch), discovery, `${label}.oneOf[${index}]`, descendants, { ...options, allowOneOf: false }));
    }
  }
  if (type === 'array') {
    if (!isObject(merged.items)) fail('DISCOVERY_PROTOCOL_ERROR', `${label} array must declare items`, 6);
    const item = schemaDetails(merged.items, discovery, `${label}.items`, descendants, options);
    const details = { ...merged, ...(oneOf.length > 0 ? { oneOf } : {}), type, types: scalar.types, nullable: scalar.nullable, item, displayType: `array<${item.displayType}>${scalar.nullable ? '|null' : ''}`, repeatable: true };
    validateSchemaDefinition(merged, details, label, options);
    return details;
  }
  if (type === 'object' && merged.properties !== undefined && !isObject(merged.properties)) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.properties must be an object`, 6);
  if (type === 'object' && merged.additionalProperties !== false) fail('DISCOVERY_PROTOCOL_ERROR', `${label} object must declare additionalProperties: false`, 6);
  const propertyDetails = Object.create(null);
  if (type === 'object') {
    if (merged.required !== undefined && !Array.isArray(merged.required)) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.required must be an array`, 6);
    for (const [name, property] of Object.entries(merged.properties ?? {})) {
      if (!isObject(property)) fail('DISCOVERY_PROTOCOL_ERROR', `${label}.${name} must be a schema object`, 6);
      propertyDetails[name] = schemaDetails(property, discovery, `${label}.${name}`, descendants, options);
    }
  }
  const details = { ...merged, ...(oneOf.length > 0 ? { oneOf } : {}), type, types: scalar.types, nullable: scalar.nullable, propertyDetails, displayType: `${type === 'union' ? scalar.types.join('|') : type}${scalar.nullable ? '|null' : ''}`, repeatable: false };
  validateSchemaDefinition(merged, details, label, options);
  return details;
}

function assertRepeatableArrayHasValues(schema, label) {
  if (schema.type !== 'array') return;
  if (schema.item.type === 'array') fail('DISCOVERY_PROTOCOL_ERROR', `${label} repeatable array items must not be arrays`, 6);
  if (!Number.isSafeInteger(schema.minItems) || schema.minItems < 1) fail('DISCOVERY_PROTOCOL_ERROR', `${label} repeatable array must declare minItems >= 1`, 6);
}

function operationParameters({ discovery, path, operation }) {
  return catalogRequestDetails({ discovery, path, operation });
}

function safeJsonStringify(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail('DISCOVERY_PROTOCOL_ERROR', 'dynamic help value must be JSON serializable', 6);
  return serialized.replace(UNSAFE_TEXT_GLOBAL_PATTERN, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function formatRange(schema) {
  const hasMinimum = schema.minimum !== undefined;
  const hasMaximum = schema.maximum !== undefined;
  if (!hasMinimum && !hasMaximum) return null;
  if (hasMinimum && hasMaximum) return `${schema.minimum}..${schema.maximum}`;
  return hasMinimum ? `>= ${schema.minimum}` : `<= ${schema.maximum}`;
}

function formatCollectionRange(schema) {
  const hasMinimum = schema.minItems !== undefined;
  const hasMaximum = schema.maxItems !== undefined;
  if (!hasMinimum && !hasMaximum) return null;
  if (hasMinimum && hasMaximum) return `${schema.minItems}-${schema.maxItems}`;
  return hasMinimum ? `at least ${schema.minItems}` : `at most ${schema.maxItems}`;
}

function formatLength(schema) {
  const hasMinimum = schema.minLength !== undefined;
  const hasMaximum = schema.maxLength !== undefined;
  if (!hasMinimum && !hasMaximum) return null;
  if (hasMinimum && hasMaximum) return `${schema.minLength}..${schema.maxLength}`;
  return hasMinimum ? `>= ${schema.minLength}` : `<= ${schema.maxLength}`;
}

function formatParameterConstraints(schema) {
  const constraints = [];
  if (schema.default !== undefined) constraints.push(`default ${safeJsonStringify(schema.default)}`);
  const range = formatRange(schema);
  if (range !== null) constraints.push(`range ${range}`);
  if (schema.enum !== undefined) constraints.push(`enum ${safeJsonStringify(schema.enum)}`);
  if (schema.type === 'array') {
    const itemLength = formatLength(schema.item);
    if (itemLength !== null) constraints.push(`item length ${itemLength}`);
    const itemRange = formatRange(schema.item);
    if (itemRange !== null) constraints.push(`item range ${itemRange}`);
    if (schema.item.enum !== undefined) constraints.push(`item enum ${safeJsonStringify(schema.item.enum)}`);
    if (schema.item.default !== undefined) constraints.push(`item default ${safeJsonStringify(schema.item.default)}`);
  }
  if (schema.type === 'string') {
    const length = formatLength(schema);
    if (length !== null) constraints.push(`length ${length}`);
    if (schema.pattern === '^[1-9][0-9]{0,19}$') constraints.push('stable positive decimal ID');
    if (schema.pattern !== undefined) constraints.push(`pattern ${schema.pattern}`);
  }
  return constraints;
}

function parameterLines(parameter) {
  const { schema } = parameter;
  const status = parameter.requiredWhenBodyUsed ? 'required when request body is used' : parameter.required ? 'required' : 'optional';
  const repeat = schema.type === 'array' ? formatCollectionRange(schema) : null;
  const flags = [status];
  if (repeat !== null) flags.push(`repeat ${repeat} times`);
  const lines = [
    `  ${optionToken(parameter.name)}`,
    `    Value: <value> (${flags.join('; ')})`,
    `    Type: ${schema.displayType}`
  ];
  const constraints = formatParameterConstraints(schema);
  if (constraints.length > 0) lines.push(`    Constraints: ${constraints.join('; ')}`);
  lines.push(`    Description: ${parameter.description}`);
  return lines;
}

function usageParameter(parameter) {
  const option = `${optionToken(parameter.name)} <value>`;
  if (parameter.schema.type !== 'array') return parameter.required ? option : `[${option}]`;
  const repeated = `[${option} ...]`;
  return parameter.required ? `${option} ${repeated}` : `[${option} ${repeated}]`;
}

function pathHelpParameters(details) {
  const bodyParameters = details.requestBody?.properties ?? [];
  const helpBodyParameters = details.requestBody?.required === false
    ? bodyParameters.map((parameter) => parameter.required
      ? { ...parameter, required: false, requiredWhenBodyUsed: true }
      : parameter)
    : bodyParameters;
  return [...helpBodyParameters, ...details.parameters];
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function exampleArgumentText(schema, value) {
  if (schema.type === 'string' && (value === 'null' || hasUnsafeText(value))) return safeJsonStringify(value);
  return schema.type === 'object' || value === null ? safeJsonStringify(value) : String(value);
}

function optionToken(name) {
  return shellQuote(`--${name}`);
}

function invalidInput(message) {
  fail('INVALID_ARGUMENT', message);
}

function parseJsonValue(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    invalidInput(`${label} must be valid JSON`);
  }
}

function validateInputValue(value, schema, label) {
  if (value === null) {
    if (!schema.nullable && schema.type !== 'null') invalidInput(`${label} does not allow JSON null`);
  } else if (schema.type === 'null') invalidInput(`${label} must be JSON null`);
  else if (schema.type === 'string' && typeof value !== 'string') invalidInput(`${label} must be a string`);
  else if (schema.type === 'integer' && !Number.isSafeInteger(value)) invalidInput(`${label} must be a decimal safe integer`);
  else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) invalidInput(`${label} must be a finite JSON number`);
  else if (schema.type === 'boolean' && typeof value !== 'boolean') invalidInput(`${label} must be true or false`);
  else if (schema.type === 'object') {
    if (!isObject(value)) invalidInput(`${label} must be a complete JSON object`);
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((name) => !Object.hasOwn(schema.propertyDetails, name));
      if (unknown !== undefined) invalidInput(`${label} contains unknown property ${unknown}`);
    }
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) invalidInput(`${label} is missing required property ${name}`);
    for (const [name, property] of Object.entries(schema.propertyDetails ?? {})) if (Object.hasOwn(value, name)) validateInputValue(value[name], property, `${label}.${name}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) invalidInput(`${label} must be an array`);
    for (const [index, item] of value.entries()) validateInputValue(item, schema.item, `${label}[${index}]`);
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some((previous) => valuesEqual(previous, item)))) invalidInput(`${label} must contain unique items`);
  }
  if (value === null) {
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => valuesEqual(candidate, value))) invalidInput(`${label} is outside its enum`);
    if (Object.hasOwn(schema, 'const') && !valuesEqual(schema.const, value)) invalidInput(`${label} has an invalid value`);
    return value;
  }
  if (schema.type === 'string') {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) invalidInput(`${label} violates string length constraints`);
  }
  if (schema.type === 'array' && (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems)) invalidInput(`${label} violates array size constraints`);
  if ((schema.type === 'integer' || schema.type === 'number') && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) invalidInput(`${label} violates numeric range constraints`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => valuesEqual(candidate, value))) invalidInput(`${label} is outside its enum`);
  if (Object.hasOwn(schema, 'const') && !valuesEqual(schema.const, value)) invalidInput(`${label} has an invalid value`);
  if (schema.pattern !== undefined) {
    let pattern;
    try { pattern = new RegExp(schema.pattern, 'u'); } catch { invalidInput(`${label} has an invalid pattern`); }
    if (typeof value !== 'string' || !pattern.test(value)) invalidInput(`${label} violates its pattern`);
  }
  if (schema.format !== undefined && !matchesStringFormat(value, schema.format)) invalidInput(`${label} violates its format`);
  return value;
}

function parseInputToken(text, schema, label) {
  let value;
  if (text === 'null' && (schema.nullable || schema.type === 'null')) value = null;
  else if (schema.type === 'string') {
    value = text;
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      value = parseJsonValue(text, label);
      if (typeof value !== 'string') invalidInput(`${label} JSON string token must decode to a string`);
    }
    if (typeof value !== 'string') invalidInput(`${label} must be a string or a JSON string token`);
  }
  else if (schema.type === 'integer') {
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(text)) invalidInput(`${label} must be a decimal integer`);
    value = Number(text);
  } else if (schema.type === 'number' || schema.type === 'boolean' || schema.type === 'object') value = parseJsonValue(text, label);
  else invalidInput(`${label} uses an unsupported command value type`);
  return validateInputValue(value, schema, label);
}

function parseDynamicInput({ details, dynamicArguments }) {
  const definitions = new Map();
  for (const parameter of details.parameters) definitions.set(parameter.name, parameter);
  for (const property of details.requestBody?.properties ?? []) definitions.set(property.name, property);
  const values = new Map();
  for (const argument of dynamicArguments) {
    const definition = definitions.get(argument.name);
    if (!definition) invalidInput(`unknown parameter: --${argument.name}`);
    const existing = values.get(argument.name) ?? [];
    if (definition.schema.type !== 'array' && existing.length > 0) invalidInput(`--${argument.name} may appear only once`);
    existing.push(argument.value);
    values.set(argument.name, existing);
  }
  const parsed = new Map();
  for (const [name, tokens] of values) {
    const definition = definitions.get(name);
    if (definition.schema.type === 'array') {
      if (definition.schema.nullable && tokens.includes('null') && tokens.length > 1) invalidInput(`--${name} cannot combine JSON null with array items`);
      const value = tokens.length === 1 && tokens[0] === 'null' && definition.schema.nullable
        ? null
        : tokens.map((token, index) => parseInputToken(token, definition.schema.item, `--${name}[${index}]`));
      parsed.set(name, validateInputValue(value, definition.schema, `--${name}`));
    } else parsed.set(name, parseInputToken(tokens[0], definition.schema, `--${name}`));
  }
  const requestBodyProvided = [...parsed.keys()].some((name) => definitions.get(name).location === 'requestBody');
  for (const definition of definitions.values()) {
    if (!definition.required || parsed.has(definition.name)) continue;
    if (definition.location !== 'requestBody' || details.requestBody.required || requestBodyProvided) invalidInput(`missing required parameter: --${definition.name}`);
  }
  return parsed;
}

function requestDetailsForMode(details, mode) {
  const branch = details.requestBody?.branches?.[mode];
  if (!branch) invalidInput('--mode must be search or resolve');
  return {
    ...details,
    requestBody: {
      required: true,
      schema: branch.schema,
      properties: branch.fields,
      example: branch.example,
      branches: details.requestBody.branches
    }
  };
}

function parameterText(value) {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function buildQueryRequest({ port, selected, details, parsedInput }) {
  let pathname = selected.path.replace(/\{([^{}]+)\}/gu, (_match, name) => {
    const value = parsedInput.get(name);
    const parameter = details.parameters.find((candidate) => candidate.location === 'path' && candidate.name === name);
    const serialized = parameter.schema.type === 'array' && value !== null ? value.map(parameterText).join(',') : parameterText(value);
    return encodeURIComponent(serialized);
  });
  const query = new URLSearchParams();
  for (const parameter of details.parameters.filter((candidate) => candidate.location === 'query')) {
    if (!parsedInput.has(parameter.name)) continue;
    const value = parsedInput.get(parameter.name);
    if (parameter.schema.type === 'array' && value !== null) for (const item of value) query.append(parameter.name, parameterText(item));
    else query.append(parameter.name, parameterText(value));
  }
  const queryText = query.toString();
  if (queryText !== '') pathname += `?${queryText}`;
  let body;
  if (details.requestBody) {
    const bodyValue = Object.create(null);
    for (const property of details.requestBody.properties) if (parsedInput.has(property.name)) bodyValue[property.name] = parsedInput.get(property.name);
    if (details.requestBody.required || Object.keys(bodyValue).length > 0) body = JSON.stringify(bodyValue);
  }
  return {
    url: `http://127.0.0.1:${port}${pathname}`,
    options: {
      method: selected.method.toUpperCase(),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, body })
    }
  };
}

function parseResponseJson(body, label) {
  if (!Buffer.isBuffer(body) || body.length === 0) fail('CONTRACT_PROTOCOL_ERROR', `${label} must be a non-empty JSON value`, 6);
  let text;
  try {
    text = UTF8_DECODER.decode(body);
  } catch {
    fail('CONTRACT_PROTOCOL_ERROR', `${label} must be valid UTF-8 JSON`, 6);
  }
  if (text.trim() === '') fail('CONTRACT_PROTOCOL_ERROR', `${label} must be a non-empty JSON value`, 6);
  try {
    JSON.parse(text);
  } catch {
    fail('CONTRACT_PROTOCOL_ERROR', `${label} must be one JSON value`, 6);
  }
}

function sendQueryRequest(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = requestHttp(request.url, {
      method: request.options.method,
      headers: request.options.headers,
      signal: request.options.signal
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', rejectPromise);
      response.on('aborted', () => rejectPromise(new Error('query response was aborted')));
      response.on('end', () => resolvePromise({
        status: response.statusCode,
        body: Buffer.concat(chunks)
      }));
    });
    outgoing.on('error', rejectPromise);
    outgoing.end(request.options.body);
  });
}

async function executeQuery({ request }, execution) {
  let response;
  try {
    response = await sendQueryRequest({
      ...request,
      options: { ...request.options, signal: execution.signal }
    });
  } catch (error) {
    execution.throwIfAborted();
    fail('SOURCE_CONNECTION_FAILED', error.message, 4);
  }
  execution.throwIfAborted();
  const status = response.status;
  parseResponseJson(response.body, status >= 200 && status < 300 ? 'successful query response' : 'Catalog error response');
  if (status >= 200 && status < 300) {
    execution.throwIfAborted();
    process.stdout.write(response.body);
    return;
  }
  execution.throwIfAborted();
  throw new ServiceHttpError(response.body, 7);
}

function renderPathHelp({ port, path, operation, details }) {
  const allParameters = pathHelpParameters(details);
  const searchBranch = details.requestBody?.branches?.search;
  const resolveBranch = details.requestBody?.branches?.resolve;
  const resolveId = resolveBranch?.fields?.find((parameter) => parameter.name === 'id');
  const helpParameters = resolveId === undefined || allParameters.some((parameter) => parameter.name === resolveId.name)
    ? allParameters
    : [...allParameters, resolveId];
  const quotedPath = shellQuote(path);
  const invocation = [`${CLI_NAME}`, '--port', String(port), '--path', quotedPath];
  const bodyExample = details.requestBody?.example ?? Object.fromEntries((details.requestBody?.properties ?? []).filter((item) => item.example !== undefined).map((item) => [item.name, item.example]));
  if (details.requestBody && Object.keys(bodyExample).length > 0) {
    for (const [name, value] of Object.entries(bodyExample)) {
      const property = details.requestBody.properties.find((item) => item.name === name);
      if (!property) continue;
      if (value === null) invocation.push(optionToken(name), shellQuote(exampleArgumentText(property.schema, value)));
      else if (property.schema.type === 'array') for (const item of value) invocation.push(optionToken(name), shellQuote(exampleArgumentText(property.schema.item, item)));
      else invocation.push(optionToken(name), shellQuote(exampleArgumentText(property.schema, value)));
    }
  }
  for (const parameter of details.parameters) {
    const example = Object.hasOwn(parameter, 'example') ? parameter.example : parameter.schema.example;
    if (example === undefined) continue;
    if (example === null) invocation.push(optionToken(parameter.name), shellQuote(exampleArgumentText(parameter.schema, example)));
    else if (parameter.schema.type === 'array') for (const value of (Array.isArray(example) ? example : [example])) invocation.push(optionToken(parameter.name), shellQuote(exampleArgumentText(parameter.schema.item, value)));
    else invocation.push(optionToken(parameter.name), shellQuote(exampleArgumentText(parameter.schema, example)));
  }
  const searchUsageParameters = allParameters.filter((parameter) => parameter.name !== 'mode');
  const searchUsage = `  ${CLI_NAME} --port <port> --path ${quotedPath} --mode search${searchUsageParameters.length > 0 ? ` ${searchUsageParameters.map(usageParameter).join(' ')}` : ''}`;
  const resolveUsage = resolveId === undefined
    ? null
    : `  ${CLI_NAME} --port <port> --path ${quotedPath} --mode resolve --id <stable-id>`;
  const lines = [
    'Usage:',
    `  ${operation.method.toUpperCase()} ${path}`,
    ...(searchBranch === undefined ? [] : [searchUsage]),
    ...(resolveUsage === null ? [] : [resolveUsage]),
    `  Purpose: ${operation.operation.description}`,
    '',
    'Parameters:'
  ];
  for (const parameter of helpParameters) lines.push(...parameterLines(parameter));
  lines.push(
    '',
    'Example:',
    `  ${invocation.join(' ')}`,
    '',
    'Output:',
    "  The CLI requires the target service's 2xx response body to be non-empty, strictly UTF-8, and exactly one JSON value.",
    '  The CLI does not validate the 2xx response body against a response Schema or validate its fields.',
    '  The CLI writes the original 2xx response body Buffer to stdout without adding or removing bytes, writes nothing to stderr, and exits with code 0.',
    '  For any non-2xx response with a non-empty, strictly UTF-8 body containing exactly one JSON value, the CLI writes the original response body Buffer to stderr without adding or removing bytes, writes nothing to stdout, and exits with code 7.',
    '  The CLI does not validate the non-2xx HTTP status declaration, response Schema, response fields, or error code.',
    '  For an empty body, invalid UTF-8 body, invalid JSON body, or body containing multiple JSON values, the CLI writes a fixed CONTRACT_PROTOCOL_ERROR object to stderr, writes nothing to stdout, and exits with code 6.',
    '  The CLI reports argument failures with its fixed CLI error object and exit code 2, connection failures with exit code 4, timeout failures with exit code 5, and SIGINT or SIGTERM cancellation with exit code 130 or 143; each failure writes only the fixed CLI error object to stderr and writes nothing to stdout.'
  );
  return `${lines.join('\n')}\n`;
}

function renderTopLevelHelp({ port, operations }) {
  const lines = [CLI_NAME, 'Discover and query Catalog operations on a local loopback service.', ''];
  if (port === null) {
    lines.push(
      'Live discovery requires an explicit --port value.',
      '',
      'Usage:',
      `  ${CLI_NAME} --help`,
      `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] --help`,
      `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] --discovery-json`,
      `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] --path <operation-path> --help`,
      `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] --path <catalog-operation-path> --mode search [--query <text>] [--page <n>] [--page_size <n>] [allowed filter flags]`,
      `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] --path <catalog-operation-path> --mode resolve --id <stable-id>`,
      `  ${CLI_NAME} --version`,
      '',
      'Global options:',
      '  --port <port>                    Explicit loopback port from 1 to 65535',
      `  --timeout-ms <milliseconds>      Total request deadline from 1 to 600000 (default: ${DEFAULT_TIMEOUT_MS})`,
      '  --path <operation-path>          Exact operation path from live discovery',
      '  --discovery-json                 Print the closed live discovery wrapper',
      '  --help                           Show this overview or one operation help',
      '  --version                        Show the CLI name and version without discovery',
      '',
      'Next:',
      `  ${CLI_NAME} --port <port> --path <operation-path> --help`
    );
  } else {
    lines.push(`Current port: ${port}`, '', 'Operations:');
    for (const { method, path, operation } of operations) lines.push(`  ${method.toUpperCase()} ${path} - ${operation.summary}`);
    lines.push('', 'Next:', `  ${CLI_NAME} --port <port> --path <operation-path> --help`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv = [], testHooks = {}) {
  const options = parseArguments(argv);
  if (testHooks.injectInternalError === true) throw new Error('test-only internal failure');
  if (options.version) {
    process.stdout.write(`${CLI_NAME} ${CLI_VERSION}\n`);
    return;
  }
  if (options.help && options.path === null && options.port === null) {
    process.stdout.write(renderTopLevelHelp({ port: null, operations: [] }));
    return;
  }
  if (options.port === null) fail('INVALID_ARGUMENT', '--port is required before contacting the internal service');
  const execution = createExecutionContext(options.timeoutMs);
  try {
    const discoveryResponse = await fetchDiscovery(options.port, execution);
    const discovery = discoveryResponse.body;
    execution.throwIfAborted();
    const operations = collectOperations(discovery);
    if (options.discoveryJson) {
      process.stdout.write(discoveryResponse.buffer);
      return;
    }
    if (options.path !== null) {
      const selected = operations.find((operation) => operation.path === options.path);
      if (!selected) fail('INVALID_ARGUMENT', `unknown discovered path: ${options.path}`);
      const details = operationParameters({ discovery, path: selected.path, operation: selected.operation });
      if (options.help) {
        if (options.dynamicArguments.length > 0) fail('INVALID_ARGUMENT', 'path help does not accept business parameters');
        process.stdout.write(renderPathHelp({ port: options.port, path: selected.path, operation: selected, details }));
        return;
      }
      const mode = options.businessArguments.mode;
      const modeDetails = requestDetailsForMode(details, mode);
      const parsedInput = parseDynamicInput({ details: modeDetails, dynamicArguments: options.dynamicArguments });
      execution.throwIfAborted();
      await executeQuery({
        request: buildQueryRequest({ port: options.port, selected, details: modeDetails, parsedInput }),
        discovery,
        operation: selected.operation
      }, execution);
      return;
    }
    process.stdout.write(renderTopLevelHelp({ port: options.port, operations }));
  } finally {
    execution.dispose();
  }
}

function writeError(error) {
  if (error instanceof ServiceHttpError) {
    process.stderr.write(error.responseBody);
    process.exitCode = error.exitCode;
    return;
  }
  const normalized = error instanceof CliError ? error : new CliError('INTERNAL_CLI_ERROR', CLI_ERROR_MESSAGES.INTERNAL_CLI_ERROR, 6);
  const publicError = {
    code: normalized.code,
    message: normalized.message,
    exitCode: normalized.exitCode
  };
  if (normalized.code === 'DISCOVERY_PROTOCOL_ERROR' || normalized.code === 'QUERY_PROTOCOL_ERROR') {
    publicError.code = 'CONTRACT_PROTOCOL_ERROR';
    publicError.message = CLI_ERROR_MESSAGES.CONTRACT_PROTOCOL_ERROR;
    publicError.exitCode = 6;
  } else if (normalized.code === 'DISCOVERY_CONNECTION_FAILED' || normalized.code === 'QUERY_CONNECTION_FAILED') {
    publicError.code = 'SOURCE_CONNECTION_FAILED';
    publicError.message = CLI_ERROR_MESSAGES.SOURCE_CONNECTION_FAILED;
    publicError.exitCode = 4;
  } else if (!Object.hasOwn(CLI_ERROR_MESSAGES, normalized.code) || normalized.code === 'PROCESS_CANCELLED') {
    if (normalized.code === 'PROCESS_CANCELLED') {
      publicError.message = normalized.exitCode === 130
        ? 'Source request was cancelled by SIGINT.'
        : 'Source request was cancelled by SIGTERM.';
      publicError.exitCode = normalized.exitCode === 143 ? 143 : 130;
    } else {
      publicError.code = 'INTERNAL_CLI_ERROR';
      publicError.message = CLI_ERROR_MESSAGES.INTERNAL_CLI_ERROR;
      publicError.exitCode = 6;
    }
  } else {
    publicError.message = CLI_ERROR_MESSAGES[publicError.code];
  }
  process.stderr.write(`${safeJsonStringify({ error: { code: publicError.code, message: publicError.message } })}\n`);
  process.exitCode = publicError.exitCode;
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main(process.argv.slice(2)).catch(writeError);

export { collectOperations, main, operationParameters, parseArguments, renderPathHelp, renderTopLevelHelp, writeError };
