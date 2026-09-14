import { createServer } from 'node:http';
import { ApplicationError } from '../security/error-mapping.mjs';
import {
  assertIdentifier,
  assertRequestId,
  assertSearchQuery,
  validateArtistPromptStringWrite,
  validateBaseModelWrite,
  validateComfyuiInstanceWrite,
  validateComfyuiTemplateWrite,
  validateDeleteImpactConfirmation,
  validateLoraWrite,
  validateModelWrite,
  validatePromptTermListQuery,
  validatePromptTermWrite,
  validateCatalogManagementWrite,
  validateCatalogRequest,
  validateSemanticArtistPromptStringsInternalRequest,
  validateSemanticGenerationLorasInternalRequest,
  validateSemanticQueryRequest
} from '../security/input-validation.mjs';
import { parseMultipartFormData } from './media-http.mjs';
import { DuplicateJsonKeyError, MAX_REQUEST_BODY_BYTES, parseJsonRequestBody } from './json-request-body.mjs';
import { stripPublicPrefix } from './public-path.mjs';
import { RUNTIME_OPERATIONS, assertRuntimeRouteInventory, assertRuntimeRouteInventoryMatchesOperationIds, canonicalHttpMethod, deriveRuntimeRouteInventory, matchRuntimeRoute } from './runtime-operations.mjs';
import { SEMANTIC_HANDLER_ROUTE_MANIFEST } from './semantic-handler-routes.mjs';
import { assertSourceHandlerRoutesMatchRuntime, SOURCE_HANDLER_ROUTE_MANIFEST } from './source-handler-routes.mjs';
import { ARTIST_PROMPT_STRING_CATALOG_OPERATION_ID, BASE_MODEL_CATALOG_OPERATION_ID, CATALOG_ERROR_MESSAGES, CHARACTER_CATALOG_OPERATION_ID, COMFYUI_INSTANCE_CATALOG_OPERATION_ID, COMFYUI_TEMPLATE_CATALOG_OPERATION_ID, GENERATION_MODEL_CATALOG_OPERATION_ID, LORA_CATALOG_OPERATION_ID, PROMPT_TERM_CATALOG_OPERATION_ID, STYLE_CATALOG_OPERATION_ID, WORK_CATALOG_OPERATION_ID, isCatalogOperation } from '../contracts/catalog-contract.mjs';
import { SOURCE_DISCOVERY_OPERATION_ID, SOURCE_ERROR_MESSAGES, SOURCE_INSTANCE_OPERATION_ID, SOURCE_TEMPLATE_BUNDLE_OPERATION_ID, isSourceOperation } from '../contracts/source-contract.mjs';
import { TRANSACTION_STATE, hasTransactionState } from '../transaction-state.mjs';

export const AFTER_RESPONSE_CALLBACK = Symbol('catalog-http.after-response-callback');

const SERVICE_METHOD_FOR_OPERATION = Object.freeze({
  listWorks: 'listPublicCatalog',
  getWork: 'getWork',
  listWorkCharacters: 'listPublicCatalog',
  listCharacters: 'listPublicCatalog',
  getCharacter: 'getCharacter',
  listStyles: 'listPublicCatalog',
  getStyle: 'getStyle',
  listManageItems: 'listManageItems',
  getManageItemDetail: 'getManageItemDetail',
  createManageItem: 'createManageItem',
  updateManageItem: 'updateManageItem',
  getGenerationResourceOptions: 'getGenerationResourceOptions',
  getPromptTermOptions: 'getPromptTermOptions',
  listPromptTerms: 'listPromptTerms',
  createPromptTerm: 'createPromptTerm',
  getPromptTerm: 'getPromptTerm',
  updatePromptTerm: 'updatePromptTerm',
  deletePromptTerm: 'deletePromptTerm',
  listBaseModels: 'listBaseModels',
  createBaseModel: 'createBaseModel',
  getBaseModel: 'getBaseModel',
  updateBaseModel: 'updateBaseModel',
  deleteBaseModel: 'deleteBaseModel',
  getBaseModelDeleteImpact: 'getBaseModelDeleteImpact',
  listModels: 'listModels',
  createModel: 'createModel',
  getModel: 'getModel',
  updateModel: 'updateModel',
  deleteModel: 'deleteModel',
  getModelDeleteImpact: 'getModelDeleteImpact',
  listLoras: 'listLoras',
  createLora: 'createLora',
  getLora: 'getLora',
  updateLora: 'updateLora',
  deleteLora: 'deleteLora',
  getLoraDeleteImpact: 'getLoraDeleteImpact',
  listArtistPromptStrings: 'listArtistPromptStrings',
  createArtistPromptString: 'createArtistPromptString',
  getArtistPromptString: 'getArtistPromptString',
  updateArtistPromptString: 'updateArtistPromptString',
  deleteArtistPromptString: 'deleteArtistPromptString',
  getArtistPromptStringDeleteImpact: 'getArtistPromptStringDeleteImpact',
  listComfyuiInstances: 'listComfyuiInstances',
  createComfyuiInstance: 'createComfyuiInstance',
  getComfyuiInstance: 'getComfyuiInstance',
  updateComfyuiInstance: 'updateComfyuiInstance',
  deleteComfyuiInstance: 'deleteComfyuiInstance',
  validateComfyuiInstance: 'validateComfyuiInstance',
  getComfyuiInstanceDeleteImpact: 'getComfyuiInstanceDeleteImpact',
  listComfyuiTemplates: 'listComfyuiTemplates',
  createComfyuiTemplate: 'createComfyuiTemplate',
  getComfyuiTemplate: 'getComfyuiTemplate',
  updateComfyuiTemplate: 'updateComfyuiTemplate',
  deleteComfyuiTemplate: 'deleteComfyuiTemplate',
  getComfyuiTemplateDeleteImpact: 'getComfyuiTemplateDeleteImpact',
  searchCatalog: 'searchCatalog',
  searchSemanticWorks: 'searchSemanticWorks',
  searchSemanticCharacters: 'searchSemanticCharacters',
  searchSemanticStyles: 'searchSemanticStyles',
  searchSemanticPromptTerms: 'searchSemanticPromptTerms',
  querySemanticBaseModelsForSkill: 'querySemanticBaseModelsForSkill',
  querySemanticGenerationModelsForSkill: 'querySemanticGenerationModelsForSkill',
  querySemanticLorasForSkill: 'querySemanticLorasForSkill',
  querySemanticWorksForSkill: 'querySemanticWorksForSkill',
  querySemanticCharactersForSkill: 'querySemanticCharactersForSkill',
  querySemanticStylesForSkill: 'querySemanticStylesForSkill',
  querySemanticPromptTermsForSkill: 'querySemanticPromptTermsForSkill',
  querySemanticArtistPromptStringsForSkill: 'querySemanticArtistPromptStringsForSkill',
  querySemanticComfyuiInstancesForSkill: 'querySemanticComfyuiInstancesForSkill',
  querySemanticComfyuiTemplatesForSkill: 'querySemanticComfyuiTemplatesForSkill',
  getComfyuiInstanceSourceForHost: 'getComfyuiInstanceSourceForHost',
  getComfyuiTemplateBundleForHost: 'getComfyuiTemplateBundleForHost'
});

