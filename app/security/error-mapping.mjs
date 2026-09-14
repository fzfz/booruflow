import { loadSystemHttpContracts } from '../contracts/system-http-contracts.mjs';
import { InputValidationError } from './input-validation.mjs';
import { projectComfyuiTemplateWorkflowFormatDetails } from './comfyui-template-workflow-format.mjs';
import { TRANSACTION_STATE, hasTransactionState } from '../transaction-state.mjs';
import { CATALOG_ERROR_MESSAGES, isCatalogOperation } from '../contracts/catalog-contract.mjs';
import { SOURCE_ERROR_MESSAGES, isSourceOperation } from '../contracts/source-contract.mjs';

export class ApplicationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
  }
}

function isSqliteBusy(error) {
  return /(?:SQLITE_BUSY|database is locked|database is busy)/iu.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

export function createErrorMapper(repositoryRoot) {
  const contracts = loadSystemHttpContracts(repositoryRoot);
  const openapi = contracts.openapi;
  const operationIds = new Set(openapi.operations.map((operation) => operation.operationId));
  const catalog = contracts.errorCatalog.errors;

  function assertKnownCode(operationId, code) {
    if (!operationIds.has(operationId)) throw new Error(`operation is absent from authoritative OpenAPI: ${operationId}`);
    const definition = catalog[code];
    if (!definition || !definition.operationIds.includes(operationId)) {
      throw new Error(`error ${code} is absent from authoritative error catalog for ${operationId}`);
    }
    return definition;
  }

  return Object.freeze({
    toApplicationError(error, operationId = undefined) {
      if (hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN)) {
        return new ApplicationError('INTERNAL_ERROR', 'internal service error');
      }
      if (error instanceof ApplicationError) return error;
      if (error instanceof InputValidationError) return new ApplicationError('VALIDATION_ERROR', error.message);
      if (isSqliteBusy(error)) {
        if (isCatalogOperation(operationId)) return new ApplicationError('CATALOG_DATABASE_BUSY', CATALOG_ERROR_MESSAGES.CATALOG_DATABASE_BUSY);
        if (isSourceOperation(operationId)) return new ApplicationError('SOURCE_DATABASE_BUSY', SOURCE_ERROR_MESSAGES.SOURCE_DATABASE_BUSY);
        return new ApplicationError(operationId?.includes('Semantic') ? 'SQLITE_BUSY' : 'DATABASE_BUSY', 'database is busy');
      }
      if (isCatalogOperation(operationId)) return new ApplicationError('CATALOG_INTERNAL_ERROR', CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR);
      if (isSourceOperation(operationId)) return new ApplicationError('SOURCE_INTERNAL_ERROR', SOURCE_ERROR_MESSAGES.SOURCE_INTERNAL_ERROR);
      return new ApplicationError('INTERNAL_ERROR', 'internal service error');
    },
    toResponse(operationId, error, requestId) {
      const applicationError = this.toApplicationError(error, operationId);
      const definition = assertKnownCode(operationId, applicationError.code);
      const source = isSourceOperation(operationId);
      const errorBody = {
        code: applicationError.code,
        message: isCatalogOperation(operationId)
          ? CATALOG_ERROR_MESSAGES[applicationError.code] ?? CATALOG_ERROR_MESSAGES.CATALOG_INTERNAL_ERROR
          : source
            ? SOURCE_ERROR_MESSAGES[applicationError.code] ?? SOURCE_ERROR_MESSAGES.SOURCE_INTERNAL_ERROR
          : applicationError.message
      };
      const details = applicationError.code === 'VALIDATION_ERROR'
        ? projectComfyuiTemplateWorkflowFormatDetails(operationId, applicationError.details, contracts.errorCatalog)
        : undefined;
      if (details !== undefined) errorBody.details = details;
      const body = isCatalogOperation(operationId) || source
        ? { error: errorBody }
        : requestId === undefined
          ? { ok: false, error: errorBody }
          : { ok: false, request_id: requestId, error: errorBody };
      return Object.freeze({
        status: definition.http_status,
        body: Object.freeze(body)
      });
    },
    assertKnownCode
  });
}
