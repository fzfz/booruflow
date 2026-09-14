import { inTransaction } from './database.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, assertItemKind, validateCatalogManagementWrite } from '../security/input-validation.mjs';
import { deleteVectorEntry, upsertVectorEntry } from '../vector/vector-store.mjs';

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('now must return a valid Date');
  return value.toISOString();
}

function duplicateError(error) {
  return /UNIQUE constraint failed:/u.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

export function createCatalogManagementService({ database, repository, vectorPreparation, now = () => new Date() }) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required');
  if (!repository || ['getManageWriteItem', 'createManageWriteItem', 'updateManageWriteItem', 'workExists', 'baseModelExists', 'availableCharactersForWork'].some((name) => typeof repository[name] !== 'function')) {
    throw new TypeError('catalog management repository is incomplete');
  }
  if (!vectorPreparation || typeof vectorPreparation.prepare !== 'function') throw new TypeError('vectorPreparation.prepare is required');

  function get(kind, id) {
    assertItemKind(kind, { allowWork: true });
    assertIdentifier(id, 'item_id');
    const row = repository.getManageWriteItem(kind, id);
    if (!row) throw new ApplicationError('NOT_FOUND', `${kind} was not found`);
    return row;
  }

  function assertRelations(kind, input) {
    if (kind === 'character' && !repository.workExists(input.work_id)) throw new ApplicationError('RELATION_CONFLICT', 'character work does not exist');
    if (kind === 'style' && !repository.baseModelExists(input.base_model_id)) throw new ApplicationError('RELATION_CONFLICT', 'style base model does not exist');
  }

  async function vectorPlan(kind, input, existing) {
    if (kind === 'work') {
      const childRows = existing === null ? [] : repository.availableCharactersForWork(existing.id, input.name);
      if (!input.is_available) return Object.freeze({ prepared: Object.freeze([]), deleted: Object.freeze([...(existing ? [{ kind: 'work', id: existing.id }] : []), ...childRows.map(({ id }) => ({ kind: 'character', id }))]) });
      const prepared = [{ kind: 'work', id: existing?.id ?? null, value: await vectorPreparation.prepare('work', { ...input, aliases_json: JSON.stringify(input.aliases_json) }) }];
      for (const row of childRows) prepared.push({ kind: 'character', id: row.id, value: await vectorPreparation.prepare('character', row) });
      return Object.freeze({ prepared: Object.freeze(prepared), deleted: Object.freeze([]) });
    }
    if (kind === 'character') {
      if (!input.is_available) return Object.freeze({ prepared: Object.freeze([]), deleted: Object.freeze(existing ? [{ kind, id: existing.id }] : []) });
      const work = repository.getManageWriteItem('work', input.work_id);
      const value = await vectorPreparation.prepare(kind, { ...input, aliases_json: JSON.stringify(input.aliases_json), work_name: work.name });
      return Object.freeze({ prepared: Object.freeze([{ kind, id: existing?.id ?? null, value }]), deleted: Object.freeze([]) });
    }
    const value = await vectorPreparation.prepare(kind, { ...input, aliases_json: JSON.stringify(input.aliases_json) });
    return Object.freeze({ prepared: Object.freeze([{ kind, id: existing?.id ?? null, value }]), deleted: Object.freeze([]) });
  }

  async function write(kind, id, rawInput) {
    assertItemKind(kind, { allowWork: true });
    const input = validateCatalogManagementWrite(kind, rawInput);
    const existing = id === null ? null : get(kind, id);
    assertRelations(kind, input);
    const plan = await vectorPlan(kind, input, existing);
    try {
      return inTransaction(database, () => {
        const row = existing === null
          ? repository.createManageWriteItem(kind, input, timestamp(now))
          : repository.updateManageWriteItem(kind, id, input, timestamp(now));
        for (const entry of plan.deleted) deleteVectorEntry(database, entry.kind, entry.id);
        for (const entry of plan.prepared) {
          upsertVectorEntry(database, entry.kind, entry.id ?? row.id, entry.value.vector, { expectedModel: entry.value.embedding_model });
        }
        return row;
      });
    } catch (error) {
      if (duplicateError(error)) throw new ApplicationError('DUPLICATE_RESOURCE', `${kind} name already exists in its relation scope`);
      throw error;
    }
  }

  return Object.freeze({
    get,
    create: (kind, input) => write(kind, null, input),
    update: (kind, id, input) => write(kind, id, input)
  });
}