const REQUIRED_REQUEST_ID_OPERATIONS = new Set();

function deriveCatalogImplementedOperations(service) {
  return Object.freeze(Object.keys(SERVICE_METHOD_FOR_OPERATION)
    .filter((operationId) => typeof service?.[SERVICE_METHOD_FOR_OPERATION[operationId]] === 'function'));
}

function invokeService(service, operationId, ...args) {
  return service[SERVICE_METHOD_FOR_OPERATION[operationId]](...args);
}

function success(status, requestId, data) {
  const body = requestId === undefined
    ? { ok: true, data }
    : { ok: true, request_id: requestId, data };
  return Object.freeze({ status, body: Object.freeze(body) });
}

function successStatus(operationId, declaredStatus, data) {
  return declaredStatus;
}

function isSemanticOperation(operationId) {
  return typeof operationId === 'string' && operationId.startsWith('querySemantic');
}

function validateCatalogInternalRequest(value, options = {}) {
  try {
    return validateCatalogRequest(value, options);
  } catch {
    throw new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID);
  }
}

function semanticError(error) {
  if (error instanceof ApplicationError) return error;
  return new ApplicationError('SEMANTIC_QUERY_VALIDATION', error.message);
}

function validateSemanticInternalRequest(value) {
  try {
    return validateSemanticQueryRequest(value);
  } catch (error) {
    throw semanticError(error);
  }
}

function validateStyleSemanticInternalRequest(value) {
  try {
    return validateSemanticQueryRequest(value, { requireBaseModelName: true });
  } catch (error) {
    throw semanticError(error);
  }
}

function validateSemanticCliInternalRequest(value, validator) {
  try {
    return validator(value);
  } catch (error) {
    throw semanticError(error);
  }
}

function strictStyleSemanticQuery(query) {
  for (const key of query.keys()) {
    if (!['q', 'base_model_name', 'limit'].includes(key)) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', `style semantic query contains an unknown parameter: ${key}`);
  }
  for (const key of ['q', 'base_model_name', 'limit']) {
    if (query.getAll(key).length > 1) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', `style semantic query repeats ${key}`);
  }
  return {
    q: query.get('q'),
    base_model_name: query.get('base_model_name'),
    limit: query.has('limit') ? Number(query.get('limit')) : undefined
  };
}

function projectSemanticItem(operationId, item) {
  if (!item || typeof item !== 'object') return item;
  if (operationId === 'querySemanticWorksForSkill') {
    return { name: item.name, aliases: item.aliases, category_name: item.category_name ?? null, character_names: item.character_names ?? [] };
  }
  if (operationId === 'querySemanticCharactersForSkill') {
    return { work_name: item.work_name ?? null, name: item.name, aliases: item.aliases, prompt_text: item.prompt_text };
  }
  if (operationId === 'querySemanticStylesForSkill') {
    return { name: item.name, aliases: item.aliases, style_description: item.style_description ?? null, prompt_text: item.prompt_text };
  }
  if (operationId === 'querySemanticPromptTermsForSkill') {
    return { canonical_tag: item.canonical_tag, aliases: item.aliases };
  }
  return item;
}

function projectSemanticData(operationId, data) {
  if (data && typeof data.then === 'function') return data.then((value) => projectSemanticData(operationId, value));
  if (!isSemanticOperation(operationId) || !data || typeof data !== 'object' || !Array.isArray(data.groups)) return data;
  return Object.freeze({ groups: Object.freeze(data.groups.map((group) => Object.freeze({
    query: group.query,
    items: Object.freeze((Array.isArray(group.items) ? group.items : []).map((item) => Object.freeze(projectSemanticItem(operationId, item))))
  }))) });
}

function withOperationId(result, operationId) {
  if (typeof operationId !== 'string') return result;
  const copy = { ...result };
  if (typeof result?.[AFTER_RESPONSE_CALLBACK] === 'function') {
    Object.defineProperty(copy, AFTER_RESPONSE_CALLBACK, { value: result[AFTER_RESPONSE_CALLBACK] });
  }
  return Object.freeze(Object.defineProperty(copy, 'operationId', {
    value: operationId,
    enumerable: false
  }));
}

function attachAfterResponseCallback(result, callback) {
  if (typeof callback !== 'function') return result;
  const copy = { ...result };
  Object.defineProperty(copy, AFTER_RESPONSE_CALLBACK, { value: callback });
  return Object.freeze(copy);
}

export function registerResponseFinishCallback(response, result) {
  const afterResponse = result?.[AFTER_RESPONSE_CALLBACK];
  if (typeof afterResponse !== 'function') return;
  response.once('finish', () => {
    const pending = afterResponse();
    if (pending && typeof pending.then === 'function') pending.catch((error) => console.error(`应用关闭失败：${error.message}`));
  });
}

function failureResponse(errorMapper, operationId, error, requestId, onUncertainResponse = undefined) {
  const uncertain = hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN);
  const observedError = error;
  const afterResponseCallback = uncertain && typeof onUncertainResponse === 'function'
    ? () => onUncertainResponse(observedError)
    : undefined;
  if (error instanceof DuplicateJsonKeyError) {
    error = isCatalogOperation(operationId)
      ? new ApplicationError('CATALOG_REQUEST_INVALID', CATALOG_ERROR_MESSAGES.CATALOG_REQUEST_INVALID)
      : isSourceOperation(operationId)
        ? new ApplicationError('SOURCE_REQUEST_INVALID', SOURCE_ERROR_MESSAGES.SOURCE_REQUEST_INVALID)
      : operationId?.startsWith('searchSemantic')
        ? new ApplicationError('SEMANTIC_QUERY_VALIDATION', 'request body must be valid JSON')
        : new ApplicationError('VALIDATION_ERROR', 'request body must be valid JSON');
  }
  const response = errorMapper.toResponse(operationId, error, isSemanticOperation(operationId) || isSourceOperation(operationId) ? undefined : requestId);
  if (isCatalogOperation(operationId) || isSourceOperation(operationId)) {
    return attachAfterResponseCallback(Object.freeze({
      status: response.status,
      body: Object.freeze({
        status: 'error',
        message: response.body.error.message,
        results: Object.freeze([]),
        page: 1,
        page_size: 0,
        total_count: 0
      })
    }), afterResponseCallback);
  }
  return attachAfterResponseCallback(response, afterResponseCallback);
}

