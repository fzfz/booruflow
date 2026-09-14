import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, normalizeSearchText, validateBaseModelWrite } from '../security/input-validation.mjs';
import { inTransaction } from '../catalog/database.mjs';
import { cleanupMediaPathsAfterCommit } from '../maintenance/maintenance-service.mjs';
import { deleteVectorEntry } from '../vector/vector-store.mjs';
import { impactTokensMatch } from './base-model-repository.mjs';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 16;
const MAX_PAGE_SIZE = 100;
function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('now must return a valid Date');
  return value.toISOString();
}

function validateListQuery(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApplicationError('VALIDATION_ERROR', 'base model list query must be an object');
  }
  const q = input.q === undefined ? '' : input.q;
  if (typeof q !== 'string' || q.length > 100) throw new ApplicationError('VALIDATION_ERROR', 'q must contain 0 to 100 UTF-16 code units');
  const page = input.page === undefined ? DEFAULT_PAGE : input.page;
  if (!Number.isSafeInteger(page) || page < 1) throw new ApplicationError('VALIDATION_ERROR', 'page must be a positive integer');
  const pageSize = input.page_size === undefined ? DEFAULT_PAGE_SIZE : input.page_size;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new ApplicationError('VALIDATION_ERROR', `page_size must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  return Object.freeze({ page, page_size: pageSize, q: normalizeSearchText(q) });
}

function isDuplicateConstraint(error) {
  return /UNIQUE constraint failed: generation_base_models\.name/u.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

function isForeignKeyConstraint(error) {
  return /FOREIGN KEY constraint failed/u.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

export function createBaseModelService({ database, repository, mediaStorage, cleanupQueue, now = () => new Date() }) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new TypeError('database must provide prepare and exec transaction methods');
  if (!repository || ['list', 'get', 'create', 'update', 'getImpact', 'remove'].some((name) => typeof repository[name] !== 'function')) {
    throw new TypeError('base model repository is incomplete');
  }
  if (!mediaStorage || typeof mediaStorage.remove !== 'function') throw new TypeError('mediaStorage must provide remove');
  if (!cleanupQueue || typeof cleanupQueue.enqueue !== 'function' || typeof cleanupQueue.recordFailure !== 'function') throw new TypeError('cleanupQueue must provide enqueue and recordFailure');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function read(id) {
    assertIdentifier(id, 'id');
    const model = repository.get(id);
    if (!model) throw new ApplicationError('NOT_FOUND', 'base model was not found');
    return model;
  }

  function write(id, input) {
    const request = validateBaseModelWrite(input);
    const changedAt = timestamp(now);
    try {
      return id === null
        ? repository.create({ ...request, timestamp: changedAt })
        : (() => {
            assertIdentifier(id, 'id');
            read(id);
            return repository.update({ id, ...request, timestamp: changedAt });
          })();
    } catch (error) {
      if (isDuplicateConstraint(error)) throw new ApplicationError('DUPLICATE_RESOURCE', 'base model name already exists');
      throw error;
    }
  }

  return Object.freeze({
    list: (input) => repository.list(validateListQuery(input)),
    create: (input) => write(null, input),
    get: read,
    update: (id, input) => write(id, input),
    getDeleteImpact(id) {
      assertIdentifier(id, 'id');
      const impact = repository.getImpact(id);
      if (!impact) throw new ApplicationError('NOT_FOUND', 'base model was not found');
      return impact;
    },
    delete(id, impactToken) {
      assertIdentifier(id, 'id');
      const deleted = inTransaction(database, () => {
        const impact = repository.getImpact(id);
        if (!impact) throw new ApplicationError('NOT_FOUND', 'base model was not found');
        if (!impactTokensMatch(impactToken, impact.impact_token)) {
          throw new ApplicationError('DELETE_IMPACT_STALE', 'base model delete impact has changed');
        }
        try {
          for (const item of impact.cascade_deleted) {
            if (item.kind === 'lora') deleteVectorEntry(database, 'generation_lora', item.id);
          }
          repository.remove(id);
        } catch (error) {
          if (isForeignKeyConstraint(error)) {
            throw new ApplicationError('RELATION_CONFLICT', 'base model is still referenced by another resource');
          }
          throw error;
        }
        return Object.freeze({ target: impact.target, cascade_deleted: impact.cascade_deleted, retained: impact.retained });
      });
      const mediaPaths = deleted.cascade_deleted
        .filter((item) => item.kind === 'image' && typeof item.media_path === 'string')
        .map((item) => item.media_path);
      const cleanup = cleanupMediaPathsAfterCommit(mediaStorage, mediaPaths, cleanupQueue, 'owner_delete');
      return Object.freeze({
        ...deleted,
        ...cleanup
      });
    }
  });
}
