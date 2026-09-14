import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, assertRequestId } from '../security/input-validation.mjs';
import { stripPublicPrefix } from './public-path.mjs';
import { RUNTIME_OPERATIONS, canonicalHttpMethod, deriveRuntimeRouteInventory, matchRuntimeRoute } from './runtime-operations.mjs';

const SERVICE_METHOD_FOR_OPERATION = Object.freeze({
  listImages: 'listImages',
  uploadImages: 'uploadImages',
  reorderImages: 'reorderImages',
  setCover: 'setCover',
  deleteImage: 'deleteImage',
  batchDelete: 'batchDelete'
});
const WRITE_OPERATIONS = new Set(['uploadImages', 'reorderImages', 'setCover', 'deleteImage', 'batchDelete']);

function deriveMediaImplementedOperations(service) {
  return Object.freeze(Object.keys(SERVICE_METHOD_FOR_OPERATION)
    .filter((operationId) => typeof service?.[SERVICE_METHOD_FOR_OPERATION[operationId]] === 'function'));
}

function invokeService(service, operationId, ...args) {
  return service[SERVICE_METHOD_FOR_OPERATION[operationId]](...args);
}

function success(status, requestId, data) {
  return Object.freeze({ status, body: Object.freeze({ ok: true, request_id: requestId, data }) });
}

function withOperationId(result, operationId) {
  if (typeof operationId !== 'string') return result;
  return Object.freeze(Object.defineProperty({ ...result }, 'operationId', {
    value: operationId,
    enumerable: false
  }));
}

function resolveRequestId(requestId, nextRequestId) {
  try {
    return assertRequestId(requestId);
  } catch {
    return nextRequestId();
  }
}