function sourceSuccessBody(value) {
  return Object.freeze({
    status: 'ok',
    message: null,
    results: Object.freeze([value]),
    page: 1,
    page_size: 1,
    total_count: 1
  });
}

function pathIdentifier(value, label) {
  if (!/^[1-9]\d*$/u.test(value)) throw new ApplicationError('VALIDATION_ERROR', `${label} must be a positive integer`);
  return assertIdentifier(Number(value), label);
}

function strictBaseModelListQuery(query) {
  for (const key of query.keys()) {
    if (!['page', 'page_size', 'q'].includes(key)) throw new ApplicationError('VALIDATION_ERROR', `base model list query contains an unknown parameter: ${key}`);
  }
  for (const key of ['page', 'page_size', 'q']) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `base model list query repeats ${key}`);
  }
  return Object.freeze({
    page: query.has('page') ? Number(query.get('page')) : undefined,
    page_size: query.has('page_size') ? Number(query.get('page_size')) : undefined,
    q: query.get('q') ?? ''
  });
}

function strictManageListQuery(query) {
  const keys = ['kind', 'q', 'limit', 'page', 'base_model_id', 'availability'];
  for (const key of query.keys()) {
    if (!keys.includes(key)) throw new ApplicationError('VALIDATION_ERROR', `management catalog query contains an unknown parameter: ${key}`);
  }
  for (const key of keys) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `management catalog query repeats ${key}`);
  }
  return Object.freeze({
    kind: query.get('kind') ?? 'all',
    query: query.get('q') ?? '',
    limit: query.has('limit') ? Number(query.get('limit')) : undefined,
    page: query.has('page') ? Number(query.get('page')) : undefined,
    base_model_id: query.has('base_model_id') ? Number(query.get('base_model_id')) : undefined,
    availability: query.has('availability') ? query.get('availability') : undefined
  });
}

function rejectQueryParameters(query, label) {
  const first = query.keys().next();
  if (!first.done) throw new ApplicationError('VALIDATION_ERROR', `${label} does not accept query parameters`);
}

function strictBooleanQueryValue(query, key, label) {
  if (!query.has(key)) return undefined;
  const value = query.get(key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ApplicationError('VALIDATION_ERROR', `${label} must be true or false`);
}

function strictModelListQuery(query) {
  const keys = ['page', 'page_size', 'q', 'base_model_id', 'file_format', 'precision_or_quantization'];
  for (const key of query.keys()) {
    if (!keys.includes(key)) throw new ApplicationError('VALIDATION_ERROR', `model list query contains an unknown parameter: ${key}`);
  }
  for (const key of keys) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `model list query repeats ${key}`);
  }
  return Object.freeze({
    page: query.has('page') ? Number(query.get('page')) : undefined,
    page_size: query.has('page_size') ? Number(query.get('page_size')) : undefined,
    q: query.get('q') ?? '',
    base_model_id: query.has('base_model_id') ? Number(query.get('base_model_id')) : undefined,
    file_format: query.has('file_format') ? query.get('file_format') : undefined,
    precision_or_quantization: query.has('precision_or_quantization') ? query.get('precision_or_quantization') : undefined
  });
}

function strictPromptTermListQuery(query) {
  const keys = ['page', 'page_size', 'q', 'category', 'post_count_min', 'post_count_max'];
  for (const key of query.keys()) {
    if (!keys.includes(key)) throw new ApplicationError('VALIDATION_ERROR', `Prompt Tag list query contains an unknown parameter: ${key}`);
  }
  for (const key of keys) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `Prompt Tag list query repeats ${key}`);
  }
  return validatePromptTermListQuery({
    page: query.has('page') ? Number(query.get('page')) : undefined,
    page_size: query.has('page_size') ? Number(query.get('page_size')) : undefined,
    q: query.get('q') ?? '',
    category: query.has('category') ? Number(query.get('category')) : undefined,
    post_count_min: query.has('post_count_min') ? Number(query.get('post_count_min')) : undefined,
    post_count_max: query.has('post_count_max') ? Number(query.get('post_count_max')) : undefined
  });
}

function strictLoraListQuery(query) {
  const keys = ['page', 'page_size', 'q', 'base_model_id', 'model_id', 'file_format', 'precision_or_quantization'];
  for (const key of query.keys()) {
    if (!keys.includes(key)) throw new ApplicationError('VALIDATION_ERROR', `lora list query contains an unknown parameter: ${key}`);
  }
  for (const key of keys) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `lora list query repeats ${key}`);
  }
  return Object.freeze({
    page: query.has('page') ? Number(query.get('page')) : undefined,
    page_size: query.has('page_size') ? Number(query.get('page_size')) : undefined,
    q: query.get('q') ?? '',
    base_model_id: query.has('base_model_id') ? Number(query.get('base_model_id')) : undefined,
    model_id: query.has('model_id') ? Number(query.get('model_id')) : undefined,
    file_format: query.has('file_format') ? query.get('file_format') : undefined,
    precision_or_quantization: query.has('precision_or_quantization') ? query.get('precision_or_quantization') : undefined
  });
}

function strictArtistPromptStringListQuery(query) {
  for (const key of query.keys()) {
    if (!['page', 'page_size', 'q', 'base_model_id', 'style_id'].includes(key)) throw new ApplicationError('VALIDATION_ERROR', `artist prompt string list query contains an unknown parameter: ${key}`);
  }
  for (const key of ['page', 'page_size', 'q', 'base_model_id', 'style_id']) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `artist prompt string list query repeats ${key}`);
  }
  return Object.freeze({
    page: query.has('page') ? Number(query.get('page')) : undefined,
    page_size: query.has('page_size') ? Number(query.get('page_size')) : undefined,
    q: query.get('q') ?? '',
    base_model_id: query.has('base_model_id') ? Number(query.get('base_model_id')) : undefined,
    style_id: query.has('style_id') ? Number(query.get('style_id')) : undefined
  });
}

function strictComfyuiInstanceListQuery(query) {
  const keys = ['page', 'page_size', 'q', 'credential_type', 'is_valid', 'is_enabled'];
  for (const key of query.keys()) {
    if (!keys.includes(key)) throw new ApplicationError('VALIDATION_ERROR', `ComfyUI instance list query contains an unknown parameter: ${key}`);
  }
  for (const key of keys) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `ComfyUI instance list query repeats ${key}`);
  }
  return Object.freeze({
    page: query.has('page') ? Number(query.get('page')) : undefined,
    page_size: query.has('page_size') ? Number(query.get('page_size')) : undefined,
    q: query.get('q') ?? '',
    credential_type: query.has('credential_type') ? query.get('credential_type') : undefined,
    is_valid: strictBooleanQueryValue(query, 'is_valid', 'ComfyUI instance is_valid filter'),
    is_enabled: strictBooleanQueryValue(query, 'is_enabled', 'ComfyUI instance is_enabled filter')
  });
}

