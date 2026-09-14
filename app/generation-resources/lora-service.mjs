import { inTransaction } from '../catalog/database.mjs';
import { cleanupMediaPathsAfterCommit } from '../maintenance/maintenance-service.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, validateLoraListQuery, validateLoraWrite } from '../security/input-validation.mjs';
import { deleteVectorEntry, upsertVectorEntry } from '../vector/vector-store.mjs';
import { impactTokensMatch } from './base-model-repository.mjs';
import { targetMatchesSnapshot } from './write-snapshot.mjs';

const VECTOR_OBJECT_KIND = 'generation_lora';
const TARGET_FIELDS = Object.freeze([
  'id',
  'base_model_id',
  'model_id',
  'file_name',
  'file_format',
  'precision_or_quantization',
  'author',
  'version',
  'release_url',
  'description',
  'usage',
  'trigger_words',
  'weight',
  'created_at'
]);

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('now must return a valid Date');
  return value.toISOString();
}

function isDuplicateConstraint(error) {
  return /generation_loras_identity_uq|UNIQUE constraint failed: generation_loras\./u.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

export function createLoraService({ database, repository, mediaStorage, cleanupQueue, vectorMaintenance, now = () => new Date() }) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new TypeError('database must provide prepare and exec transaction methods');
  if (!repository || ['list', 'get', 'modelInBase', 'create', 'update', 'getImpact', 'remove'].some((name) => typeof repository[name] !== 'function')) throw new TypeError('lora repository is incomplete');
  if (!mediaStorage || typeof mediaStorage.remove !== 'function') throw new TypeError('mediaStorage must provide remove');
  if (!cleanupQueue || typeof cleanupQueue.enqueue !== 'function' || typeof cleanupQueue.recordFailure !== 'function') throw new TypeError('cleanupQueue must provide enqueue and recordFailure');
  if (!vectorMaintenance || typeof vectorMaintenance.prepare !== 'function') throw new TypeError('lora vector maintenance must provide prepare');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function read(id) {
    assertIdentifier(id, 'id');
    const lora = repository.get(id);
    if (!lora) throw new ApplicationError('NOT_FOUND', 'lora was not found');
    return lora;
  }

  function assertModelEcosystem({ base_model_id: baseModelId, model_id: modelId }) {
    if (!repository.modelInBase(modelId, baseModelId)) throw new ApplicationError('RELATION_CONFLICT', 'model must belong to the selected base model');
  }

  async function write(id, input) {
    const request = validateLoraWrite(input);
    const changedAt = timestamp(now);
    let targetSnapshot = null;
    if (id !== null) {
      assertIdentifier(id, 'id');
      targetSnapshot = read(id);
    }
    assertModelEcosystem(request);
    const prepared = await vectorMaintenance.prepare({
      ...request,
      trigger_words_json: JSON.stringify(request.trigger_words)
    });
    try {
      return inTransaction(database, () => {
        if (id !== null) {
          const current = repository.get(id);
          if (!current) throw new ApplicationError('NOT_FOUND', 'lora was not found');
          if (!targetMatchesSnapshot(targetSnapshot, current, TARGET_FIELDS)) {
            throw new ApplicationError('RELATION_CONFLICT', 'lora changed while its embedding was prepared');
          }
        }
        assertModelEcosystem(request);
        const lora = id === null
          ? repository.create({ ...request, timestamp: changedAt })
          : repository.update({ id, ...request, timestamp: changedAt });
        upsertVectorEntry(database, VECTOR_OBJECT_KIND, lora.id, prepared.vector, { expectedModel: prepared.embedding_model });
        return lora;
      });
    } catch (error) {
      if (isDuplicateConstraint(error)) throw new ApplicationError('DUPLICATE_RESOURCE', 'generation lora identity already exists');
      throw error;
    }
  }

  return Object.freeze({
    list: (input) => repository.list(validateLoraListQuery(input)),
    create: (input) => write(null, input),
    get: read,
    update: (id, input) => write(id, input),
    getDeleteImpact(id) {
      assertIdentifier(id, 'id');
      const impact = repository.getImpact(id);
      if (!impact) throw new ApplicationError('NOT_FOUND', 'lora was not found');
      return impact;
    },
    delete(id, impactToken) {
      assertIdentifier(id, 'id');
      const deleted = inTransaction(database, () => {
        const impact = repository.getImpact(id);
        if (!impact) throw new ApplicationError('NOT_FOUND', 'lora was not found');
        if (!impactTokensMatch(impactToken, impact.impact_token)) throw new ApplicationError('DELETE_IMPACT_STALE', 'lora delete impact has changed');
        deleteVectorEntry(database, VECTOR_OBJECT_KIND, id);
        repository.remove(id);
        return Object.freeze({ target: impact.target, cascade_deleted: impact.cascade_deleted, retained: impact.retained });
      });
      const mediaPaths = deleted.cascade_deleted.filter((item) => item.kind === 'image' && typeof item.media_path === 'string').map((item) => item.media_path);
      return Object.freeze({ ...deleted, ...cleanupMediaPathsAfterCommit(mediaStorage, mediaPaths, cleanupQueue, 'owner_delete') });
    }
  });
}
