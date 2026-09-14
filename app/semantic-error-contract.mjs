import { loadSystemHttpContracts } from './contracts/system-http-contracts.mjs';

const SAFE_INTERNAL_ERROR_MESSAGE = 'internal service error';

export function semanticErrorContractMatches({ code, status, path, repositoryRoot } = {}) {
  const contracts = loadSystemHttpContracts(repositoryRoot);
  const operation = contracts.openapi.operations.find((candidate) => candidate.path === path && candidate.method === 'post');
  const definition = contracts.errorCatalog.errors[code];
  return typeof operation?.operationId === 'string'
    && definition?.http_status === status
    && definition.operationIds.includes(operation.operationId)
    && operation.responses.some((response) => response.status === status);
}

export function safeSemanticErrorMessage(code, message) {
  return code === 'INTERNAL_ERROR' ? SAFE_INTERNAL_ERROR_MESSAGE : message;
}
