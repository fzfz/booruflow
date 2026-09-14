import { inTransaction } from '../catalog/database.mjs';
import { cleanupMediaPathsAfterCommit } from '../maintenance/maintenance-service.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, validateComfyuiTemplateListQuery, validateComfyuiTemplateWrite } from '../security/input-validation.mjs';
import { impactTokensMatch } from './base-model-repository.mjs';
import { COMFYUI_WORKFLOW_FORMAT, isSupportedComfyuiWorkflow } from './comfyui-workflow-validator.mjs';

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('now must return a valid Date');
  return value.toISOString();
}

export function createComfyuiTemplateService({ database, repository, mediaStorage, cleanupQueue, now = () => new Date() } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new TypeError('database must provide prepare and exec transaction methods');
  if (!repository || ['list', 'get', 'modelInBase', 'loraInEcosystem', 'create', 'update', 'getImpact', 'remove'].some((name) => typeof repository[name] !== 'function')) throw new TypeError('ComfyUI template repository is incomplete');
  if (!mediaStorage || typeof mediaStorage.remove !== 'function') throw new TypeError('mediaStorage must provide remove');
  if (!cleanupQueue || typeof cleanupQueue.enqueue !== 'function' || typeof cleanupQueue.recordFailure !== 'function') throw new TypeError('cleanupQueue must provide enqueue and recordFailure');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function read(id) {
    assertIdentifier(id, 'id');
    const template = repository.get(id);
    if (!template) throw new ApplicationError('NOT_FOUND', 'ComfyUI template was not found');
    return template;
  }

  function assertEcosystem(request) {
    if (!repository.modelInBase(request.model_id, request.base_model_id)) {
      throw new ApplicationError('RELATION_CONFLICT', 'model must belong to the selected base model');
    }
    if (request.lora_id !== null && !repository.loraInEcosystem(request.lora_id, request.base_model_id, request.model_id)) {
      throw new ApplicationError('RELATION_CONFLICT', 'LoRA must belong to the selected model ecosystem');
    }
  }

  function write(id, input) {
    const request = validateComfyuiTemplateWrite(input);
    if (!isSupportedComfyuiWorkflow(request.template_json)) {
      const error = new ApplicationError('VALIDATION_ERROR', COMFYUI_WORKFLOW_FORMAT.validationMessage);
      error.details = COMFYUI_WORKFLOW_FORMAT.errorDetails;
      throw error;
    }
    const changedAt = timestamp(now);
    const persist = () => inTransaction(database, () => {
      if (id !== null) {
        assertIdentifier(id, 'id');
        read(id);
      }
      assertEcosystem(request);
      const record = id === null
        ? repository.create({ ...request, timestamp: changedAt })
        : repository.update({ id, ...request, timestamp: changedAt });
      return record;
    });
    return persist();
  }

  return Object.freeze({
    list: (input) => repository.list(validateComfyuiTemplateListQuery(input)),
    create: (input) => write(null, input),
    get: read,
    update: (id, input) => write(id, input),
    getDeleteImpact(id) {
      assertIdentifier(id, 'id');
      const impact = repository.getImpact(id);
      if (!impact) throw new ApplicationError('NOT_FOUND', 'ComfyUI template was not found');
      return impact;
    },
    delete(id, impactToken) {
      assertIdentifier(id, 'id');
      const deleted = inTransaction(database, () => {
        const impact = repository.getImpact(id);
        if (!impact) throw new ApplicationError('NOT_FOUND', 'ComfyUI template was not found');
        if (!impactTokensMatch(impactToken, impact.impact_token)) throw new ApplicationError('DELETE_IMPACT_STALE', 'ComfyUI template delete impact has changed');
        repository.remove(id);
        return Object.freeze({ target: impact.target, cascade_deleted: impact.cascade_deleted, retained: impact.retained });
      });
      const mediaPaths = deleted.cascade_deleted.filter((item) => item.kind === 'image').map((item) => item.media_path);
      return Object.freeze({ ...deleted, ...cleanupMediaPathsAfterCommit(mediaStorage, mediaPaths, cleanupQueue, 'owner_delete') });
    }
  });
}
