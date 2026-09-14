import { inTransaction } from '../catalog/database.mjs';
import { cleanupMediaPathsAfterCommit } from '../maintenance/maintenance-service.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, validateModelListQuery, validateModelWrite } from '../security/input-validation.mjs';
import { deleteVectorEntry } from '../vector/vector-store.mjs';
import { impactTokensMatch } from './base-model-repository.mjs';

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('now must return a valid Date');
  return value.toISOString();
}

function isDuplicateConstraint(error) {
  return /generation_models_identity_uq|UNIQUE constraint failed: generation_models\./u.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

export function createModelService({ database, repository, mediaStorage, cleanupQueue, now = () => new Date() }) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new TypeError('database must provide prepare and exec transaction methods');
  if (!repository || ['list', 'get', 'baseModelExists', 'hasDependents', 'create', 'update', 'getImpact', 'remove'].some((name) => typeof repository[name] !== 'function')) throw new TypeError('model repository is incomplete');
  if (!mediaStorage || typeof mediaStorage.remove !== 'function') throw new TypeError('mediaStorage must provide remove');
  if (!cleanupQueue || typeof cleanupQueue.enqueue !== 'function' || typeof cleanupQueue.recordFailure !== 'function') throw new TypeError('cleanupQueue must provide enqueue and recordFailure');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function read(id) {
    assertIdentifier(id, 'id');
    const model = repository.get(id);
    if (!model) throw new ApplicationError('NOT_FOUND', 'model was not found');
    return model;
  }

  function assertBaseModel(id) {
    if (!repository.baseModelExists(id)) throw new ApplicationError('RELATION_CONFLICT', 'base model was not found');
  }

  function write(id, input) {
    const request = validateModelWrite(input);
    const changedAt = timestamp(now);
    try {
      return inTransaction(database, () => {
        if (id === null) {
          assertBaseModel(request.base_model_id);
          return repository.create({ ...request, timestamp: changedAt });
        }
        assertIdentifier(id, 'id');
        const current = read(id);
        assertBaseModel(request.base_model_id);
        if (current.base_model_id !== request.base_model_id && repository.hasDependents(id)) throw new ApplicationError('RELATION_CONFLICT', 'model with dependent resources cannot change base model');
        return repository.update({ id, ...request, timestamp: changedAt });
      });
    } catch (error) {
      if (isDuplicateConstraint(error)) throw new ApplicationError('DUPLICATE_RESOURCE', 'generation model identity already exists');
      throw error;
    }
  }

  return Object.freeze({
    list: (input) => repository.list(validateModelListQuery(input)),
    create: (input) => write(null, input),
    get: read,
    update: (id, input) => write(id, input),
    getDeleteImpact(id) {
      assertIdentifier(id, 'id');
      const impact = repository.getImpact(id);
      if (!impact) throw new ApplicationError('NOT_FOUND', 'model was not found');
      return impact;
    },
    delete(id, impactToken) {
      assertIdentifier(id, 'id');
      const deleted = inTransaction(database, () => {
        const impact = repository.getImpact(id);
        if (!impact) throw new ApplicationError('NOT_FOUND', 'model was not found');
        if (!impactTokensMatch(impactToken, impact.impact_token)) throw new ApplicationError('DELETE_IMPACT_STALE', 'model delete impact has changed');
        for (const item of impact.cascade_deleted) {
          if (item.kind === 'lora') deleteVectorEntry(database, 'generation_lora', item.id);
        }
        repository.remove(id);
        return Object.freeze({ target: impact.target, cascade_deleted: impact.cascade_deleted, retained: impact.retained });
      });
      const mediaPaths = deleted.cascade_deleted.filter((item) => item.kind === 'image' && typeof item.media_path === 'string').map((item) => item.media_path);
      return Object.freeze({ ...deleted, ...cleanupMediaPathsAfterCommit(mediaStorage, mediaPaths, cleanupQueue, 'owner_delete') });
    }
  });
}
