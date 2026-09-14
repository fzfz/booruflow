import { ApplicationError } from '../security/error-mapping.mjs';
import { comfyuiAuthorizationForStoredInstance } from './comfyui-instance-auth.mjs';
import {
  SOURCE_ERROR_MESSAGES,
  SOURCE_INSTANCE_OPERATION_ID,
  SOURCE_TEMPLATE_BUNDLE_OPERATION_ID
} from '../contracts/source-contract.mjs';

const SOURCE_INSTANCE_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const SOURCE_TEMPLATE_ID_PATTERN = SOURCE_INSTANCE_ID_PATTERN;

function sourceInstanceId(value) {
  if (typeof value !== 'string' || !SOURCE_INSTANCE_ID_PATTERN.test(value)) {
    throw new ApplicationError('SOURCE_REQUEST_INVALID', SOURCE_ERROR_MESSAGES.SOURCE_REQUEST_INVALID);
  }
  return value;
}

function sourceTemplateId(value) {
  if (typeof value !== 'string' || !SOURCE_TEMPLATE_ID_PATTERN.test(value)) {
    throw new ApplicationError('SOURCE_REQUEST_INVALID', SOURCE_ERROR_MESSAGES.SOURCE_REQUEST_INVALID);
  }
  return value;
}

function sourceInternalError() {
  return new ApplicationError('SOURCE_INTERNAL_ERROR', SOURCE_ERROR_MESSAGES.SOURCE_INTERNAL_ERROR);
}

function sourceReadError(error) {
  if (error instanceof ApplicationError) return error;
  if (/(?:SQLITE_BUSY|database is locked|database is busy)/iu.test(`${error?.code ?? ''} ${error?.message ?? ''}`)) {
    return new ApplicationError('SOURCE_DATABASE_BUSY', SOURCE_ERROR_MESSAGES.SOURCE_DATABASE_BUSY);
  }
  return sourceInternalError();
}

function projectTemplateBundle(template) {
  return Object.freeze({
    id: template.id,
    title: template.title,
    workflow_json: structuredClone(template.workflow_json)
  });
}

function projectInstance(row, crypto) {
  if (row === null || typeof row !== 'object') {
    throw new ApplicationError('SOURCE_INSTANCE_NOT_FOUND', SOURCE_ERROR_MESSAGES.SOURCE_INSTANCE_NOT_FOUND);
  }
  if (!Number.isSafeInteger(row.id) || row.id < 1 || typeof row.title !== 'string' || row.title.length < 1 || row.title.length > 300) {
    throw new ApplicationError('SOURCE_INTERNAL_ERROR', SOURCE_ERROR_MESSAGES.SOURCE_INTERNAL_ERROR);
  }
  const authorization = (() => {
    try {
      return comfyuiAuthorizationForStoredInstance(row, crypto);
    } catch {
      throw new ApplicationError('SOURCE_CREDENTIAL_UNAVAILABLE', SOURCE_ERROR_MESSAGES.SOURCE_CREDENTIAL_UNAVAILABLE);
    }
  })();
  return Object.freeze({
    id: row.id,
    title: row.title,
    url: row.url,
    credential_type: row.credential_type,
    authorization
  });
}

export function createComfyuiSourceService({ repository, templateRepository = null, crypto, repositoryRoot = undefined } = {}) {
  if (!repository || typeof repository.getStored !== 'function') throw new TypeError('ComfyUI source repository is incomplete');
  if (!crypto || typeof crypto.decrypt !== 'function') throw new TypeError('crypto must provide decrypt');
  function getInstanceSource(instanceId) {
    const stableId = sourceInstanceId(instanceId);
    let row;
    try {
      row = repository.getStored(stableId);
    } catch (error) {
      if (/(?:SQLITE_BUSY|database is locked|database is busy)/iu.test(`${error?.code ?? ''} ${error?.message ?? ''}`)) {
        throw new ApplicationError('SOURCE_DATABASE_BUSY', SOURCE_ERROR_MESSAGES.SOURCE_DATABASE_BUSY);
      }
      throw new ApplicationError('SOURCE_INTERNAL_ERROR', SOURCE_ERROR_MESSAGES.SOURCE_INTERNAL_ERROR);
    }
    return projectInstance(row, crypto);
  }
  function getTemplateBundle(templateId) {
    const stableId = sourceTemplateId(templateId);
    if (!templateRepository || typeof templateRepository.getWorkflowSource !== 'function') {
      throw sourceInternalError();
    }
    let template;
    try {
      template = templateRepository.getWorkflowSource(stableId);
      if (template === null) {
        throw new ApplicationError('SOURCE_TEMPLATE_NOT_FOUND', SOURCE_ERROR_MESSAGES.SOURCE_TEMPLATE_NOT_FOUND);
      }
    } catch (error) {
      throw sourceReadError(error);
    }
    try {
      return projectTemplateBundle(template);
    } catch (error) {
      throw sourceReadError(error);
    }
  }
  return Object.freeze({
    getInstanceSource,
    [SOURCE_INSTANCE_OPERATION_ID]: getInstanceSource,
    getTemplateBundle,
    [SOURCE_TEMPLATE_BUNDLE_OPERATION_ID]: getTemplateBundle
  });
}
