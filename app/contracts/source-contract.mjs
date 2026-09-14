export const SOURCE_DISCOVERY_OPERATION_ID = 'getComfyuiSourceDiscovery';
export const SOURCE_DISCOVERY_PATH = '/internal/comfyui-source';
export const SOURCE_INSTANCE_OPERATION_ID = 'getComfyuiInstanceSourceForHost';
export const SOURCE_INSTANCE_PATH = '/internal/comfyui-source/instances/{instance_id}';
export const SOURCE_TEMPLATE_BUNDLE_OPERATION_ID = 'getComfyuiTemplateBundleForHost';
export const SOURCE_TEMPLATE_BUNDLE_PATH = '/internal/comfyui-source/templates/{template_id}/bundle';

export const SOURCE_ERROR_MESSAGES = Object.freeze({
  SOURCE_REQUEST_INVALID: 'Source request is invalid.',
  SOURCE_INSTANCE_NOT_FOUND: 'ComfyUI instance was not found.',
  SOURCE_CREDENTIAL_UNAVAILABLE: 'ComfyUI authorization is unavailable.',
  SOURCE_TEMPLATE_NOT_FOUND: 'ComfyUI template was not found.',
  SOURCE_TEMPLATE_UNAVAILABLE: 'ComfyUI template data is unavailable.',
  SOURCE_DATABASE_BUSY: 'Source catalog is busy.',
  SOURCE_INTERNAL_ERROR: 'Source read failed.'
});

export function isSourceOperation(operationId) {
  return operationId === SOURCE_DISCOVERY_OPERATION_ID
    || operationId === SOURCE_INSTANCE_OPERATION_ID
    || operationId === SOURCE_TEMPLATE_BUNDLE_OPERATION_ID;
}