function strictComfyuiTemplateListQuery(query) {
  const keys = ['page', 'page_size', 'q', 'base_model_id', 'model_id', 'lora_id', 'template_type'];
  for (const key of query.keys()) {
    if (!keys.includes(key)) throw new ApplicationError('VALIDATION_ERROR', `ComfyUI template list query contains an unknown parameter: ${key}`);
  }
  for (const key of keys) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `ComfyUI template list query repeats ${key}`);
  }
  return Object.freeze({
    page: query.has('page') ? Number(query.get('page')) : undefined,
    page_size: query.has('page_size') ? Number(query.get('page_size')) : undefined,
    q: query.get('q') ?? '',
    base_model_id: query.has('base_model_id') ? Number(query.get('base_model_id')) : undefined,
    model_id: query.has('model_id') ? Number(query.get('model_id')) : undefined,
    lora_id: query.has('lora_id') ? Number(query.get('lora_id')) : undefined,
    template_type: query.has('template_type') ? query.get('template_type') : undefined
  });
}

function strictComfyuiTemplateRuntimeInputCandidatesQuery(query) {
  for (const key of query.keys()) {
    if (key !== 'instance_id') throw new ApplicationError('VALIDATION_ERROR', `runtime input candidates query contains an unknown parameter: ${key}`);
  }
  if (query.getAll('instance_id').length !== 1) throw new ApplicationError('VALIDATION_ERROR', 'runtime input candidates query requires one instance_id');
  return Object.freeze({ instance_id: pathIdentifier(query.get('instance_id'), 'instance_id') });
}

function strictComfyuiRunListQuery(query) {
  const keys = ['created_from', 'created_to', 'template_name', 'model_name', 'status', 'page', 'page_size'];
  for (const key of query.keys()) {
    if (!keys.includes(key)) throw new ApplicationError('VALIDATION_ERROR', `ComfyUI run list query contains an unknown parameter: ${key}`);
  }
  for (const key of keys) {
    if (query.getAll(key).length > 1) throw new ApplicationError('VALIDATION_ERROR', `ComfyUI run list query repeats ${key}`);
  }
  return Object.freeze({
    created_from: query.get('created_from') ?? undefined,
    created_to: query.get('created_to') ?? undefined,
    template_name: query.get('template_name') ?? '',
    model_name: query.get('model_name') ?? '',
    status: query.get('status') ?? undefined,
    page: query.has('page') ? Number(query.get('page')) : undefined,
    page_size: query.has('page_size') ? Number(query.get('page_size')) : undefined
  });
}

