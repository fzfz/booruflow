import { loadSystemHttpContracts } from '../contracts/system-http-contracts.mjs';

export class ServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

export function errorResponse({ operationId, requestId, error, errorCatalog = loadSystemHttpContracts().errorCatalog }) {
  const code = error instanceof ServiceError ? error.code : 'INTERNAL_ERROR';
  const definition = errorCatalog.errors[code];
  if (!definition || !definition.operationIds.includes(operationId)) {
    throw new Error(`error ${code} is not declared for ${operationId}`);
  }
  return Object.freeze({
    status: definition.http_status,
    body: Object.freeze({ ok: false, request_id: requestId, error: Object.freeze({ code, message: error.message }) })
  });
}

export function databaseErrorToServiceError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|database is busy|SQLITE_BUSY/iu.test(message)) return new ServiceError('DATABASE_BUSY', 'database is busy');
  if (/constraint failed|UNIQUE constraint failed|FOREIGN KEY constraint failed|SQLITE_CONSTRAINT/iu.test(message)) {
    return new ServiceError('INTERNAL_ERROR', 'database constraint rejected the operation');
  }
  return new ServiceError('INTERNAL_ERROR', 'catalog database operation failed');
}
