import { assertRuntimeRouteInventory } from './runtime-operations.mjs';
import {
  BASE_MODEL_CATALOG_OPERATION_ID,
  BASE_MODEL_CATALOG_PATH,
  ARTIST_PROMPT_STRING_CATALOG_OPERATION_ID,
  ARTIST_PROMPT_STRING_CATALOG_PATH,
  WORK_CATALOG_OPERATION_ID,
  WORK_CATALOG_PATH,
  CHARACTER_CATALOG_OPERATION_ID,
  CHARACTER_CATALOG_PATH,
  COMFYUI_INSTANCE_CATALOG_OPERATION_ID,
  COMFYUI_INSTANCE_CATALOG_PATH,
  COMFYUI_TEMPLATE_CATALOG_OPERATION_ID,
  COMFYUI_TEMPLATE_CATALOG_PATH,
  GENERATION_MODEL_CATALOG_OPERATION_ID,
  GENERATION_MODEL_CATALOG_PATH,
  LORA_CATALOG_OPERATION_ID,
  LORA_CATALOG_PATH,
  PROMPT_TERM_CATALOG_OPERATION_ID,
  PROMPT_TERM_CATALOG_PATH,
  STYLE_CATALOG_OPERATION_ID,
  STYLE_CATALOG_PATH
} from '../contracts/catalog-contract.mjs';

// This list describes the handlers that are actually implemented by the
// semantic dispatcher and the local discovery endpoint. It is intentionally
// independent from OpenAPI so a declaration cannot make an unimplemented
// route appear callable merely by being copied into the schema.
export const SEMANTIC_HANDLER_ROUTE_MANIFEST = Object.freeze([
  Object.freeze({ listener: 'internal', method: 'get', path: '/internal/semantic', operationId: 'getSemanticDiscovery' }),
  Object.freeze({ listener: 'internal', method: 'post', path: BASE_MODEL_CATALOG_PATH, operationId: BASE_MODEL_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: GENERATION_MODEL_CATALOG_PATH, operationId: GENERATION_MODEL_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: LORA_CATALOG_PATH, operationId: LORA_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: WORK_CATALOG_PATH, operationId: WORK_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: CHARACTER_CATALOG_PATH, operationId: CHARACTER_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: STYLE_CATALOG_PATH, operationId: STYLE_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: PROMPT_TERM_CATALOG_PATH, operationId: PROMPT_TERM_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: ARTIST_PROMPT_STRING_CATALOG_PATH, operationId: ARTIST_PROMPT_STRING_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: COMFYUI_INSTANCE_CATALOG_PATH, operationId: COMFYUI_INSTANCE_CATALOG_OPERATION_ID }),
  Object.freeze({ listener: 'internal', method: 'post', path: COMFYUI_TEMPLATE_CATALOG_PATH, operationId: COMFYUI_TEMPLATE_CATALOG_OPERATION_ID })
]);

function identity(route) {
  return `${route.listener} ${route.method.toUpperCase()} ${route.path} ${route.operationId}`;
}

export function assertSemanticHandlerRouteManifest(manifest = SEMANTIC_HANDLER_ROUTE_MANIFEST) {
  if (!Array.isArray(manifest)) throw new TypeError('semantic handler route manifest must be an array');
  return assertRuntimeRouteInventory(manifest);
}

export function assertSemanticHandlerRoutesMatchRuntime({
  manifest = SEMANTIC_HANDLER_ROUTE_MANIFEST,
  runtimeRouteInventory
} = {}) {
  const expected = assertSemanticHandlerRouteManifest(manifest);
  const actual = assertRuntimeRouteInventory(runtimeRouteInventory);
  const actualSemantic = actual.filter((route) => route.listener === 'internal' && (
    route.path === '/internal/semantic' || route.path.startsWith('/internal/semantic/')
  ));
  const actualIdentities = new Set(actualSemantic.map(identity));
  if (expected.length !== actualSemantic.length || expected.some((route) => !actualIdentities.has(identity(route)))) {
    throw new Error('semantic handler route manifest differs from the implemented runtime routes');
  }
  return actual;
}
