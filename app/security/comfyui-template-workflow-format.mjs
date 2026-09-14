import { loadSystemHttpContracts } from '../contracts/system-http-contracts.mjs';

const DETAIL_CONTRACT_ID = 'comfyui_template_workflow_format';

function detailContract(errorCatalog = undefined) {
  const catalog = errorCatalog ?? loadSystemHttpContracts().errorCatalog;
  const detail = catalog?.detail_contracts?.[DETAIL_CONTRACT_ID];
  const versions = detail?.properties?.supported_versions?.items?.enum;
  if (detail?.type !== 'object' || detail.additionalProperties !== false
    || !Array.isArray(detail.required) || detail.required.length !== 2
    || !detail.required.includes('field') || !detail.required.includes('supported_versions')
    || detail.properties?.field?.const !== 'template_json'
    || !Array.isArray(versions) || versions.length !== 2
    || versions.some((version) => typeof version !== 'string' || version.length === 0)
    || new Set(versions).size !== versions.length) {
    throw new Error('authoritative ComfyUI template Workflow format detail contract is invalid');
  }
  return Object.freeze({ catalog, versions: Object.freeze([...versions]) });
}

export function projectComfyuiTemplateWorkflowFormatDetails(operationId, details, errorCatalog = undefined) {
  const { catalog, versions } = detailContract(errorCatalog);
  if (catalog.errors?.VALIDATION_ERROR?.operation_detail_contracts?.[operationId] !== DETAIL_CONTRACT_ID) return undefined;
  if (details === null || typeof details !== 'object' || Array.isArray(details)
    || Object.keys(details).length !== 2 || Object.keys(details).some((key) => !['field', 'supported_versions'].includes(key))
    || details.field !== 'template_json'
    || !Array.isArray(details.supported_versions)
    || details.supported_versions.length !== versions.length
    || details.supported_versions.some((version, index) => version !== versions[index])) return undefined;
  return Object.freeze({ field: details.field, supported_versions: Object.freeze([...details.supported_versions]) });
}

export { DETAIL_CONTRACT_ID as COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID };
