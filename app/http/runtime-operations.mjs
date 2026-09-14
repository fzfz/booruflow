import { loadSystemHttpContracts } from '../contracts/system-http-contracts.mjs';
import { joinPublicPrefix } from './public-path.mjs';

function listenerForPath(path) {
  if (path.startsWith('/api/')) return 'public';
  if (path === '/internal/semantic' || path.startsWith('/internal/semantic/')) return 'internal';
  if (path === '/internal/comfyui-source' || path.startsWith('/internal/comfyui-source/')) return 'internal';
  throw new Error(`OpenAPI operation path has no runtime listener: ${path}`);
}

function matcherForPath(path) {
  const names = [];
  const expression = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\{([A-Za-z_][A-Za-z0-9_]*)\\\}/gu, (_placeholder, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return Object.freeze({ names: Object.freeze(names), expression: new RegExp(`^${expression}$`, 'u') });
}

export function buildRuntimeOperations(repositoryRoot = undefined) {
  const contracts = loadSystemHttpContracts(repositoryRoot);
  const operations = contracts.openapi.operations;
  return Object.freeze(operations.map((operation) => {
    const matcher = matcherForPath(operation.path);
    return Object.freeze({
      ...operation,
      listener: listenerForPath(operation.path),
      matcher
    });
  }));
}

// The OpenAPI document is the sole route list. This module only compiles it for
// the two real HTTP listeners and supplies path parameters to their handlers.
export const RUNTIME_OPERATIONS = buildRuntimeOperations();

export function canonicalHttpMethod(method) {
  if (typeof method !== 'string' || !/^[A-Za-z]+$/u.test(method)) return null;
  return method.toUpperCase();
}

function routeIdentity(route) {
  return `${route.listener} ${route.method.toUpperCase()} ${route.path} ${route.operationId}`;
}

export function assertRuntimeRouteInventory(routes) {
  if (!Array.isArray(routes)) throw new TypeError('runtime route inventory must be an array');
  const identities = new Set();
  const operationIds = new Set();
  return Object.freeze(routes.map((route) => {
    if (!route || typeof route !== 'object') throw new TypeError('runtime route inventory entry must be an object');
    if (!['public', 'internal'].includes(route.listener)) throw new TypeError(`runtime route listener is invalid: ${route.listener}`);
    if (typeof route.method !== 'string' || !/^[a-z]+$/u.test(route.method)) throw new TypeError(`runtime route method is invalid: ${route.method}`);
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) throw new TypeError(`runtime route path is invalid: ${route.path}`);
    if (typeof route.operationId !== 'string' || route.operationId.length === 0) throw new TypeError('runtime route operationId is required');
    const frozen = Object.freeze({ listener: route.listener, method: route.method, path: route.path, operationId: route.operationId });
    const identity = routeIdentity(frozen);
    if (identities.has(identity)) throw new Error(`runtime route inventory duplicates ${identity}`);
    if (operationIds.has(frozen.operationId)) throw new Error(`runtime route inventory duplicates operationId ${frozen.operationId}`);
    identities.add(identity);
    operationIds.add(frozen.operationId);
    return frozen;
  }));
}

export function deriveRuntimeRouteInventory(operationIds, runtimeOperations = RUNTIME_OPERATIONS) {
  if (!Array.isArray(operationIds)) throw new TypeError('implemented operationIds must be an array');
  if (!Array.isArray(runtimeOperations)) throw new TypeError('runtime operations must be an array');
  const operations = new Map(runtimeOperations.map((operation) => [operation.operationId, operation]));
  return assertRuntimeRouteInventory(operationIds.map((operationId) => {
    if (typeof operationId !== 'string' || operationId.length === 0) throw new TypeError('implemented operationId is required');
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`implemented operationId is not declared by OpenAPI: ${operationId}`);
    return operation;
  }));
}

export function assertRuntimeRouteInventoryMatchesOperationIds({ inventory, operationIds, runtimeOperations = RUNTIME_OPERATIONS }) {
  const actual = assertRuntimeRouteInventory(inventory);
  const expected = deriveRuntimeRouteInventory(operationIds, runtimeOperations);
  if (actual.length !== expected.length || actual.some((route, index) => routeIdentity(route) !== routeIdentity(expected[index]))) {
    throw new Error('runtime route inventory differs from the OpenAPI-derived implemented operationIds');
  }
  return actual;
}

function configuredRouteMatcher(route, apiPublicPath) {
  const path = route.listener === 'public'
    ? joinPublicPrefix(apiPublicPath, route.path.slice('/api'.length))
    : route.path;
  return matcherForPath(path);
}

export function matchRuntimeRoute({ inventory, listener, method, url, apiPublicPath = '/api' }) {
  const canonicalMethod = canonicalHttpMethod(method);
  if (canonicalMethod === null) return null;
  const pathname = new URL(url, 'http://noobai.local').pathname;
  const route = inventory.find((candidate) => candidate.listener === listener && candidate.method === canonicalMethod.toLowerCase() && configuredRouteMatcher(candidate, apiPublicPath).expression.test(pathname));
  if (!route) return null;
  const matcher = configuredRouteMatcher(route, apiPublicPath);
  const match = matcher.expression.exec(pathname);
  const params = Object.freeze(Object.fromEntries(matcher.names.map((name, index) => [name, match[index + 1]])));
  return Object.freeze({ route, params });
}

function configuredOperationMatcher(operation, apiPublicPath) {
  const path = operation.listener === 'public'
    ? joinPublicPrefix(apiPublicPath, operation.path.slice('/api'.length))
    : operation.path;
  return matcherForPath(path);
}

export function matchRuntimeOperation({ listener, method, url, apiPublicPath = '/api', runtimeOperations = RUNTIME_OPERATIONS }) {
  const canonicalMethod = canonicalHttpMethod(method);
  if (canonicalMethod === null) return null;
  const pathname = new URL(url, 'http://noobai.local').pathname;
  const operation = runtimeOperations.find((candidate) => candidate.listener === listener && candidate.method === canonicalMethod.toLowerCase() && configuredOperationMatcher(candidate, apiPublicPath).expression.test(pathname));
  if (!operation) return null;
  const matcher = configuredOperationMatcher(operation, apiPublicPath);
  const match = matcher.expression.exec(pathname);
  const params = Object.freeze(Object.fromEntries(matcher.names.map((name, index) => [name, match[index + 1]])));
  return Object.freeze({ operation, params });
}

export function runtimeOperationIds(listener = undefined, runtimeOperations = RUNTIME_OPERATIONS) {
  return Object.freeze(runtimeOperations
    .filter((operation) => listener === undefined || operation.listener === listener)
    .map((operation) => operation.operationId));
}
