import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, normalize, relative, resolve } from 'node:path';

import { markDatabaseConnectionUnusable, openCatalogDatabase } from '../catalog/database.mjs';
import { createCatalogRepository } from '../catalog/catalog-repository.mjs';
import { createCatalogService } from '../catalog/catalog-service.mjs';
import { createCatalogManagementService } from '../catalog/catalog-management-service.mjs';
import { createCatalogManagementVectorPreparation } from '../catalog/catalog-management-vector.mjs';
import { createBaseModelRepository } from '../generation-resources/base-model-repository.mjs';
import { createBaseModelService } from '../generation-resources/base-model-service.mjs';
import { createModelRepository } from '../generation-resources/model-repository.mjs';
import { createModelService } from '../generation-resources/model-service.mjs';
import { createLoraRepository } from '../generation-resources/lora-repository.mjs';
import { createLoraService } from '../generation-resources/lora-service.mjs';
import { createArtistPromptStringRepository } from '../generation-resources/artist-prompt-string-repository.mjs';
import { createArtistPromptStringService } from '../generation-resources/artist-prompt-string-service.mjs';
import { createComfyuiInstanceRepository } from '../generation-resources/comfyui-instance-repository.mjs';
import { createComfyuiInstanceService } from '../generation-resources/comfyui-instance-service.mjs';
import { createComfyuiSourceService } from '../generation-resources/comfyui-source-service.mjs';
import { createComfyuiTemplateRepository } from '../generation-resources/comfyui-template-repository.mjs';
import { createComfyuiTemplateService } from '../generation-resources/comfyui-template-service.mjs';
import { createComfyuiCredentialCrypto } from '../generation-resources/comfyui-credential-crypto.mjs';
import { registerResponseFinishCallback, createCatalogHttpDispatcher } from '../http/catalog-http.mjs';
import { DuplicateJsonKeyError, MAX_REQUEST_BODY_BYTES, parseJsonRequestBody } from '../http/json-request-body.mjs';
import { createMediaHttpDispatcher, parseMultipartFormData } from '../http/media-http.mjs';
import { publicPrefixPath } from '../http/public-path.mjs';
import { assertSemanticDiscoveryMatchesRuntime, buildSemanticDiscovery } from '../http/semantic-discovery.mjs';
import { buildSourceDiscovery } from '../http/source-discovery.mjs';
import { resolveRepositoryContractFile } from '../contracts/repository-contract-paths.mjs';
import { createStaticMediaDispatcher } from '../http/static-media.mjs';
import { createMediaStorage } from '../media/media-storage.mjs';
import { createFileCleanupQueue } from '../maintenance/file-cleanup-queue.mjs';
import { createMaintenanceService } from '../maintenance/maintenance-service.mjs';
import { ApplicationError, createErrorMapper } from '../security/error-mapping.mjs';
import { createConfiguredVectorModelClient, loadVectorModelConfiguration } from '../vector/model-client.mjs';
import { createCharacterSemanticService } from '../vector/character-semantic.mjs';
import { createStyleSemanticService } from '../vector/style-semantic.mjs';
import { createPromptTermSemanticService } from '../vector/prompt-term-semantic.mjs';
import { createWorkSemanticService } from '../vector/work-semantic.mjs';
import { createGenerationLoraSemanticService, createGenerationLoraVectorMaintenance } from '../vector/generation-lora-semantic.mjs';
import { createArtistPromptStringSemanticService, createArtistPromptStringVectorMaintenance } from '../vector/artist-prompt-string-semantic.mjs';
import { PROMPT_TERM_CATEGORIES } from '../prompt-terms/prompt-term-categories.mjs';
import { createPromptTermManagementRepository } from '../prompt-terms/prompt-term-management-repository.mjs';
import { createPromptTermManagementService } from '../prompt-terms/prompt-term-management-service.mjs';
import { createPromptTermVectorMaintenance } from '../vector/prompt-term-semantic.mjs';
import { loadConfig, REPOSITORY_ROOT, resolveProductionDataPaths } from '../config/load-config.mjs';
import { buildRuntimeOperations } from '../http/runtime-operations.mjs';
import { createWebRenderer } from '../web/web-renderer.mjs';
import { REQUEST_LIFECYCLE_EVENTS, createRequestLifecycleLogger } from '../diagnostics/request-lifecycle-log.mjs';
import { MANAGEMENT_PAGE_PATHS, RUNTIME_HTML_FILES } from '../web/assets/management-navigation-config.mjs';