function routePublic(method, pathname, query, body, requestId, service, apiPublicPath) {
  const apiPathname = stripPublicPrefix(pathname, apiPublicPath);
  if (apiPathname === null) return null;
  if (apiPathname === '/manage/generation-resource-options' && method === 'GET') {
    return ['getGenerationResourceOptions', 200, () => {
      rejectQueryParameters(query, 'generation resource options');
      return invokeService(service, 'getGenerationResourceOptions');
    }];
  }
  if (apiPathname === '/manage/prompt-term-options' && method === 'GET') {
    return ['getPromptTermOptions', 200, () => {
      rejectQueryParameters(query, 'Prompt Tag options');
      return invokeService(service, 'getPromptTermOptions');
    }];
  }
  if (apiPathname === '/manage/prompt-terms') {
    if (method === 'GET') return ['listPromptTerms', 200, () => invokeService(service, 'listPromptTerms', strictPromptTermListQuery(query))];
    if (method === 'POST') return ['createPromptTerm', 201, () => invokeService(service, 'createPromptTerm', validatePromptTermWrite(body))];
  }
  const promptTermMatch = /^\/manage\/prompt-terms\/([^/]+)$/u.exec(apiPathname);
  if (promptTermMatch) {
    const id = () => pathIdentifier(promptTermMatch[1], 'id');
    if (method === 'GET') return ['getPromptTerm', 200, () => invokeService(service, 'getPromptTerm', id())];
    if (method === 'PUT') return ['updatePromptTerm', 200, () => invokeService(service, 'updatePromptTerm', id(), validatePromptTermWrite(body))];
    if (method === 'DELETE') return ['deletePromptTerm', 200, () => invokeService(service, 'deletePromptTerm', id())];
  }
  if (apiPathname === '/manage/base-models') {
    if (method === 'GET') return ['listBaseModels', 200, () => invokeService(service, 'listBaseModels', strictBaseModelListQuery(query))];
    if (method === 'POST') return ['createBaseModel', 201, () => invokeService(service, 'createBaseModel', validateBaseModelWrite(body))];
  }
  const baseModelImpactMatch = /^\/manage\/base-models\/([^/]+)\/delete-impact$/u.exec(apiPathname);
  if (method === 'GET' && baseModelImpactMatch) {
    return ['getBaseModelDeleteImpact', 200, () => invokeService(service, 'getBaseModelDeleteImpact', pathIdentifier(baseModelImpactMatch[1], 'id'))];
  }
  const baseModelMatch = /^\/manage\/base-models\/([^/]+)$/u.exec(apiPathname);
  if (baseModelMatch) {
    const id = () => pathIdentifier(baseModelMatch[1], 'id');
    if (method === 'GET') return ['getBaseModel', 200, () => invokeService(service, 'getBaseModel', id())];
    if (method === 'PUT') return ['updateBaseModel', 200, () => invokeService(service, 'updateBaseModel', id(), validateBaseModelWrite(body))];
    if (method === 'DELETE') return ['deleteBaseModel', 200, () => invokeService(service, 'deleteBaseModel', id(), validateDeleteImpactConfirmation(body).impact_token)];
  }
  if (apiPathname === '/manage/models') {
    if (method === 'GET') return ['listModels', 200, () => invokeService(service, 'listModels', strictModelListQuery(query))];
    if (method === 'POST') return ['createModel', 201, () => invokeService(service, 'createModel', validateModelWrite(body))];
  }
  const modelImpactMatch = /^\/manage\/models\/([^/]+)\/delete-impact$/u.exec(apiPathname);
  if (method === 'GET' && modelImpactMatch) {
    return ['getModelDeleteImpact', 200, () => invokeService(service, 'getModelDeleteImpact', pathIdentifier(modelImpactMatch[1], 'id'))];
  }
  const modelMatch = /^\/manage\/models\/([^/]+)$/u.exec(apiPathname);
  if (modelMatch) {
    const id = () => pathIdentifier(modelMatch[1], 'id');
    if (method === 'GET') return ['getModel', 200, () => invokeService(service, 'getModel', id())];
    if (method === 'PUT') return ['updateModel', 200, () => invokeService(service, 'updateModel', id(), validateModelWrite(body))];
    if (method === 'DELETE') return ['deleteModel', 200, () => invokeService(service, 'deleteModel', id(), validateDeleteImpactConfirmation(body).impact_token)];
  }
  if (apiPathname === '/manage/loras') {
    if (method === 'GET') return ['listLoras', 200, () => invokeService(service, 'listLoras', strictLoraListQuery(query))];
    if (method === 'POST') return ['createLora', 201, () => invokeService(service, 'createLora', validateLoraWrite(body))];
  }
  const loraImpactMatch = /^\/manage\/loras\/([^/]+)\/delete-impact$/u.exec(apiPathname);
  if (method === 'GET' && loraImpactMatch) {
    return ['getLoraDeleteImpact', 200, () => invokeService(service, 'getLoraDeleteImpact', pathIdentifier(loraImpactMatch[1], 'id'))];
  }
  const loraMatch = /^\/manage\/loras\/([^/]+)$/u.exec(apiPathname);
  if (loraMatch) {
    const id = () => pathIdentifier(loraMatch[1], 'id');
    if (method === 'GET') return ['getLora', 200, () => invokeService(service, 'getLora', id())];
    if (method === 'PUT') return ['updateLora', 200, () => invokeService(service, 'updateLora', id(), validateLoraWrite(body))];
    if (method === 'DELETE') return ['deleteLora', 200, () => invokeService(service, 'deleteLora', id(), validateDeleteImpactConfirmation(body).impact_token)];
  }
  if (apiPathname === '/manage/artist-prompt-strings') {
    if (method === 'GET') return ['listArtistPromptStrings', 200, () => invokeService(service, 'listArtistPromptStrings', strictArtistPromptStringListQuery(query))];
    if (method === 'POST') return ['createArtistPromptString', 201, () => invokeService(service, 'createArtistPromptString', validateArtistPromptStringWrite(body))];
  }
  const artistPromptStringImpactMatch = /^\/manage\/artist-prompt-strings\/([^/]+)\/delete-impact$/u.exec(apiPathname);
  if (method === 'GET' && artistPromptStringImpactMatch) {
    return ['getArtistPromptStringDeleteImpact', 200, () => invokeService(service, 'getArtistPromptStringDeleteImpact', pathIdentifier(artistPromptStringImpactMatch[1], 'id'))];
  }
  const artistPromptStringMatch = /^\/manage\/artist-prompt-strings\/([^/]+)$/u.exec(apiPathname);
  if (artistPromptStringMatch) {
    const id = () => pathIdentifier(artistPromptStringMatch[1], 'id');
    if (method === 'GET') return ['getArtistPromptString', 200, () => invokeService(service, 'getArtistPromptString', id())];
    if (method === 'PUT') return ['updateArtistPromptString', 200, () => invokeService(service, 'updateArtistPromptString', id(), validateArtistPromptStringWrite(body))];
    if (method === 'DELETE') return ['deleteArtistPromptString', 200, () => invokeService(service, 'deleteArtistPromptString', id(), validateDeleteImpactConfirmation(body).impact_token)];
  }
  if (apiPathname === '/manage/comfyui-instances') {
    if (method === 'GET') return ['listComfyuiInstances', 200, () => invokeService(service, 'listComfyuiInstances', strictComfyuiInstanceListQuery(query))];
    if (method === 'POST') return ['createComfyuiInstance', 201, () => invokeService(service, 'createComfyuiInstance', validateComfyuiInstanceWrite(body, { creating: true }))];
  }
  const comfyuiInstanceImpactMatch = /^\/manage\/comfyui-instances\/([^/]+)\/delete-impact$/u.exec(apiPathname);
  if (method === 'GET' && comfyuiInstanceImpactMatch) {
    return ['getComfyuiInstanceDeleteImpact', 200, () => invokeService(service, 'getComfyuiInstanceDeleteImpact', pathIdentifier(comfyuiInstanceImpactMatch[1], 'id'))];
  }
  const comfyuiInstanceValidationMatch = /^\/manage\/comfyui-instances\/([^/]+)\/validate$/u.exec(apiPathname);
  if (method === 'POST' && comfyuiInstanceValidationMatch) {
    return ['validateComfyuiInstance', 200, () => invokeService(service, 'validateComfyuiInstance', pathIdentifier(comfyuiInstanceValidationMatch[1], 'id'))];
  }
  const comfyuiInstanceMatch = /^\/manage\/comfyui-instances\/([^/]+)$/u.exec(apiPathname);
  if (comfyuiInstanceMatch) {
    const id = () => pathIdentifier(comfyuiInstanceMatch[1], 'id');
    if (method === 'GET') return ['getComfyuiInstance', 200, () => invokeService(service, 'getComfyuiInstance', id())];
    if (method === 'PUT') return ['updateComfyuiInstance', 200, () => invokeService(service, 'updateComfyuiInstance', id(), validateComfyuiInstanceWrite(body))];
    if (method === 'DELETE') return ['deleteComfyuiInstance', 200, () => invokeService(service, 'deleteComfyuiInstance', id(), validateDeleteImpactConfirmation(body).impact_token)];
  }
  if (apiPathname === '/manage/comfyui-templates') {
    if (method === 'GET') return ['listComfyuiTemplates', 200, () => invokeService(service, 'listComfyuiTemplates', strictComfyuiTemplateListQuery(query))];
    if (method === 'POST') return ['createComfyuiTemplate', 201, () => invokeService(service, 'createComfyuiTemplate', validateComfyuiTemplateWrite(body))];
  }
  const comfyuiTemplateImpactMatch = /^\/manage\/comfyui-templates\/([^/]+)\/delete-impact$/u.exec(apiPathname);
  if (method === 'GET' && comfyuiTemplateImpactMatch) {
    return ['getComfyuiTemplateDeleteImpact', 200, () => invokeService(service, 'getComfyuiTemplateDeleteImpact', pathIdentifier(comfyuiTemplateImpactMatch[1], 'id'))];
  }
  const comfyuiTemplateMatch = /^\/manage\/comfyui-templates\/([^/]+)$/u.exec(apiPathname);
  if (comfyuiTemplateMatch) {
    const id = () => pathIdentifier(comfyuiTemplateMatch[1], 'id');
    if (method === 'GET') return ['getComfyuiTemplate', 200, () => invokeService(service, 'getComfyuiTemplate', id())];
    if (method === 'PUT') return ['updateComfyuiTemplate', 200, () => invokeService(service, 'updateComfyuiTemplate', id(), validateComfyuiTemplateWrite(body))];
    if (method === 'DELETE') return ['deleteComfyuiTemplate', 200, () => invokeService(service, 'deleteComfyuiTemplate', id(), validateDeleteImpactConfirmation(body).impact_token)];
  }
  if (method === 'GET' && apiPathname === '/manage/items') {
    return ['listManageItems', () => invokeService(service, 'listManageItems', strictManageListQuery(query))];
  }
  const manageCreateMatch = /^\/manage\/items\/([^/]+)$/u.exec(apiPathname);
  if (method === 'POST' && manageCreateMatch) {
    const kind = manageCreateMatch[1];
    return ['createManageItem', 201, () => invokeService(service, 'createManageItem', kind, validateCatalogManagementWrite(kind, body))];
  }
  const manageDetailMatch = /^\/manage\/items\/([^/]+)\/([^/]+)$/u.exec(apiPathname);
  if (manageDetailMatch) {
    const kind = manageDetailMatch[1];
    const id = () => pathIdentifier(manageDetailMatch[2], 'item_id');
    if (method === 'GET') return ['getManageItemDetail', () => invokeService(service, 'getManageItemDetail', kind, id())];
    if (method === 'PUT') return ['updateManageItem', 200, () => invokeService(service, 'updateManageItem', kind, id(), validateCatalogManagementWrite(kind, body))];
  }
  const catalogQuery = () => ({
    query: query.get('q') ?? '',
    limit: query.has('limit') ? Number(query.get('limit')) : undefined,
    cursor: query.get('cursor')
  });
  if (method === 'GET' && apiPathname === '/works') return ['listWorks', () => invokeService(service, 'listWorks', 'work', catalogQuery())];
  if (method === 'GET' && apiPathname === '/characters') return ['listCharacters', () => invokeService(service, 'listCharacters', 'character', catalogQuery())];
  if (method === 'GET' && apiPathname === '/styles') return ['listStyles', () => invokeService(service, 'listStyles', 'style', catalogQuery())];
  if (method === 'GET' && apiPathname === '/search') return ['searchCatalog', () => ({ items: invokeService(service, 'searchCatalog', query.get('q')) })];
  if (method === 'GET' && apiPathname === '/semantic/works') return ['searchSemanticWorks', () => invokeService(service, 'searchSemanticWorks', {
    q: query.get('q'), limit: query.has('limit') ? Number(query.get('limit')) : undefined
  })];
  if (method === 'GET' && apiPathname === '/semantic/characters') return ['searchSemanticCharacters', () => invokeService(service, 'searchSemanticCharacters', {
    q: query.get('q'), limit: query.has('limit') ? Number(query.get('limit')) : undefined,
    work_id: query.has('work_id') ? Number(query.get('work_id')) : null
  })];
  if (method === 'GET' && apiPathname === '/semantic/styles') return ['searchSemanticStyles', () => invokeService(service, 'searchSemanticStyles', strictStyleSemanticQuery(query))];
  if (method === 'GET' && apiPathname === '/semantic/prompt-terms') return ['searchSemanticPromptTerms', () => invokeService(service, 'searchSemanticPromptTerms', {
    q: query.get('q'), limit: query.has('limit') ? Number(query.get('limit')) : undefined
  })];
  const workCharacterMatch = /^\/works\/([^/]+)\/characters$/u.exec(apiPathname);
  if (method === 'GET' && workCharacterMatch) return ['listWorkCharacters', () => invokeService(service, 'listWorkCharacters', 'character', {
    ...catalogQuery(), workId: pathIdentifier(workCharacterMatch[1], 'work_id')
  })];
  const workMatch = /^\/works\/([^/]+)$/u.exec(apiPathname);
  if (method === 'GET' && workMatch) return ['getWork', () => invokeService(service, 'getWork', pathIdentifier(workMatch[1], 'work_id'))];
  const characterMatch = /^\/characters\/([^/]+)$/u.exec(apiPathname);
  if (method === 'GET' && characterMatch) return ['getCharacter', () => invokeService(service, 'getCharacter', pathIdentifier(characterMatch[1], 'character_id'))];
  const styleMatch = /^\/styles\/([^/]+)$/u.exec(apiPathname);
  if (method === 'GET' && styleMatch) return ['getStyle', () => invokeService(service, 'getStyle', pathIdentifier(styleMatch[1], 'style_id'))];
  return null;
}

