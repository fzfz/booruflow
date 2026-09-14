export const BASE_MODEL_CATALOG_KIND = 'base-model';
export const BASE_MODEL_CATALOG_OPERATION_ID = 'querySemanticBaseModelsForSkill';
export const BASE_MODEL_CATALOG_PATH = '/internal/semantic/base-models';
export const BASE_MODEL_CATALOG_TOOL_NAME = 'query_semantic_base_models';
export const GENERATION_MODEL_CATALOG_KIND = 'model';
export const GENERATION_MODEL_CATALOG_OPERATION_ID = 'querySemanticGenerationModelsForSkill';
export const GENERATION_MODEL_CATALOG_PATH = '/internal/semantic/generation-models';
export const GENERATION_MODEL_CATALOG_TOOL_NAME = 'query_semantic_generation_models';
export const LORA_CATALOG_KIND = 'lora';
export const LORA_CATALOG_OPERATION_ID = 'querySemanticLorasForSkill';
export const LORA_CATALOG_PATH = '/internal/semantic/loras';
export const LORA_CATALOG_TOOL_NAME = 'query_semantic_loras';
export const WORK_CATALOG_KIND = 'work';
export const WORK_CATALOG_OPERATION_ID = 'querySemanticWorksForSkill';
export const WORK_CATALOG_PATH = '/internal/semantic/works';
export const WORK_CATALOG_TOOL_NAME = 'query_semantic_works';
export const CHARACTER_CATALOG_KIND = 'character';
export const CHARACTER_CATALOG_OPERATION_ID = 'querySemanticCharactersForSkill';
export const CHARACTER_CATALOG_PATH = '/internal/semantic/characters';
export const CHARACTER_CATALOG_TOOL_NAME = 'query_semantic_characters';
export const STYLE_CATALOG_KIND = 'style';
export const STYLE_CATALOG_OPERATION_ID = 'querySemanticStylesForSkill';
export const STYLE_CATALOG_PATH = '/internal/semantic/styles';
export const STYLE_CATALOG_TOOL_NAME = 'query_semantic_styles';
export const PROMPT_TERM_CATALOG_KIND = 'prompt-term';
export const PROMPT_TERM_CATALOG_OPERATION_ID = 'querySemanticPromptTermsForSkill';
export const PROMPT_TERM_CATALOG_PATH = '/internal/semantic/prompt-terms';
export const PROMPT_TERM_CATALOG_TOOL_NAME = 'query_semantic_prompt_terms';
export const ARTIST_PROMPT_STRING_CATALOG_KIND = 'artist-string';
export const ARTIST_PROMPT_STRING_CATALOG_OPERATION_ID = 'querySemanticArtistPromptStringsForSkill';
export const ARTIST_PROMPT_STRING_CATALOG_PATH = '/internal/semantic/artist-prompt-strings';
export const ARTIST_PROMPT_STRING_CATALOG_TOOL_NAME = 'query_semantic_artist_prompt_strings';
export const COMFYUI_INSTANCE_CATALOG_KIND = 'comfyui-instance';
export const COMFYUI_INSTANCE_CATALOG_OPERATION_ID = 'querySemanticComfyuiInstancesForSkill';
export const COMFYUI_INSTANCE_CATALOG_PATH = '/internal/semantic/comfyui-instances';
export const COMFYUI_INSTANCE_CATALOG_TOOL_NAME = 'query_semantic_comfyui_instances';
export const COMFYUI_TEMPLATE_CATALOG_KIND = 'comfyui-template';
export const COMFYUI_TEMPLATE_CATALOG_OPERATION_ID = 'querySemanticComfyuiTemplatesForSkill';
export const COMFYUI_TEMPLATE_CATALOG_PATH = '/internal/semantic/comfyui-templates';
export const COMFYUI_TEMPLATE_CATALOG_TOOL_NAME = 'query_semantic_comfyui_templates';
export const CATALOG_ITEM_TITLE_MAX_LENGTH = 300;
export const CATALOG_PAGE_MAX_ITEMS = 100;
export const CATALOG_FREE_TEXT_MAX_LENGTH = 10000;
const CATALOG_MEDIA_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/u;

export const CATALOG_ERROR_MESSAGES = Object.freeze({
  CATALOG_REQUEST_INVALID: 'Catalog request is invalid.',
  CATALOG_REF_NOT_FOUND: 'Catalog record was not found.',
  CATALOG_RESOURCE_UNAVAILABLE: 'Catalog record cannot be projected.',
  CATALOG_DEPENDENCY_UNAVAILABLE: 'Catalog dependency is unavailable.',
  CATALOG_INDEX_NOT_READY: 'Catalog semantic index is not ready.',
  CATALOG_DATABASE_BUSY: 'Catalog database is busy.',
  CATALOG_DEPENDENCY_TIMEOUT: 'Catalog dependency timed out.',
  CATALOG_INTERNAL_ERROR: 'Catalog query failed.'
});

export function isCatalogOperation(operationId) {
  return operationId === BASE_MODEL_CATALOG_OPERATION_ID
    || operationId === GENERATION_MODEL_CATALOG_OPERATION_ID
    || operationId === LORA_CATALOG_OPERATION_ID
    || operationId === WORK_CATALOG_OPERATION_ID
    || operationId === CHARACTER_CATALOG_OPERATION_ID
    || operationId === STYLE_CATALOG_OPERATION_ID
    || operationId === PROMPT_TERM_CATALOG_OPERATION_ID
    || operationId === ARTIST_PROMPT_STRING_CATALOG_OPERATION_ID
    || operationId === COMFYUI_INSTANCE_CATALOG_OPERATION_ID
    || operationId === COMFYUI_TEMPLATE_CATALOG_OPERATION_ID;
}

export function assertCatalogMediaOrigin(mediaOrigin) {
  if (typeof mediaOrigin !== 'string' || !CATALOG_MEDIA_ORIGIN_PATTERN.test(mediaOrigin)) {
    throw new TypeError('catalog media origin must be an HTTP loopback origin with a port from 1 to 65535');
  }
  return mediaOrigin;
}