function auditErrorValue(error, field) {
  const value = error?.[field];
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

function requestErrorAuditRecord(requestId, operation, error) {
  return Object.freeze({
    request_id: requestId,
    operation,
    raw_error: error,
    error: Object.freeze({
      name: auditErrorValue(error, 'name'),
      code: auditErrorValue(error, 'code'),
      message: auditErrorValue(error, 'message')
    })
  });
}

function auditRequestError(auditError, record) {
  const result = auditError(record);
  if (result && typeof result.then === 'function') {
    throw new TypeError('auditError must complete synchronously');
  }
}

function retainsMappedRequestError(errorMapper, requestError) {
  return requestError instanceof ApplicationError || errorMapper.toApplicationError(requestError).code === 'DATABASE_BUSY';
}

function pathIdentifier(value, label) {
  if (!/^[1-9]\d*$/u.test(value)) throw new ApplicationError('VALIDATION_ERROR', `${label} must be a positive integer`);
  return assertIdentifier(Number(value), label);
}

function route(method, pathname, body, service, apiPublicPath) {
  const apiPathname = stripPublicPrefix(pathname, apiPublicPath);
  if (apiPathname === null) return null;
  const batchMatch = apiPathname === '/items/batch-delete';
  if (method === 'POST' && batchMatch) return ['batchDelete', () => invokeService(service, 'batchDelete', body)];
  const uploadMatch = /^\/items\/([^/]+)\/([^/]+)\/images$/u.exec(apiPathname);
  if (method === 'GET' && uploadMatch) return ['listImages', () => invokeService(service, 'listImages', uploadMatch[1], pathIdentifier(uploadMatch[2], 'owner_id'))];
  if (method === 'POST' && uploadMatch) return ['uploadImages', () => invokeService(service, 'uploadImages', uploadMatch[1], pathIdentifier(uploadMatch[2], 'owner_id'), body?.files)];
  const orderMatch = /^\/items\/([^/]+)\/([^/]+)\/images\/order$/u.exec(apiPathname);
  if (method === 'PUT' && orderMatch) return ['reorderImages', () => invokeService(service, 'reorderImages', orderMatch[1], pathIdentifier(orderMatch[2], 'owner_id'), body)];
  const coverMatch = /^\/items\/([^/]+)\/([^/]+)\/cover$/u.exec(apiPathname);
  if (method === 'PUT' && coverMatch) return ['setCover', () => invokeService(service, 'setCover', coverMatch[1], pathIdentifier(coverMatch[2], 'owner_id'), body)];
  const deleteMatch = /^\/items\/([^/]+)\/([^/]+)\/images\/([^/]+)$/u.exec(apiPathname);
  if (method === 'DELETE' && deleteMatch) return ['deleteImage', () => invokeService(service, 'deleteImage', deleteMatch[1], pathIdentifier(deleteMatch[2], 'owner_id'), pathIdentifier(deleteMatch[3], 'id'))];
  return null;
}

function inferOperation(inventory, method, url, apiPublicPath) {
  return matchRuntimeRoute({ inventory, listener: 'public', method, url, apiPublicPath })?.route.operationId ?? null;
}

export function createMediaHttpDispatcher({ service, errorMapper, authorizeWrite = () => true, auditError, apiPublicPath = '/api', runtimeOperations = RUNTIME_OPERATIONS } = {}) {
  if (!service) throw new TypeError('service is required');
  if (!errorMapper) throw new TypeError('errorMapper is required');
  if (typeof auditError !== 'function') throw new TypeError('auditError must be a function');
  if (!Array.isArray(runtimeOperations)) throw new TypeError('runtimeOperations must be an array');
  const implementedOperations = deriveMediaImplementedOperations(service);
  for (const operationId of implementedOperations) errorMapper.assertKnownCode(operationId, 'INTERNAL_ERROR');
  const runtimeRouteInventory = deriveRuntimeRouteInventory(implementedOperations, runtimeOperations);
  let nextRequestId = 1;
  return Object.freeze({
    implementedOperations,
    runtimeRouteInventory,
    canHandle({ listener, method, url }) {
      return listener === 'public' && inferOperation(runtimeRouteInventory, method, url, apiPublicPath) !== null;
    },
    dispatch({ listener, method, url, body = undefined, requestId = undefined, requestError = undefined }) {
      const resolvedRequestId = resolveRequestId(requestId, () => `step07-${nextRequestId++}`);
      const canonicalMethod = canonicalHttpMethod(method);
      const operationId = inferOperation(runtimeRouteInventory, method, url, apiPublicPath);
      let selectedOperationId = null;
      if (listener !== 'public' || !operationId) return null;
      if (requestError !== undefined) {
        auditRequestError(auditError, requestErrorAuditRecord(resolvedRequestId, operationId, requestError));
        const responseError = retainsMappedRequestError(errorMapper, requestError)
          ? requestError
          : new Error('request body read failed');
        return withOperationId(errorMapper.toResponse(operationId, responseError, resolvedRequestId), operationId);
      }
      try {
        const parsed = new URL(url, 'http://noobai.local');
        const runtimeRoute = matchRuntimeRoute({ inventory: runtimeRouteInventory, listener, method, url, apiPublicPath });
        if (!runtimeRoute) return null;
        const selected = route(canonicalMethod, parsed.pathname, body, service, apiPublicPath);
        if (!selected) return null;
        const [selectedOperation, invoke] = selected;
        if (selectedOperation !== runtimeRoute.route.operationId) throw new Error(`runtime route inventory selected ${runtimeRoute.route.operationId} but dispatcher selected ${selectedOperation}`);
        selectedOperationId = selectedOperation;
        if (WRITE_OPERATIONS.has(selectedOperation) && !authorizeWrite()) {
          throw new ApplicationError('WRITE_FORBIDDEN', 'write access is forbidden');
        }
        const data = invoke();
        const status = selectedOperation === 'uploadImages' ? 201 : 200;
        if (data && typeof data.then === 'function') {
          return data.then((value) => withOperationId(success(status, resolvedRequestId, value), selectedOperationId))
            .catch((error) => withOperationId(errorMapper.toResponse(selectedOperationId, error, resolvedRequestId), selectedOperationId));
        }
        return withOperationId(success(status, resolvedRequestId, data), selectedOperationId);
      } catch (error) {
        const responseOperationId = selectedOperationId ?? operationId;
        return withOperationId(errorMapper.toResponse(responseOperationId, error, resolvedRequestId), responseOperationId);
      }
    }
  });
}

export function parseMultipartFormData(bytes, contentType) {
  if (!Buffer.isBuffer(bytes)) throw new ApplicationError('VALIDATION_ERROR', 'multipart request must contain bytes');
  const boundaryMatch = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/iu.exec(contentType ?? '');
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/u.test(boundary)) throw new ApplicationError('VALIDATION_ERROR', 'multipart boundary is invalid');
  const delimiter = Buffer.from(`--${boundary}`, 'ascii');
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`, 'ascii');
  if (bytes.length < delimiter.length + 4 || !bytes.subarray(0, delimiter.length).equals(delimiter)) {
    throw new ApplicationError('VALIDATION_ERROR', 'multipart body has no opening boundary');
  }
  const files = [];
  let offset = delimiter.length;
  while (offset < bytes.length) {
    if (bytes.subarray(offset, offset + 2).equals(Buffer.from('--'))) {
      offset += 2;
      if (offset !== bytes.length && !bytes.subarray(offset).equals(Buffer.from('\r\n'))) throw new ApplicationError('VALIDATION_ERROR', 'multipart body has trailing data');
      break;
    }
    if (!bytes.subarray(offset, offset + 2).equals(Buffer.from('\r\n'))) throw new ApplicationError('VALIDATION_ERROR', 'multipart boundary separator is invalid');
    offset += 2;
    const headerEnd = bytes.indexOf(Buffer.from('\r\n\r\n'), offset);
    if (headerEnd === -1) throw new ApplicationError('VALIDATION_ERROR', 'multipart part headers are incomplete');
    const headers = bytes.subarray(offset, headerEnd).toString('latin1');
    const disposition = /^content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?\s*$/imu.exec(headers);
    const type = /^content-type:\s*([^\r\n]+)\s*$/imu.exec(headers);
    if (!disposition || disposition[1] !== 'files' || !disposition[2] || !type || /\r|\n/u.test(type[1])) {
      throw new ApplicationError('VALIDATION_ERROR', 'multipart body must contain only named file parts');
    }
    const next = bytes.indexOf(nextDelimiter, headerEnd + 4);
    if (next === -1) throw new ApplicationError('VALIDATION_ERROR', 'multipart part has no closing boundary');
    // The byte signature is authoritative; media storage validates it before commit.
    files.push(Object.freeze({ bytes: Buffer.from(bytes.subarray(headerEnd + 4, next)) }));
    offset = next + 2 + delimiter.length;
  }
  if (files.length === 0) throw new ApplicationError('VALIDATION_ERROR', 'multipart body must contain at least one file');
  return Object.freeze({ files: Object.freeze(files) });
}
