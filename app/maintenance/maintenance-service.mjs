import { inTransaction } from '../catalog/database.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, assertItemKind, assertMediaOwnerKind, InputValidationError, validateBatchDelete, validateCoverSelection, validateImageOrder } from '../security/input-validation.mjs';
import { deleteVectorEntry } from '../vector/vector-store.mjs';

function utc(now) {
  return now().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

const MEDIA_OWNER_TABLES = Object.freeze({ work: 'works', character: 'characters', style: 'styles', model: 'generation_models', lora: 'generation_loras', artist_prompt_string: 'artist_prompt_strings', template: 'comfyui_templates' });

function tableFor(kind) {
  return MEDIA_OWNER_TABLES[kind] ?? null;
}

function validateMediaRequest(validator, input) {
  try {
    return validator(input);
  } catch (error) {
    if (error instanceof InputValidationError) throw new ApplicationError('VALIDATION_ERROR', error.message);
    throw error;
  }
}

function missingImageError(kind, message) {
  return new ApplicationError(kind === 'model' || kind === 'lora' || kind === 'artist_prompt_string' || kind === 'template' ? 'NOT_FOUND' : 'ITEM_UNAVAILABLE', message);
}

function assertOwner(database, kind, id) {
  const availability = kind === 'work' || kind === 'character' ? ', is_available' : '';
  const owner = database.prepare(`SELECT id, cover_media_path${availability} FROM ${tableFor(kind)} WHERE id = ?`).get(id);
  if (!owner) throw new ApplicationError('NOT_FOUND', `${kind} was not found`);
  if (availability !== '' && owner.is_available === 0) throw new ApplicationError('ITEM_UNAVAILABLE', `${kind} is unavailable`);
  return owner;
}

function listImageRows(database, kind, id) {
  return database.prepare(`
    SELECT id, owner_kind, owner_id, content_hash, media_path, sort_order
    FROM item_images
    WHERE owner_kind = ? AND owner_id = ?
    ORDER BY sort_order, id
  `).all(kind, id);
}

function fallbackCoverPath(database, kind, itemId, { deletedImageId = null, deletedCharacterId = null } = {}) {
  if (kind === 'work') {
    const excludedCharacter = deletedCharacterId === null ? '' : 'AND c.id <> ?';
    const excludedImage = deletedImageId === null ? '' : 'AND i.id <> ?';
    return database.prepare(`
      SELECT i.media_path
      FROM characters c
      JOIN item_images i ON i.owner_kind = 'character' AND i.owner_id = c.id
      WHERE c.work_id = ? ${excludedCharacter} ${excludedImage}
      ORDER BY c.name_normalized COLLATE BINARY, c.id, i.sort_order, i.id
      LIMIT 1
    `).get(itemId, ...(deletedCharacterId === null ? [] : [deletedCharacterId]), ...(deletedImageId === null ? [] : [deletedImageId]))?.media_path ?? null;
  }
  return listImageRows(database, kind, itemId)
    .find((image) => image.id !== deletedImageId)?.media_path ?? null;
}

function coverReferences(database, mediaPath) {
  return [
    ['work', database.prepare('SELECT id FROM works WHERE cover_media_path = ?').all(mediaPath)],
    ['character', database.prepare('SELECT id FROM characters WHERE cover_media_path = ?').all(mediaPath)],
    ['style', database.prepare('SELECT id FROM styles WHERE cover_media_path = ?').all(mediaPath)],
    ['model', database.prepare('SELECT id FROM generation_models WHERE cover_media_path = ?').all(mediaPath)],
    ['lora', database.prepare('SELECT id FROM generation_loras WHERE cover_media_path = ?').all(mediaPath)],
    ['artist_prompt_string', database.prepare('SELECT id FROM artist_prompt_strings WHERE cover_media_path = ?').all(mediaPath)],
    ['template', database.prepare('SELECT id FROM comfyui_templates WHERE cover_media_path = ?').all(mediaPath)]
  ].flatMap(([kind, rows]) => rows.map(({ id }) => ({ kind, id })));
}

function normalizeSortOrders(database, kind, id, rows) {
  if (rows.length === 0) return;
  const maximum = Math.max(...rows.map((row) => row.sort_order));
  database.prepare('UPDATE item_images SET sort_order = sort_order + ? WHERE owner_kind = ? AND owner_id = ?').run(maximum + rows.length + 1, kind, id);
  const update = database.prepare('UPDATE item_images SET sort_order = ? WHERE id = ?');
  rows.forEach((row, index) => update.run(index, row.id));
}

function updateCover(database, kind, id, mediaPath, timestamp) {
  if (kind === 'style') {
    database.prepare('UPDATE styles SET cover_media_path = ? WHERE id = ?').run(mediaPath, id);
    return;
  }
  database.prepare(`UPDATE ${tableFor(kind)} SET cover_media_path = ?, updated_at = ? WHERE id = ?`).run(mediaPath, timestamp, id);
}

function cleanupFailure(path, reason, removeError, enqueueError) {
  return Object.freeze({
    path,
    reason,
    occurred_at: new Date().toISOString(),
    remove_error: String(removeError?.message ?? removeError).slice(0, 1024),
    enqueue_error: String(enqueueError?.message ?? enqueueError).slice(0, 1024)
  });
}

export function cleanupMediaPathsAfterCommit(mediaStorage, paths, cleanupQueue, reason) {
  let cleanupWarning = false;
  const failures = [];
  for (const path of paths) {
    try {
      mediaStorage.remove(path);
    } catch (removeError) {
      cleanupWarning = true;
      try {
        cleanupQueue?.enqueue({ path, reason, error: removeError?.message ?? removeError });
      } catch (enqueueError) {
        const failure = cleanupFailure(path, reason, removeError, enqueueError);
        try {
          failures.push(cleanupQueue.recordFailure({ path, reason, ...failure }));
        } catch (auditError) {
          failures.push(Object.freeze({ ...failure, audit_error: String(auditError?.message ?? auditError).slice(0, 1024) }));
        }
      }
    }
  }
  return Object.freeze({ cleanup_warning: cleanupWarning, cleanup_failures: Object.freeze(failures) });
}

export function removeMediaPathsAfterCommit(mediaStorage, paths, cleanupQueue, reason) {
  return cleanupMediaPathsAfterCommit(mediaStorage, paths, cleanupQueue, reason).cleanup_warning;
}

export function createMaintenanceService({ database, mediaStorage, cleanupQueue = null, now = () => new Date() } = {}) {
  if (!database || typeof database.prepare !== 'function') throw new Error('database is required');
  if (!mediaStorage) throw new Error('mediaStorage is required');
  if (cleanupQueue !== null && typeof cleanupQueue.enqueue !== 'function') throw new Error('cleanupQueue must provide enqueue');

  function assertKindAndId(kind, itemId) {
    assertMediaOwnerKind(kind);
    assertIdentifier(itemId, 'item_id');
  }

  function snapshot(kind, itemId, { cleanupWarning = false } = {}) {
    assertKindAndId(kind, itemId);
    const owner = assertOwner(database, kind, itemId);
    const images = listImageRows(database, kind, itemId)
      .map((row) => Object.freeze({ id: row.id, media_path: row.media_path, sort_order: row.sort_order }));
    return Object.freeze({
      owner_kind: kind,
      owner_id: itemId,
      cover_media_path: owner.cover_media_path ?? null,
      images: Object.freeze(images),
      cleanup_warning: cleanupWarning
    });
  }

  function listImages(kind, itemId) {
    return snapshot(kind, itemId);
  }

  function uploadImages(kind, itemId, files) {
    assertKindAndId(kind, itemId);
    assertOwner(database, kind, itemId);
    if (kind === 'template' && (!Array.isArray(files) || files.length !== 1)) {
      throw new ApplicationError('VALIDATION_ERROR', 'template cover upload must contain exactly one file');
    }
    const staged = mediaStorage.stageFiles(files);
    const timestamp = utc(now);
    try {
      inTransaction(database, () => {
        if (kind === 'template' && database.prepare("SELECT 1 FROM item_images WHERE owner_kind = 'template' AND owner_id = ? LIMIT 1").get(itemId)) {
          throw new ApplicationError('DUPLICATE_RESOURCE', 'template already has a cover image');
        }
        const sort = database.prepare('SELECT COALESCE(MAX(sort_order), -1) AS maximum FROM item_images WHERE owner_kind = ? AND owner_id = ?').get(kind, itemId).maximum;
        const insert = database.prepare(`
          INSERT INTO item_images(owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at)
          VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)
        `);
        staged.forEach((entry, index) => {
          insert.run(kind, itemId, entry.content_hash, entry.media_path, sort + index + 1, timestamp, timestamp);
        });
        if (kind === 'template') {
          database.prepare('UPDATE comfyui_templates SET cover_media_path = ?, updated_at = ? WHERE id = ?').run(staged[0].media_path, timestamp, itemId);
        }
        mediaStorage.commit(staged);
      });
      return snapshot(kind, itemId);
    } catch (error) {
      mediaStorage.discard(staged);
      throw error;
    }
  }

  function reorderImages(kind, itemId, input) {
    assertKindAndId(kind, itemId);
    const { ids: imageIds } = validateMediaRequest(validateImageOrder, input);
    assertOwner(database, kind, itemId);
    inTransaction(database, () => {
      const rows = listImageRows(database, kind, itemId);
      const requested = new Set(imageIds);
      if (rows.length !== imageIds.length || rows.some((row) => !requested.has(row.id))) {
        throw missingImageError(kind, 'every image must belong to the requested item');
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      normalizeSortOrders(database, kind, itemId, imageIds.map((id) => byId.get(id)));
    });
    return snapshot(kind, itemId);
  }

  function setCover(kind, itemId, input) {
    assertKindAndId(kind, itemId);
    const { id: imageId } = validateMediaRequest(validateCoverSelection, input);
    inTransaction(database, () => {
      const owner = assertOwner(database, kind, itemId);
      const image = imageId === null ? null : database.prepare(`
        SELECT id, media_path FROM item_images
        WHERE id = ? AND owner_kind = ? AND owner_id = ?
      `).get(imageId, kind, itemId);
      if (imageId !== null && (!image || typeof image.media_path !== 'string')) throw missingImageError(kind, 'cover image must belong to the requested item and have a media path');
      const coverMediaPath = image?.media_path ?? fallbackCoverPath(database, kind, itemId);
      updateCover(database, kind, owner.id, coverMediaPath, utc(now));
    });
    return snapshot(kind, itemId);
  }

  function getCover(kind, itemId) {
    return Object.freeze({ cover_media_path: snapshot(kind, itemId).cover_media_path });
  }

  function deleteImage(kind, itemId, imageId) {
    assertKindAndId(kind, itemId);
    assertIdentifier(imageId, 'image_id');
    const image = inTransaction(database, () => {
      assertOwner(database, kind, itemId);
      const target = database.prepare(`
        SELECT id, media_path FROM item_images
        WHERE id = ? AND owner_kind = ? AND owner_id = ?
      `).get(imageId, kind, itemId);
      if (!target) throw missingImageError(kind, 'image must belong to the requested item');
      const remaining = listImageRows(database, kind, itemId).filter((row) => row.id !== imageId);
      for (const reference of coverReferences(database, target.media_path)) {
        const nextCoverPath = fallbackCoverPath(database, reference.kind, reference.id, { deletedImageId: imageId });
        updateCover(database, reference.kind, reference.id, nextCoverPath, utc(now));
      }
      database.prepare('DELETE FROM item_images WHERE id = ?').run(imageId);
      normalizeSortOrders(database, kind, itemId, remaining);
      return target;
    });
    return snapshot(kind, itemId, { cleanupWarning: removeMediaPathsAfterCommit(mediaStorage, [image.media_path], cleanupQueue, 'image_delete') });
  }

  function deleteOne(identity) {
    const { kind, id } = identity;
    const table = tableFor(kind);
    const row = database.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new ApplicationError('ITEM_UNAVAILABLE', `${kind} is unavailable`);
    const imageRows = kind === 'work'
      ? database.prepare(`
          SELECT i.media_path
          FROM item_images i
          LEFT JOIN characters c ON c.id = i.owner_id AND i.owner_kind = 'character'
          WHERE (i.owner_kind = 'work' AND i.owner_id = ?)
             OR (i.owner_kind = 'character' AND c.work_id = ?)
        `).all(id, id)
      : listImageRows(database, kind, id);
    if (kind === 'character') {
      const affectedWorks = new Set(imageRows.flatMap(({ media_path: mediaPath }) => database.prepare('SELECT id FROM works WHERE cover_media_path = ?').all(mediaPath).map((work) => work.id)));
      for (const workId of affectedWorks) {
        const nextCoverPath = fallbackCoverPath(database, 'work', workId, { deletedCharacterId: id });
        database.prepare('UPDATE works SET cover_media_path = ?, updated_at = ? WHERE id = ?').run(nextCoverPath, utc(now), workId);
      }
    }
    const deletedCharacterIds = kind === 'work'
      ? database.prepare('SELECT id FROM characters WHERE work_id = ? ORDER BY id').all(id).map((character) => character.id)
      : kind === 'character' ? [id] : [];
    for (const characterId of deletedCharacterIds) deleteVectorEntry(database, 'character', characterId);
    if (kind === 'work') deleteVectorEntry(database, 'work', id);
    if (kind === 'style') deleteVectorEntry(database, 'style', id);
    database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return imageRows.map((image) => image.media_path);
  }

  function batchDelete(input) {
    const { items } = validateBatchDelete(input);
    const { deleted, pathsByItem } = inTransaction(database, () => {
      for (const { kind, id } of items) {
        if (!database.prepare(`SELECT id FROM ${tableFor(kind)} WHERE id = ?`).get(id)) {
          throw new ApplicationError('ITEM_UNAVAILABLE', `${kind} is unavailable`);
        }
      }
      const selectedWorkIds = new Set(items.filter(({ kind }) => kind === 'work').map(({ id }) => id));
      const explicitlySelected = new Set(items.map(({ kind, id }) => `${kind}:${id}`));
      const cascadedCharacters = [...selectedWorkIds]
        .flatMap((workId) => database.prepare('SELECT id FROM characters WHERE work_id = ? ORDER BY id').all(workId)
          .map(({ id }) => Object.freeze({ kind: 'character', id })))
        .filter(({ kind, id }) => !explicitlySelected.has(`${kind}:${id}`));
      const effectiveItems = items.filter((identity) => identity.kind !== 'character'
        || !selectedWorkIds.has(database.prepare('SELECT work_id FROM characters WHERE id = ?').get(identity.id).work_id));
      return Object.freeze({
        deleted: Object.freeze([...items, ...cascadedCharacters].map((identity) => Object.freeze({ ...identity }))),
        pathsByItem: Object.freeze(effectiveItems.map((identity) => Object.freeze({
          identity,
          paths: Object.freeze(deleteOne(identity))
        })))
      });
    });
    const cleanupWarnings = pathsByItem
      .filter(({ paths }) => removeMediaPathsAfterCommit(mediaStorage, paths, cleanupQueue, 'owner_delete'))
      .map(({ identity }) => Object.freeze({ ...identity }));
    return Object.freeze({
      deleted,
      cleanup_warnings: Object.freeze(cleanupWarnings)
    });
  }

  return Object.freeze({ listImages, uploadImages, reorderImages, setCover, getCover, deleteImage, batchDelete });
}
