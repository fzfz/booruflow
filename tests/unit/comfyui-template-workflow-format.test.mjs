import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID,
  projectComfyuiTemplateWorkflowFormatDetails
} from '../../app/security/comfyui-template-workflow-format.mjs';

const OPERATION_ID = 'createComfyuiTemplate';

function catalog() {
  return {
    errors: {
      VALIDATION_ERROR: {
        operation_detail_contracts: {
          [OPERATION_ID]: COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID
        }
      }
    },
    detail_contracts: {
      [COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID]: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'supported_versions'],
        properties: {
          field: { const: 'template_json' },
          supported_versions: { items: { enum: ['0.4', '1.0'] } }
        }
      }
    }
  };
}

function details(overrides = {}) {
  return { field: 'template_json', supported_versions: ['0.4', '1.0'], ...overrides };
}

function mutate(source, callback) {
  const copy = structuredClone(source);
  callback(copy);
  return copy;
}

test('ComfyUI Workflow 错误详情投影只接受 operationId 对应的精确结构', () => {
  const authoritativeCatalog = catalog();
  assert.deepEqual(projectComfyuiTemplateWorkflowFormatDetails(OPERATION_ID, details()), details());
  assert.deepEqual(
    projectComfyuiTemplateWorkflowFormatDetails(OPERATION_ID, details(), authoritativeCatalog),
    details()
  );
  assert.equal(projectComfyuiTemplateWorkflowFormatDetails('updateComfyuiTemplate', details(), authoritativeCatalog), undefined);

  const invalidDetails = [
    null,
    [],
    { field: 'template_json' },
    { field: 'template_json', unknown: ['0.4', '1.0'] },
    { ...details(), extra: true },
    details({ field: 'workflow_json' }),
    details({ supported_versions: '0.4' }),
    details({ supported_versions: ['0.4'] }),
    details({ supported_versions: ['1.0', '0.4'] })
  ];
  for (const value of invalidDetails) {
    assert.equal(projectComfyuiTemplateWorkflowFormatDetails(OPERATION_ID, value, authoritativeCatalog), undefined);
  }
});

test('ComfyUI Workflow 错误详情投影拒绝每种畸形权威详情契约', () => {
  const invalidCatalogs = [
    mutate(catalog(), (value) => { delete value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID]; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].type = 'array'; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].additionalProperties = true; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].required = 'field'; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].required = ['field']; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].required = ['supported_versions', 'other']; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].required = ['field', 'other']; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].properties.field.const = 'workflow_json'; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].properties.supported_versions.items.enum = '0.4'; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].properties.supported_versions.items.enum = ['0.4']; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].properties.supported_versions.items.enum = ['0.4', 1]; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].properties.supported_versions.items.enum = ['0.4', '']; }),
    mutate(catalog(), (value) => { value.detail_contracts[COMFYUI_TEMPLATE_WORKFLOW_FORMAT_DETAIL_CONTRACT_ID].properties.supported_versions.items.enum = ['0.4', '0.4']; })
  ];
  for (const errorCatalog of invalidCatalogs) {
    assert.throws(
      () => projectComfyuiTemplateWorkflowFormatDetails(OPERATION_ID, details(), errorCatalog),
      /authoritative ComfyUI template Workflow format detail contract is invalid/u
    );
  }
});