const MIME_TYPES = Object.freeze({ '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' });

function isInside(root, file) {
  const path = relative(root, resolve(file));
  return path !== '' && !path.startsWith('..') && !path.includes('../');
}

async function readBody(request) {
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
  if (typeof contentType === 'string' && contentType.toLocaleLowerCase('und').startsWith('multipart/form-data')) return parseMultipartFormData(bytes, contentType);
  try { return parseJsonRequestBody(bytes.toString('utf8')); }
  catch (error) {
    if (error instanceof DuplicateJsonKeyError) throw error;
    return undefined;
  }
}

function writeJson(response, result, elapsedMilliseconds) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'server-timing': `app;dur=${elapsedMilliseconds.toFixed(3)}`
  };
  if (process.env.NOOBAI_TEST_OPERATION_ID_HEADER === '1' && typeof result.operationId === 'string') {
    headers['x-noobai-operation-id'] = result.operationId;
  }
  response.writeHead(result.status, headers);
  response.end(JSON.stringify(result.body));
}

function listen(server, listener) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(listener.port, listener.host, () => {
      server.off('error', reject);
      resolvePromise(server.address());
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

function cloneInternalRequestBody(body) {
  return body === undefined ? undefined : structuredClone(body);
}

function notifyInternalRequestObserver(onInternalRequest, { method, url, body } = {}) {
  if (onInternalRequest === undefined) return;
  onInternalRequest(Object.freeze({ method, url, body: cloneInternalRequestBody(body) }));
}

export function resolveSemanticOpenapiPath({ repositoryRoot = REPOSITORY_ROOT, semanticOpenapiPath = null } = {}) {
  if (semanticOpenapiPath !== null && (typeof semanticOpenapiPath !== 'string' || semanticOpenapiPath.length === 0)) {
    throw new TypeError('semanticOpenapiPath must be null or a non-empty string');
  }
  const repositorySource = resolveRepositoryContractFile({ repositoryRoot, relativePath: 'schema/api/openapi.yaml', label: 'semantic OpenAPI contract' });
  if (semanticOpenapiPath === null) return repositorySource.path;
  const requestedPath = resolve(semanticOpenapiPath);
  if (requestedPath !== repositorySource.path) {
    throw new Error(`semanticOpenapiPath must resolve to the repository contract path: ${repositorySource.path}`);
  }
  return requestedPath;
}

function orderRuntimeOperationsForSemanticDiscovery(runtimeOperations, semanticDiscovery) {
  let semanticIndex = 0;
  const semanticOrder = new Map(Object.values(semanticDiscovery.paths ?? {}).flatMap((pathItem) => Object.values(pathItem).map((operation) => [operation.operationId, semanticIndex++])));
  const sourceOrder = new Map(runtimeOperations.map((operation, index) => [operation.operationId, index]));
  return Object.freeze([...runtimeOperations].sort((left, right) => {
    const leftSemantic = semanticOrder.get(left.operationId);
    const rightSemantic = semanticOrder.get(right.operationId);
    if (leftSemantic === undefined && rightSemantic === undefined) return sourceOrder.get(left.operationId) - sourceOrder.get(right.operationId);
    if (leftSemantic === undefined) return -1;
    if (rightSemantic === undefined) return 1;
    return leftSemantic - rightSemantic;
  }));
}

export async function startLocalApplication({ repositoryRoot = REPOSITORY_ROOT, dataPaths = null, listenerMode = 'all', semanticOpenapiPath = null, vectorConfiguration: injectedVectorConfiguration = null, vectorModelClient: injectedVectorModelClient = null, baseModelServiceDecorator = null, databaseFactory = null, authorizeWrite = () => true, onStarted = console.log, onInternalRequest = undefined } = {}) {
  if (typeof authorizeWrite !== 'function') throw new TypeError('authorizeWrite must be a function');
  if (onInternalRequest !== undefined && typeof onInternalRequest !== 'function') throw new TypeError('onInternalRequest must be a function');
  if (databaseFactory !== null && typeof databaseFactory !== 'function') throw new TypeError('databaseFactory must be a function or null');
  if (!['all', 'internal-only'].includes(listenerMode)) throw new TypeError('listenerMode must be all or internal-only');
  const config = loadConfig();
  const resolvedSemanticOpenapiPath = resolveSemanticOpenapiPath({ repositoryRoot, semanticOpenapiPath });
  const mediaOrigin = `http://127.0.0.1:${config.listeners.public.port}`;
  const semanticDiscovery = buildSemanticDiscovery({ repositoryRoot, openapiPath: resolvedSemanticOpenapiPath, mediaOrigin });
  const sourceDiscovery = buildSourceDiscovery({ repositoryRoot, openapiPath: resolvedSemanticOpenapiPath });
  const runtimeOperations = orderRuntimeOperationsForSemanticDiscovery(buildRuntimeOperations(repositoryRoot), semanticDiscovery);
  const paths = dataPaths ?? resolveProductionDataPaths(config, { repositoryRoot });
  const dataRoot = resolve(paths.dataRoot);
  const databasePath = resolve(paths.databasePath);
  const mediaRoot = resolve(paths.mediaRoot);
  if (!isInside(dataRoot, databasePath) || !isInside(dataRoot, mediaRoot)) throw new Error('application data paths must remain inside the configured data root');
  await mkdir(dataRoot, { recursive: true });
  const logRoot = resolve(dataRoot, config.logging.directory);
  if (!isInside(dataRoot, logRoot)) throw new Error('logging directory must remain inside the configured data root');
  const requestLifecycleLogFile = resolve(logRoot, 'request-lifecycle.jsonl');
  const requestTracer = createRequestLifecycleLogger({
    logFile: requestLifecycleLogFile,
    level: config.logging.level,
    maxFileBytes: config.logging.max_file_bytes,
    maxArchives: config.logging.max_archives
  });
  await requestTracer.initialize();
  const database = databaseFactory === null
    ? openCatalogDatabase({ databasePath, mediaRoot, repositoryRoot })
    : databaseFactory({ databasePath, mediaRoot, repositoryRoot });
  if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function' || typeof database.close !== 'function') {
    throw new TypeError('databaseFactory must return a catalog database connection');
  }
  const mediaStorage = createMediaStorage({
    mediaRoot,
    maxFileBytes: config.uploads.max_file_bytes,
    maxFiles: config.uploads.max_files_per_request,
    allowedMediaTypes: config.uploads.allowed_media_types
  });
  const cleanupQueue = createFileCleanupQueue({ queuePath: resolve(dataRoot, 'file-cleanup.json'), mediaRoot, repositoryRoot });
  const mediaService = createMaintenanceService({ database, mediaStorage, cleanupQueue });
  const catalogRepository = createCatalogRepository(database);
  const baseModelRepository = createBaseModelRepository(database);
  const modelRepository = createModelRepository(database);
  const loraRepository = createLoraRepository(database);
  const artistPromptStringRepository = createArtistPromptStringRepository(database);
  const promptTermManagementRepository = createPromptTermManagementRepository(database);
  const comfyuiInstanceRepository = createComfyuiInstanceRepository(database);
  const comfyuiTemplateRepository = createComfyuiTemplateRepository(database);
  const vectorConfiguration = injectedVectorConfiguration ?? loadVectorModelConfiguration(repositoryRoot);
  const vectorModelClient = injectedVectorModelClient ?? createConfiguredVectorModelClient({ repositoryRoot, configuration: vectorConfiguration });
  const generationLoraVectorMaintenance = createGenerationLoraVectorMaintenance({
    database,
    configuration: vectorConfiguration,
    modelClient: vectorModelClient
  });
  const artistPromptStringVectorMaintenance = createArtistPromptStringVectorMaintenance({
    database,
    configuration: vectorConfiguration,
    modelClient: vectorModelClient
  });
  const generationLoraSemanticService = createGenerationLoraSemanticService({ database, configuration: vectorConfiguration, modelClient: vectorModelClient });
  const artistPromptStringSemanticService = createArtistPromptStringSemanticService({ database, configuration: vectorConfiguration, modelClient: vectorModelClient });
  const workSemanticService = createWorkSemanticService({
    database,
    configuration: vectorConfiguration,
    modelClient: vectorModelClient
  });
  const characterSemanticService = createCharacterSemanticService({ database, configuration: vectorConfiguration, modelClient: vectorModelClient });
  const styleSemanticService = createStyleSemanticService({ database, configuration: vectorConfiguration, modelClient: vectorModelClient });
  const promptTermSemanticService = createPromptTermSemanticService({ database, configuration: vectorConfiguration, modelClient: vectorModelClient });
  const promptTermVectorMaintenance = createPromptTermVectorMaintenance({ database, configuration: vectorConfiguration, modelClient: vectorModelClient });
  const catalogManagementVectorPreparation = createCatalogManagementVectorPreparation({ configuration: vectorConfiguration, modelClient: vectorModelClient });
  const catalogManagementService = createCatalogManagementService({ database, repository: catalogRepository, vectorPreparation: catalogManagementVectorPreparation });
  const catalogService = createCatalogService({ database, repository: catalogRepository, repositoryRoot, mediaOrigin, mediaPublicPrefix: config.runtime.media_public_prefix, generationLoraSemanticService, workSemanticService, characterSemanticService, styleSemanticService, promptTermSemanticService, artistPromptStringSemanticService });
  if (baseModelServiceDecorator !== null && typeof baseModelServiceDecorator !== 'function') throw new TypeError('baseModelServiceDecorator must be a function');
  const createdBaseModelService = createBaseModelService({ database, repository: baseModelRepository, mediaStorage, cleanupQueue });
  const baseModelService = baseModelServiceDecorator === null ? createdBaseModelService : baseModelServiceDecorator(createdBaseModelService);
  if (!baseModelService || ['list', 'create', 'get', 'update', 'getDeleteImpact', 'delete'].some((name) => typeof baseModelService[name] !== 'function')) {
    throw new TypeError('baseModelServiceDecorator must return a complete base model service');
  }
  const modelService = createModelService({ database, repository: modelRepository, mediaStorage, cleanupQueue });
  const loraService = createLoraService({ database, repository: loraRepository, mediaStorage, cleanupQueue, vectorMaintenance: generationLoraVectorMaintenance });
  const artistPromptStringService = createArtistPromptStringService({
    database,
    repository: artistPromptStringRepository,
    mediaStorage,
    cleanupQueue,
    vectorMaintenance: artistPromptStringVectorMaintenance
  });
  const comfyuiCredentialCrypto = createComfyuiCredentialCrypto({ encryptionKey: config.comfyui.credential_encryption_key });
  const comfyuiInstanceService = createComfyuiInstanceService({ database, repository: comfyuiInstanceRepository, crypto: comfyuiCredentialCrypto });
  const comfyuiSourceService = createComfyuiSourceService({ repository: comfyuiInstanceRepository, templateRepository: comfyuiTemplateRepository, crypto: comfyuiCredentialCrypto, repositoryRoot });
  const comfyuiTemplateService = createComfyuiTemplateService({ database, repository: comfyuiTemplateRepository, mediaStorage, cleanupQueue });
  const promptTermManagementService = createPromptTermManagementService({
    database,
    repository: promptTermManagementRepository,
    vectorMaintenance: promptTermVectorMaintenance
  });
  const service = Object.freeze({
    ...catalogService,
    getGenerationResourceOptions: () => config.generation_resources,
    getPromptTermOptions: () => Object.freeze({ categories: PROMPT_TERM_CATEGORIES }),
    createManageItem: catalogManagementService.create,
    updateManageItem: catalogManagementService.update,
    listPromptTerms: promptTermManagementService.list,
    createPromptTerm: promptTermManagementService.create,
    getPromptTerm: promptTermManagementService.get,
    updatePromptTerm: promptTermManagementService.update,
    deletePromptTerm: promptTermManagementService.delete,
    querySemanticGenerationLorasForCli: generationLoraSemanticService.searchSkill,
    querySemanticArtistPromptStringsForCli: artistPromptStringSemanticService.searchSkill,
    listBaseModels: baseModelService.list,
    createBaseModel: baseModelService.create,
    getBaseModel: baseModelService.get,
    updateBaseModel: baseModelService.update,
    getBaseModelDeleteImpact: baseModelService.getDeleteImpact,
    deleteBaseModel: baseModelService.delete,
    listModels: modelService.list,
    createModel: modelService.create,
    getModel: modelService.get,
    updateModel: modelService.update,
    getModelDeleteImpact: modelService.getDeleteImpact,
    deleteModel: modelService.delete,
    listLoras: loraService.list,
    createLora: loraService.create,
    getLora: loraService.get,
    updateLora: loraService.update,
    getLoraDeleteImpact: loraService.getDeleteImpact,
    deleteLora: loraService.delete,
    listArtistPromptStrings: artistPromptStringService.list,
    createArtistPromptString: artistPromptStringService.create,
    getArtistPromptString: artistPromptStringService.get,
    updateArtistPromptString: artistPromptStringService.update,
    getArtistPromptStringDeleteImpact: artistPromptStringService.getDeleteImpact,
    deleteArtistPromptString: artistPromptStringService.delete,
    listComfyuiInstances: comfyuiInstanceService.list,
    createComfyuiInstance: comfyuiInstanceService.create,
    getComfyuiInstance: comfyuiInstanceService.get,
    updateComfyuiInstance: comfyuiInstanceService.update,
    deleteComfyuiInstance: comfyuiInstanceService.delete,
    validateComfyuiInstance: comfyuiInstanceService.validate,
    getComfyuiInstanceDeleteImpact: comfyuiInstanceService.getDeleteImpact,
    getComfyuiInstanceSourceForHost: comfyuiSourceService.getComfyuiInstanceSourceForHost,
    getComfyuiTemplateBundleForHost: comfyuiSourceService.getComfyuiTemplateBundleForHost,
    listComfyuiTemplates: comfyuiTemplateService.list,
    createComfyuiTemplate: comfyuiTemplateService.create,
    getComfyuiTemplate: comfyuiTemplateService.get,
    updateComfyuiTemplate: comfyuiTemplateService.update,
    getComfyuiTemplateDeleteImpact: comfyuiTemplateService.getDeleteImpact,
    deleteComfyuiTemplate: comfyuiTemplateService.delete
  });
  const errorMapper = createErrorMapper(repositoryRoot);
  const apiPublicPath = publicPrefixPath(config.runtime.api_public_prefix);
  const mediaPublicPath = publicPrefixPath(config.runtime.media_public_prefix);
  const mediaDispatcher = createMediaHttpDispatcher({ service: mediaService, errorMapper, authorizeWrite, auditError: () => {}, apiPublicPath, runtimeOperations });
  let closeApplication = null;
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper,
    authorizeWrite,
    mediaDispatcher,
    apiPublicPath,
    semanticDiscovery,
    sourceDiscovery,
    runtimeOperations,
    onUncertainResponse: () => closeApplication?.()
  });
  try {
    assertSemanticDiscoveryMatchesRuntime(semanticDiscovery, dispatcher.runtimeRouteInventory);
  } catch (error) {
    database.close();
    throw error;
  }
  const webRoot = resolve(repositoryRoot, 'app/web');
  const packageDocument = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  if (typeof packageDocument.version !== 'string' || packageDocument.version.length === 0) throw new Error('package.json version is required');
  const webRenderer = createWebRenderer({ webRoot, config, runtimeTemplateFileNames: RUNTIME_HTML_FILES, applicationVersion: packageDocument.version });
  const staticMediaDispatcher = createStaticMediaDispatcher({ mediaRoot, publicPath: mediaPublicPath });
  function createHandler(listener) {
    return async (request, response) => {
      const startedAt = performance.now();
      const parsed = new URL(request.url, 'http://localhost');
      const managementPage = MANAGEMENT_PAGE_PATHS[parsed.pathname];
      if (listener === 'public' && staticMediaDispatcher.canHandle({ listener, method: request.method, url: request.url })) {
        const result = staticMediaDispatcher.dispatch({ listener, method: request.method, url: request.url });
        response.writeHead(result.status, result.headers);
        response.end(request.method === 'HEAD' ? undefined : result.body);
        return;
      }
      if (listener === 'public' && (parsed.pathname === '/' || managementPage !== undefined || parsed.pathname.startsWith('/app/web/'))) {
        const relativePath = parsed.pathname === '/'
          ? 'management-home.html'
          : managementPage !== undefined
            ? managementPage
          : parsed.pathname.startsWith('/app/web/')
            ? parsed.pathname.slice('/app/web/'.length)
            : parsed.pathname.replace(/^\//u, '');
        let decodedPath;
        try { decodedPath = decodeURIComponent(relativePath); } catch { response.writeHead(404); response.end(); return; }
        if (decodedPath.includes('\\') || decodedPath.includes(String.fromCharCode(0)) || decodedPath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
          response.writeHead(404); response.end(); return;
        }
        const filePath = resolve(webRoot, normalize(decodedPath));
        if (!isInside(webRoot, filePath)) { response.writeHead(404); response.end(); return; }
        try {
          const isHtml = extname(filePath) === '.html';
          const content = isHtml && webRenderer.isRuntimeTemplate(decodedPath)
            ? webRenderer.render(decodedPath)
            : readFileSync(filePath);
          const headers = { 'content-type': isHtml ? webRenderer.contentType : MIME_TYPES[extname(filePath)] ?? 'application/octet-stream', 'content-length': String(content.length) };
          response.writeHead(200, headers);
          response.end(request.method === 'HEAD' ? undefined : content);
        } catch { response.writeHead(404); response.end(); }
        return;
      }
      const requestId = request.headers['x-request-id'];
      const traceRequestId = typeof requestId === 'string' ? requestId : null;
      const tracePath = parsed.pathname;
      await requestTracer.record({
        event: REQUEST_LIFECYCLE_EVENTS.HTTP_REQUEST_RECEIVED,
        request_id: traceRequestId,
        listener,
        method: request.method,
        path: tracePath
      });
      let body;
      let requestError;
      try { body = await readBody(request); } catch (error) { requestError = error; }
      if (listener === 'internal' && requestError === undefined) {
        notifyInternalRequestObserver(onInternalRequest, { method: request.method, url: request.url, body });
      }
      const result = await dispatcher.dispatch({ listener, method: request.method, url: request.url, body, requestError, requestId: typeof requestId === 'string' ? requestId : undefined });
      await requestTracer.record({
        event: REQUEST_LIFECYCLE_EVENTS.HTTP_RESPONSE_COMPLETED,
        request_id: result.body?.request_id ?? traceRequestId,
        listener,
        method: request.method,
        path: tracePath,
        operation_id: result.operationId,
        status: result.status,
        error_code: result.body?.ok === false ? result.body?.error?.code : undefined,
        duration_ms: Number((performance.now() - startedAt).toFixed(3))
      });
      registerResponseFinishCallback(response, result);
      if (result.binary) {
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
      writeJson(response, result, performance.now() - startedAt);
    };
  }
  const publicServer = listenerMode === 'all' ? createServer(createHandler('public')) : null;
  const internalServer = createServer(createHandler('internal'));
  let publicAddress = null;
  let internalAddress;
  try {
    internalAddress = await listen(internalServer, config.listeners.internal);
    if (listenerMode === 'all') publicAddress = await listen(publicServer, config.listeners.public);
  } catch (error) {
    await Promise.all([closeServer(publicServer), closeServer(internalServer)]);
    database.close();
    throw error;
  }
  if (publicAddress) onStarted(`应用已启动：http://127.0.0.1:${publicAddress.port}/`);
  onStarted(`内部语义接口：http://127.0.0.1:${internalAddress.port}/internal/semantic`);
  let closePromise = null;
  closeApplication = () => {
    if (closePromise !== null) return closePromise;
    markDatabaseConnectionUnusable(database);
    closePromise = (async () => {
      await Promise.all([closeServer(publicServer), closeServer(internalServer)]);
      database.close();
    })();
    return closePromise;
  };
  return Object.freeze({
    publicAddress,
    internalAddress,
    semanticDiscovery,
    sourceDiscovery,
    requestLifecycleLogFile,
    close: closeApplication
  });
}