function routeSemanticFromManifest(method, pathname, body, service, semanticDiscovery) {
  const route = SEMANTIC_HANDLER_ROUTE_MANIFEST.find((candidate) => candidate.method === method.toLowerCase() && candidate.path === pathname);
  if (!route) return null;
  if (route.operationId === 'getSemanticDiscovery') {
    return semanticDiscovery === null ? null : [route.operationId, 200, () => semanticDiscovery];
  }
  const query = route.operationId === BASE_MODEL_CATALOG_OPERATION_ID
    ? validateCatalogInternalRequest(body)
    : route.operationId === GENERATION_MODEL_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body, { allowedSearchFields: ['base_model_id'] })
    : route.operationId === LORA_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body, { allowedSearchFields: ['base_model_id'] })
    : route.operationId === WORK_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body)
    : route.operationId === CHARACTER_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body, { allowedSearchFields: ['work_id'] })
    : route.operationId === STYLE_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body, { allowedSearchFields: ['base_model_id'] })
    : route.operationId === PROMPT_TERM_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body)
    : route.operationId === ARTIST_PROMPT_STRING_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body, { allowedSearchFields: ['base_model_id'] })
    : route.operationId === COMFYUI_INSTANCE_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body)
    : route.operationId === COMFYUI_TEMPLATE_CATALOG_OPERATION_ID
      ? validateCatalogInternalRequest(body, { allowedSearchFields: ['base_model_id'] })
    : route.operationId === 'querySemanticGenerationLorasForCli'
      ? validateSemanticCliInternalRequest(body, validateSemanticGenerationLorasInternalRequest)
      : route.operationId === 'querySemanticArtistPromptStringsForCli'
        ? validateSemanticCliInternalRequest(body, validateSemanticArtistPromptStringsInternalRequest)
        : validateSemanticInternalRequest(body);
  return [route.operationId, () => projectSemanticData(route.operationId, invokeService(service, route.operationId, query))];
}

