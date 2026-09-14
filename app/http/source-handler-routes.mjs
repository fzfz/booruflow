import { assertRuntimeRouteInventory } from './runtime-operations.mjs';
import {
  SOURCE_DISCOVERY_OPERATION_ID,
  SOURCE_DISCOVERY_PATH,
  SOURCE_INSTANCE_OPERATION_ID,
  SOURCE_INSTANCE_PATH,
  SOURCE_TEMPLATE_BUNDLE_OPERATION_ID,
  SOURCE_TEMPLATE_BUNDLE_PATH
} from '../contracts/source-contract.mjs';

export const SOURCE_HANDLER_ROUTE_MANIFEST = Object.freeze([
  Object.freeze({ listener: 'internal', method: 'get', path: SOURCE_DISCOVERY_PATH, operationId: SOURCE_DISCOVERY_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'get', path: SOURCE_INSTANCE_PATH, operationId: SOURCE_INSTANCE_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'get', path: SOURCE_TEMPLATE_BUNDLE_PATH, operationId: SOURCE_TEMPLATE_BUNDLE_OPERATION_ID })
]);

export function assertSourceHandlerRoutesMatchRuntime({ manifest = SOURCE_HANDLER_ROUTE_MANIFEST, runtimeRouteInventory } = {}) {
  assertRuntimeRouteInventory(runtimeRouteInventory);
  const expected = manifest.map(({ listener, method, path, operationId }) => `${listener} ${method.toUpperCase()} ${path} ${operationId}`);
  const actual = runtimeRouteInventory
    .filter((route) => route.listener === 'internal' && route.path.startsWith('/internal/comfyui-source'))
    .map(({ listener, method, path, operationId }) => `${listener} ${method.toUpperCase()} ${path} ${operationId}`);
  if (expected.length !== actual.length || expected.some((value) => !actual.includes(value))) {
    throw new Error('Source handler route manifest differs from the implemented runtime routes');
  }
  return runtimeRouteInventory;
}
