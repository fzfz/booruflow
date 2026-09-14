import { inTransaction } from '../catalog/database.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, validatePromptTermListQuery, validatePromptTermWrite } from '../security/input-validation.mjs';
import { deleteVectorEntry, upsertVectorEntry } from '../vector/vector-store.mjs';

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('now must return a valid Date');
  return value.toISOString();
}

function isDuplicateConstraint(error) {
  return /UNIQUE constraint failed: prompt_terms\.canonical_tag/u.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

export function createPromptTermManagementService({ database, repository, vectorMaintenance, now = () => new Date() }) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new TypeError('database must provide prepare and exec transaction methods');
  if (!repository || ['list', 'get', 'create', 'update', 'remove'].some((name) => typeof repository[name] !== 'function')) throw new TypeError('Prompt Tag repository is incomplete');
  if (!vectorMaintenance || typeof vectorMaintenance.prepare !== 'function') throw new TypeError('Prompt Tag vector maintenance must provide prepare');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function read(id) {
    assertIdentifier(id, 'id');
    const row = repository.get(id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Prompt Tag was not found');
    return row;
  }

  async function write(id, input) {
    const request = validatePromptTermWrite(input);
    if (id !== null) {
      assertIdentifier(id, 'id');
      read(id);
    }
    const prepared = await vectorMaintenance.prepare({
      canonical_tag: request.canonical_tag,
      aliases_json: JSON.stringify(request.aliases_json)
    });
    try {
      return inTransaction(database, () => {
        const row = id === null
          ? repository.create({ ...request, timestamp: timestamp(now) })
          : repository.update({ id, ...request, timestamp: timestamp(now) });
        upsertVectorEntry(database, 'prompt_term', row.id, prepared.vector, { expectedModel: prepared.embedding_model });
        return row;
      });
    } catch (error) {
      if (isDuplicateConstraint(error)) throw new ApplicationError('DUPLICATE_RESOURCE', 'Prompt Tag canonical_tag already exists');
      throw error;
    }
  }

  return Object.freeze({
    list: (input) => repository.list(validatePromptTermListQuery(input)),
    create: (input) => write(null, input),
    get: read,
    update: (id, input) => write(id, input),
    delete(id) {
      const target = read(id);
      return inTransaction(database, () => {
        deleteVectorEntry(database, 'prompt_term', id);
        repository.remove(id);
        return Object.freeze({ target: Object.freeze({ id: target.id, canonical_tag: target.canonical_tag }) });
      });
    }
  });
}