function routeInternal(method, pathname, body, service, semanticDiscovery = null, sourceDiscovery = null) {
  if (method === 'GET' && pathname === '/internal/comfyui-source') {
    return sourceDiscovery === null ? null : [SOURCE_DISCOVERY_OPERATION_ID, 200, () => sourceDiscovery];
  }
  if (method === 'GET') {
    const sourceInstanceMatch = /^\/internal\/comfyui-source\/instances\/([^/]*)$/u.exec(pathname);
    if (sourceInstanceMatch && SOURCE_HANDLER_ROUTE_MANIFEST.some(({ operationId }) => operationId === SOURCE_INSTANCE_OPERATION_ID)) {
      return [SOURCE_INSTANCE_OPERATION_ID, 200, () => invokeService(service, SOURCE_INSTANCE_OPERATION_ID, sourceInstanceMatch[1])];
    }
    const sourceTemplateBundleMatch = /^\/internal\/comfyui-source\/templates\/([^/]*)\/bundle$/u.exec(pathname);
    if (sourceTemplateBundleMatch && SOURCE_HANDLER_ROUTE_MANIFEST.some(({ operationId }) => operationId === SOURCE_TEMPLATE_BUNDLE_OPERATION_ID)) {
      return [SOURCE_TEMPLATE_BUNDLE_OPERATION_ID, 200, () => invokeService(service, SOURCE_TEMPLATE_BUNDLE_OPERATION_ID, sourceTemplateBundleMatch[1])];
    }
  }
  const semanticRoute = routeSemanticFromManifest(method, pathname, body, service, semanticDiscovery);
  if (semanticRoute) return semanticRoute;
  return null;
}

export function createCatalogHttpDispatcher({ service, errorMapper, authorizeWrite = () => true, mediaDispatcher = null, apiPublicPath = '/api', semanticDiscovery = null, sourceDiscovery = null, runtimeOperations = RUNTIME_OPERATIONS, onUncertainResponse = undefined }) {
  if (!service) throw new TypeError('service is required');
  if (!errorMapper) throw new TypeError('errorMapper is required');
  if (!Array.isArray(runtimeOperations)) throw new TypeError('runtimeOperations must be an array');
  if (onUncertainResponse !== undefined && typeof onUncertainResponse !== 'function') throw new TypeError('onUncertainResponse must be a function');
  const implementedOperations = deriveCatalogImplementedOperations(service);
  for (const operationId of implementedOperations) {
    if (operationId !== 'getSemanticDiscovery' && operationId !== SOURCE_DISCOVERY_OPERATION_ID) {
      errorMapper.assertKnownCode(operationId, isCatalogOperation(operationId)
        ? 'CATALOG_INTERNAL_ERROR'
        : isSourceOperation(operationId)
          ? 'SOURCE_INTERNAL_ERROR'
          : 'INTERNAL_ERROR');
    }
  }
  let injectedOperations = Object.freeze([]);
  let injectedRuntimeRouteInventory = Object.freeze([]);
  if (mediaDispatcher !== null) {
    if (typeof mediaDispatcher.canHandle !== 'function' || typeof mediaDispatcher.dispatch !== 'function') {
      throw new Error('mediaDispatcher must expose canHandle and dispatch');
    }
    injectedOperations = mediaDispatcher.implementedOperations;
    injectedRuntimeRouteInventory = assertRuntimeRouteInventoryMatchesOperationIds({
      inventory: mediaDispatcher.runtimeRouteInventory,
      operationIds: injectedOperations,
      runtimeOperations
    });
  }
  const completeWithoutDiscovery = Object.freeze([...implementedOperations, ...injectedOperations]);
  const includeDiscovery = semanticDiscovery !== null;
  const includeSourceDiscovery = sourceDiscovery !== null;
  const discoveryDocument = semanticDiscovery;
  const catalogRuntimeRouteInventory = deriveRuntimeRouteInventory([
    ...implementedOperations,
    ...(includeDiscovery ? ['getSemanticDiscovery'] : []),
    ...(includeSourceDiscovery ? [SOURCE_DISCOVERY_OPERATION_ID] : [])
  ], runtimeOperations);
  const completeOperations = Object.freeze(includeDiscovery
    ? [...completeWithoutDiscovery, 'getSemanticDiscovery', ...(includeSourceDiscovery ? [SOURCE_DISCOVERY_OPERATION_ID] : [])]
    : [...completeWithoutDiscovery, ...(includeSourceDiscovery ? [SOURCE_DISCOVERY_OPERATION_ID] : [])]);
  const runtimeRouteInventory = assertRuntimeRouteInventory([
    ...deriveRuntimeRouteInventory(implementedOperations, runtimeOperations),
    ...injectedRuntimeRouteInventory,
    ...(includeDiscovery ? deriveRuntimeRouteInventory(['getSemanticDiscovery'], runtimeOperations) : []),
    ...(includeSourceDiscovery ? deriveRuntimeRouteInventory([SOURCE_DISCOVERY_OPERATION_ID], runtimeOperations) : [])
  ]);
  assertRuntimeRouteInventoryMatchesOperationIds({ inventory: runtimeRouteInventory, operationIds: completeOperations, runtimeOperations });
  if (includeSourceDiscovery) assertSourceHandlerRoutesMatchRuntime({ runtimeRouteInventory });
  let nextRequestId = 1;

  return Object.freeze({
    implementedOperations: completeOperations,
    runtimeRouteInventory,
    dispatch({ listener, method, url, body = undefined, requestId = undefined, requestError = undefined }) {
      if (mediaDispatcher?.canHandle({ listener, method, url })) {
        return mediaDispatcher.dispatch({ listener, method, url, body, requestId, requestError });
      }
      const inferredOperationId = inferOperation(catalogRuntimeRouteInventory, listener, method, url, apiPublicPath);
      const semanticRequest = isSemanticOperation(inferredOperationId);
      const internalRequestId = !semanticRequest && listener === 'internal' && body && typeof body === 'object' ? body.request_id : undefined;
      const requiresRequestId = listener === 'public' && REQUIRED_REQUEST_ID_OPERATIONS.has(inferredOperationId);
      const resolvedRequestId = requestId ?? internalRequestId ?? (requiresRequestId ? undefined : `step06-${nextRequestId++}`);
      const canonicalMethod = canonicalHttpMethod(method);
      let selectedOperationId = null;
      try {
        if (requiresRequestId && requestId === undefined) {
          throw new ApplicationError('VALIDATION_ERROR', 'x-request-id header is required for asynchronous writes');
        }
        assertRequestId(resolvedRequestId);
        if (requestError) {
          const operationId = inferOperation(catalogRuntimeRouteInventory, listener, method, url, apiPublicPath);
          if (!operationId) return Object.freeze({ status: 404, body: { ok: false, request_id: resolvedRequestId, error: { code: 'NOT_FOUND', message: 'not found' } } });
          return withOperationId(failureResponse(errorMapper, operationId, requestError, resolvedRequestId, onUncertainResponse), operationId);
        }
        if (!semanticRequest && internalRequestId !== undefined && internalRequestId !== resolvedRequestId) {
          throw new ApplicationError('VALIDATION_ERROR', 'internal request_id must match the HTTP request_id');
        }
        const parsed = new URL(url, 'http://noobai.local');
        const emptySourceInstancePath = listener === 'internal'
          && canonicalMethod === 'GET'
          && parsed.pathname === '/internal/comfyui-source/instances/';
        const emptySourceTemplateBundlePath = listener === 'internal'
          && canonicalMethod === 'GET'
          && parsed.pathname === '/internal/comfyui-source/templates//bundle';
        const runtimeRoute = matchRuntimeRoute({ inventory: catalogRuntimeRouteInventory, listener, method, url, apiPublicPath })
          ?? (emptySourceInstancePath ? Object.freeze({ route: Object.freeze({ operationId: SOURCE_INSTANCE_OPERATION_ID }) }) : null);
        const sourceRoute = runtimeRoute
          ?? (emptySourceTemplateBundlePath ? Object.freeze({ route: Object.freeze({ operationId: SOURCE_TEMPLATE_BUNDLE_OPERATION_ID }) }) : null);
        if (!sourceRoute) {
          return Object.freeze({ status: 404, body: { ok: false, request_id: resolvedRequestId, error: { code: 'NOT_FOUND', message: 'not found' } } });
        }
        if (listener === 'public' && (parsed.pathname === '/internal/semantic' || parsed.pathname.startsWith('/internal/semantic/'))) {
          return Object.freeze({ status: 404, body: { ok: false, request_id: resolvedRequestId, error: { code: 'NOT_FOUND', message: 'not found' } } });
        }
        const route = listener === 'public'
          ? routePublic(canonicalMethod, parsed.pathname, parsed.searchParams, body, resolvedRequestId, service, apiPublicPath)
          : listener === 'internal'
          ? routeInternal(canonicalMethod, parsed.pathname, body, service, discoveryDocument, sourceDiscovery)
            : null;
        if (!route) {
          return withOperationId(
            Object.freeze({ status: 404, body: { ok: false, ...(isSemanticOperation(sourceRoute.route.operationId) ? {} : { request_id: resolvedRequestId }), error: { code: 'NOT_FOUND', message: 'not found' } } }),
            inferOperation(catalogRuntimeRouteInventory, listener, method, url, apiPublicPath)
          );
        }
        const [operationId, status, invoke] = route.length === 3 ? route : [route[0], 200, route[1]];
        if (operationId !== sourceRoute.route.operationId) throw new Error(`runtime route inventory selected ${sourceRoute.route.operationId} but dispatcher selected ${operationId}`);
        selectedOperationId = operationId;
        if (['createBaseModel', 'updateBaseModel', 'deleteBaseModel', 'createModel', 'updateModel', 'deleteModel', 'createLora', 'updateLora', 'deleteLora', 'createArtistPromptString', 'updateArtistPromptString', 'deleteArtistPromptString', 'createComfyuiInstance', 'updateComfyuiInstance', 'deleteComfyuiInstance', 'validateComfyuiInstance', 'createComfyuiTemplate', 'updateComfyuiTemplate', 'deleteComfyuiTemplate'].includes(operationId) && !authorizeWrite()) {
          throw new ApplicationError('WRITE_FORBIDDEN', 'write access is forbidden');
        }
        const data = invoke();
        if (data && typeof data.then === 'function') {
          return data.then((value) => operationId === 'getSemanticDiscovery' || operationId === SOURCE_DISCOVERY_OPERATION_ID || isCatalogOperation(operationId) || isSourceOperation(operationId)
            ? withOperationId(Object.freeze({ status, body: isSourceOperation(operationId) ? sourceSuccessBody(value) : value }), operationId)
            : withOperationId(success(successStatus(operationId, status, value), isSemanticOperation(operationId) ? undefined : resolvedRequestId, value), operationId))
            .catch((error) => withOperationId(failureResponse(errorMapper, operationId, error, resolvedRequestId, onUncertainResponse), operationId));
        }
        return operationId === 'getSemanticDiscovery' || operationId === SOURCE_DISCOVERY_OPERATION_ID || isCatalogOperation(operationId) || isSourceOperation(operationId)
          ? withOperationId(Object.freeze({ status, body: isSourceOperation(operationId) ? sourceSuccessBody(data) : data }), operationId)
          : withOperationId(success(successStatus(operationId, status, data), isSemanticOperation(operationId) ? undefined : resolvedRequestId, data), operationId);
      } catch (error) {
        const operationId = selectedOperationId ?? inferOperation(catalogRuntimeRouteInventory, listener, method, url, apiPublicPath);
        if (!operationId) {
          return Object.freeze({ status: 404, body: { ok: false, request_id: resolvedRequestId, error: { code: 'NOT_FOUND', message: 'not found' } } });
        }
        return withOperationId(failureResponse(errorMapper, operationId, error, resolvedRequestId, onUncertainResponse), operationId);
      }
    }
  });
}

