import { inTransaction } from '../catalog/database.mjs';
import { cleanupMediaPathsAfterCommit } from '../maintenance/maintenance-service.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, validateArtistPromptStringListQuery, validateArtistPromptStringWrite } from '../security/input-validation.mjs';
import { deleteVectorEntry, upsertVectorEntry } from '../vector/vector-store.mjs';
import { impactTokensMatch } from './base-model-repository.mjs';
import { targetMatchesSnapshot } from './write-snapshot.mjs';

const VECTOR_OBJECT_KIND = 'artist_prompt_string';
const TARGET_FIELDS = Object.freeze([
  'id',
  'title',
  'description',
  'artist_string',
  'base_model_id',
  'style_ids',
  'created_at'
]);

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('now must return a valid Date');
  return value.toISOString();
}

function isDuplicateConstraint(error) {
  return /UNIQUE constraint failed: artist_prompt_strings\.title/u.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
}

export function createArtistPromptStringService({ database, repository, mediaStorage, cleanupQueue, vectorMaintenance, now = () => new Date() }) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new TypeError('database must provide prepare and exec transaction methods');
  if (!repository || ['list', 'get', 'baseModelExists', 'styleExists', 'create', 'update', 'replaceStyleIds', 'getImpact', 'remove'].some((name) => typeof repository[name] !== 'function')) {
    throw new TypeError('artist prompt string repository is incomplete');
  }
  if (!mediaStorage || typeof mediaStorage.remove !== 'function') throw new TypeError('mediaStorage must provide remove');
  if (!cleanupQueue || typeof cleanupQueue.enqueue !== 'function' || typeof cleanupQueue.recordFailure !== 'function') throw new TypeError('cleanupQueue must provide enqueue and recordFailure');
  if (!vectorMaintenance || typeof vectorMaintenance.prepare !== 'function') throw new TypeError('artist prompt string vector maintenance must provide prepare');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function read(id) {
    assertIdentifier(id, 'id');
    const artist = repository.get(id);
    if (!artist) throw new ApplicationError('NOT_FOUND', 'artist prompt string was not found');
    return artist;
  }

  function assertRelations({ base_model_id: baseModelId, style_ids: styleIds }) {
    if (baseModelId !== null && !repository.baseModelExists(baseModelId)) {
      throw new ApplicationError('RELATION_CONFLICT', 'base model was not found');
    }
    for (const styleId of styleIds) {
      if (!repository.styleExists(styleId)) throw new ApplicationError('RELATION_CONFLICT', 'style was not found');
    }
  }

  async function write(id, input) {
    const request = validateArtistPromptStringWrite(input);
    const changedAt = timestamp(now);
    let targetSnapshot = null;
    if (id !== null) {
      assertIdentifier(id, 'id');
      targetSnapshot = read(id);
    }
    assertRelations(request);
    const prepared = await vectorMaintenance.prepare(request);
    try {
      return inTransaction(database, () => {
        if (id !== null) {
          const current = repository.get(id);
          if (!current) throw new ApplicationError('NOT_FOUND', 'artist prompt string was not found');
          if (!targetMatchesSnapshot(targetSnapshot, current, TARGET_FIELDS)) {
            throw new ApplicationError('RELATION_CONFLICT', 'artist prompt string changed while its embedding was prepared');
          }
        }
        assertRelations(request);
        const artistId = id === null
          ? repository.create({ ...request, timestamp: changedAt })
          : (repository.update({ id, ...request, timestamp: changedAt }), id);
        repository.replaceStyleIds(artistId, request.style_ids);
        upsertVectorEntry(database, VECTOR_OBJECT_KIND, artistId, prepared.vector, { expectedModel: prepared.embedding_model });
        return read(artistId);
      });
    } catch (error) {
      if (isDuplicateConstraint(error)) throw new ApplicationError('DUPLICATE_RESOURCE', 'artist prompt string title already exists');
      throw error;
    }
  }

  return Object.freeze({
    list: (input) => repository.list(validateArtistPromptStringListQuery(input)),
    create: (input) => write(null, input),
    get: read,
    update: (id, input) => write(id, input),
    getDeleteImpact(id) {
      assertIdentifier(id, 'id');
      const impact = repository.getImpact(id);
      if (!impact) throw new ApplicationError('NOT_FOUND', 'artist prompt string was not found');
      return impact;
    },
    delete(id, impactToken) {
      assertIdentifier(id, 'id');
      const deleted = inTransaction(database, () => {
        const impact = repository.getImpact(id);
        if (!impact) throw new ApplicationError('NOT_FOUND', 'artist prompt string was not found');
        if (!impactTokensMatch(impactToken, impact.impact_token)) throw new ApplicationError('DELETE_IMPACT_STALE', 'artist prompt string delete impact has changed');
        deleteVectorEntry(database, VECTOR_OBJECT_KIND, id);
        repository.remove(id);
        return Object.freeze({ target: impact.target, cascade_deleted: impact.cascade_deleted, retained: impact.retained });
      });
      const mediaPaths = deleted.cascade_deleted.filter((item) => item.kind === 'image' && typeof item.media_path === 'string').map((item) => item.media_path);
      return Object.freeze({ ...deleted, ...cleanupMediaPathsAfterCommit(mediaStorage, mediaPaths, cleanupQueue, 'owner_delete') });
    }
  });
}