function inferOperation(inventory, listener, method, url, apiPublicPath) {
  return matchRuntimeRoute({ inventory, listener, method, url, apiPublicPath })?.route.operationId ?? null;
}

async function readRequestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST_BODY_BYTES) throw new ApplicationError('UPLOAD_TOO_LARGE', 'request body exceeds the configured upload limit');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const bytes = Buffer.concat(chunks);
  const contentType = request.headers['content-type'];
  if (typeof contentType === 'string' && contentType.toLocaleLowerCase('und').startsWith('multipart/form-data')) {
    return parseMultipartFormData(bytes, contentType);
  }
  try {
    return parseJsonRequestBody(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) throw error;
    throw new ApplicationError('VALIDATION_ERROR', 'request body must be valid JSON');
  }
}

function createNodeHandler(dispatcher, listener) {
  return async (request, response) => {
    const fallbackRequestId = request.headers['x-request-id'];
    let result;
    try {
      result = await dispatcher.dispatch({
        listener,
        method: request.method,
        url: request.url,
        body: await readRequestBody(request),
        requestId: typeof fallbackRequestId === 'string' ? fallbackRequestId : undefined
      });
    } catch (error) {
      result = await dispatcher.dispatch({ listener, method: request.method, url: request.url, requestError: error, requestId: typeof fallbackRequestId === 'string' ? fallbackRequestId : undefined });
    }
    registerResponseFinishCallback(response, result);
    if (result.binary) {
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }
    response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(result.body));
  };
}

export async function startCatalogHttpListeners({ dispatcher, config }) {
  if (config?.listeners?.internal?.host !== '127.0.0.1') {
    throw new Error('internal catalog listener must bind 127.0.0.1');
  }
  const publicServer = createServer(createNodeHandler(dispatcher, 'public'));
  const internalServer = createServer(createNodeHandler(dispatcher, 'internal'));
  const listen = (server, listener) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listener.port, listener.host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
  const [publicAddress, internalAddress] = await Promise.all([
    listen(publicServer, config.listeners.public),
    listen(internalServer, config.listeners.internal)
  ]);
  return Object.freeze({
    publicAddress,
    internalAddress,
    async close() {
      await Promise.all([publicServer.close(), internalServer.close()]);
    }
  });
}
