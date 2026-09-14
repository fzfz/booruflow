import { chmodSync, existsSync, lstatSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRANSACTION_STATE,
  hasTransactionState,
  markTransactionState,
  preserveTransactionEvidence,
  transactionStateOf
} from '../transaction-state.mjs';

export const STYLE_SCHEMA_MIGRATION_VERSION = 15;
export const STYLE_SCHEMA_MIGRATION_NAME = '015-style-base-model';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const defaultRepositoryRoot = resolve(moduleDirectory, '../..');
const STYLE_TARGET_IDS = Object.freeze([12237, 12245]);

const defaultFileSystem = Object.freeze({ existsSync, lstatSync, readFileSync, statSync, chmodSync, unlinkSync, writeFileSync });

function resolveFileSystem(fileSystem) {
  if (fileSystem === null || fileSystem === undefined) return defaultFileSystem;
  if (typeof fileSystem !== 'object' || Array.isArray(fileSystem)) throw new TypeError('fileSystem must be an object');
  const resolved = { ...defaultFileSystem, ...fileSystem };
  for (const name of Object.keys(defaultFileSystem)) {
    if (typeof resolved[name] !== 'function') throw new TypeError(`fileSystem.${name} must be a function`);
  }
  return Object.freeze(resolved);
}

export class StyleSchemaMigrationError extends Error {
  constructor(message, { phase = 'migration', failures = [], pending = [], controlFailures = [], transactionState = null } = {}) {
    super(message);
    this.name = 'StyleSchemaMigrationError';
    this.phase = phase;
    this.failures = Object.freeze([...failures]);
    this.pending = Object.freeze([...pending]);
    this.controlFailures = Object.freeze([...controlFailures]);
    if (transactionState !== null) markTransactionState(this, transactionState);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorFailures(error) {
  return error instanceof StyleSchemaMigrationError && error.failures.length > 0
    ? error.failures
    : [{ message: errorMessage(error) }];
}

function combineMigrationErrors(primary, controls, { phase, pending = [], transactionState = null } = {}) {
  const inheritedControlFailures = primary instanceof StyleSchemaMigrationError ? primary.controlFailures : [];
  const controlFailures = [
    ...inheritedControlFailures,
    ...controls.flatMap(({ operation, error }) => [
    {
      code: `${operation}_FAILED`,
      operation,
      message: errorMessage(error)
    },
    ...(error instanceof StyleSchemaMigrationError ? error.failures : [])
    ])
  ];
  const failures = [...errorFailures(primary), ...controlFailures];
  const stateMessage = transactionState === TRANSACTION_STATE.UNCERTAIN
    ? 'transaction state uncertain'
    : transactionState === TRANSACTION_STATE.ROLLED_BACK ? 'transaction rolled back' : null;
  const message = [errorMessage(primary), ...controlFailures.map(({ operation, message: detail }) => `${operation} failed: ${detail}`), stateMessage].filter(Boolean).join('; ');
  const combined = new StyleSchemaMigrationError(message, {
    phase,
    failures,
    pending,
    controlFailures,
    transactionState
  });
  if (transactionState === null) return combined;
  const rollbackError = controls.find(({ operation }) => operation === 'ROLLBACK')?.error ?? primary?.rollbackError;
  return preserveTransactionEvidence(combined, {
    originalError: primary?.originalError ?? primary,
    ...(rollbackError === undefined ? {} : { rollbackError })
  });
}

function tableExists(database, name) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function styleColumns(database) {
  return database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name);
}

function migrationApplied(database) {
  return tableExists(database, 'schema_migrations')
    && database.prepare('SELECT 1 FROM schema_migrations WHERE version = ? AND name = ? LIMIT 1')
      .get(STYLE_SCHEMA_MIGRATION_VERSION, STYLE_SCHEMA_MIGRATION_NAME) !== undefined;
}

function styleTargetAlreadyExists(database) {
  return JSON.stringify(styleColumns(database)) === JSON.stringify([
    'id', 'base_model_id', 'name', 'aliases_json', 'prompt_text', 'style_description', 'cover_media_path'
  ]);
}

function requireDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database is required');
  }
}

function readBaseModels(database, styleCount) {
  const rows = database.prepare("SELECT id, name FROM generation_base_models WHERE name IN ('anima', 'wai') ORDER BY name, id").all();
  const byName = new Map();
  for (const row of rows) {
    const existing = byName.get(row.name) ?? [];
    existing.push(row);
    byName.set(row.name, existing);
  }
  if (styleCount === 0) return byName;
  const missing = ['anima', 'wai'].filter((name) => !byName.has(name));
  const duplicate = ['anima', 'wai'].filter((name) => (byName.get(name)?.length ?? 0) !== 1);
  if (missing.length > 0 || duplicate.length > 0) {
    throw new StyleSchemaMigrationError('styles migration requires exactly one anima and one wai generation base model', {
      phase: 'preflight',
      failures: [{ code: 'BASE_MODEL_MAPPING', missing, duplicate }]
    });
  }
  return byName;
}

function assertLegacyStyleRow(row) {
  if (row.source_version !== 'ANIMA' || row.name !== 'kanzarin' || row.prompt_text !== '@k4nz4r1n') {
    throw new StyleSchemaMigrationError(`style id ${row.id} is not the confirmed Anima kanzarin duplicate`, {
      phase: 'preflight',
      failures: [{ code: 'DUPLICATE_IDENTITY', id: row.id, observed: { source_version: row.source_version, name: row.name, prompt_text: row.prompt_text } }]
    });
  }
}

function assertLegacyStyleRowOgipote(row) {
  if (row.source_version !== 'ANIMA' || row.name !== 'ogipote' || row.prompt_text !== '@ogipote') {
    throw new StyleSchemaMigrationError(`style id ${row.id} is not the confirmed Anima ogipote duplicate`, {
      phase: 'preflight',
      failures: [{ code: 'DUPLICATE_IDENTITY', id: row.id, observed: { source_version: row.source_version, name: row.name, prompt_text: row.prompt_text } }]
    });
  }
}

function assertRetainedStyle(database, id, name, promptText) {
  const row = database.prepare('SELECT id, source_version, name, prompt_text FROM styles WHERE id = ?').get(id);
  if (!row || row.source_version !== 'ANIMA' || row.name !== name || row.prompt_text !== promptText) {
    throw new StyleSchemaMigrationError(`style id ${id} does not match the confirmed retained ${name} record`, {
      phase: 'preflight',
      failures: [{ code: row ? 'RETAINED_IDENTITY' : 'RETAINED_MISSING', id, observed: row ? { source_version: row.source_version, name: row.name, prompt_text: row.prompt_text } : null }]
    });
  }
}

function assertNoUnexpectedDuplicateNames(database) {
  const duplicateRows = database.prepare(`
    SELECT source_version, name, GROUP_CONCAT(id) AS ids, COUNT(*) AS count
    FROM styles
    WHERE source_version IS NOT NULL
    GROUP BY source_version, name COLLATE BINARY
    HAVING COUNT(*) > 1
  `).all();
  for (const row of duplicateRows) {
    const ids = String(row.ids).split(',').map(Number).sort((left, right) => left - right);
    const allowed = row.source_version === 'ANIMA'
      && ((ids.length === 2 && ids.includes(12237) && ids.includes(8339)) || (ids.length === 2 && ids.includes(12245) && ids.includes(10013)));
    if (!allowed) {
      throw new StyleSchemaMigrationError(`unexpected duplicate style name ${row.source_version}:${row.name}`, {
        phase: 'preflight',
        failures: [{ code: 'DUPLICATE_NAME', source_version: row.source_version, name: row.name, ids }]
      });
    }
  }
}

function runPreflight(database) {
  if (!tableExists(database, 'styles')) throw new StyleSchemaMigrationError('styles table is missing', { phase: 'preflight' });
  const columns = styleColumns(database);
  if (!columns.includes('source_version')) {
    if (styleTargetAlreadyExists(database)) return { alreadyTarget: true, nullRows: [], cleanupTargets: [] };
    throw new StyleSchemaMigrationError('styles table is neither the legacy nor the target structure', { phase: 'preflight' });
  }
  const stylesCount = database.prepare('SELECT COUNT(*) AS count FROM styles').get().count;
  const baseModels = readBaseModels(database, stylesCount);
  const nullRows = database.prepare('SELECT id, name FROM styles WHERE source_version IS NULL ORDER BY id').all();
  const duplicateRows = new Map();
  const targetFailures = new Map();
  for (const id of STYLE_TARGET_IDS) {
    const row = database.prepare('SELECT id, source_version, name, prompt_text FROM styles WHERE id = ?').get(id);
    if (!row) continue;
    try {
      if (id === 12237) {
        assertLegacyStyleRow(row);
        assertRetainedStyle(database, 8339, 'kanzarin', 'kanzarin');
      } else {
        assertLegacyStyleRowOgipote(row);
        assertRetainedStyle(database, 10013, 'ogipote', 'ogipote');
      }
    } catch (error) {
      targetFailures.set(id, error);
    }
    duplicateRows.set(id, row);
  }
  const invalidVersions = database.prepare("SELECT id, source_version FROM styles WHERE source_version IS NOT NULL AND source_version NOT IN ('ANIMA', 'WAI') ORDER BY id").all();
  if (invalidVersions.length > 0) {
    throw new StyleSchemaMigrationError('styles.source_version contains an unsupported value', {
      phase: 'preflight',
      failures: [{ code: 'SOURCE_VERSION', rows: invalidVersions }]
    });
  }
  assertNoUnexpectedDuplicateNames(database);
  return {
    alreadyTarget: false,
    baseModels,
    nullRows,
    cleanupTargets: [...nullRows.map(({ id }) => ({ id, reason: 'source_version_null' })), ...STYLE_TARGET_IDS.map((id) => ({ id, reason: 'confirmed_duplicate' }))]
      .filter(({ id }, index, all) => all.findIndex((target) => target.id === id) === index),
    duplicateRows,
    targetFailures
  };
}

function lstatIfPresent(path, fileSystem) {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw mediaError(`style media path is unavailable: ${path}`, 'MEDIA_PATH', path, { message: error.message });
  }
}

function mediaError(message, code, path, extra = {}) {
  return new StyleSchemaMigrationError(message, {
    phase: 'cleanup',
    failures: [{ code, path, ...extra }]
  });
}

function assertMediaRoot(mediaRoot, fileSystem) {
  if (typeof mediaRoot !== 'string' || mediaRoot.length === 0) {
    throw new StyleSchemaMigrationError('mediaRoot is required to delete style media', { phase: 'cleanup' });
  }
  const root = resolve(mediaRoot);
  const stat = lstatIfPresent(root, fileSystem);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw mediaError('style mediaRoot must be a non-symlink directory', 'MEDIA_ROOT', root);
  }
  return root;
}

function assertMediaPathComponents(mediaRoot, target, fileSystem) {
  const root = resolve(mediaRoot);
  const resolvedTarget = resolve(target);
  const pathFromRoot = relative(root, resolvedTarget);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw mediaError('style media path escapes mediaRoot', 'MEDIA_PATH', resolvedTarget);
  }
  let current = root;
  const components = pathFromRoot === '' ? [] : pathFromRoot.split(sep);
  for (const component of components) {
    current = resolve(current, component);
    const stat = lstatIfPresent(current, fileSystem);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw mediaError('style media path contains a symbolic link', 'MEDIA_PATH_SYMLINK', current);
    if (current !== resolvedTarget && !stat.isDirectory()) {
      throw mediaError('style media path contains a non-directory component', 'MEDIA_PATH', current);
    }
  }
}

function mediaTarget(mediaRoot, mediaPath, fileSystem = defaultFileSystem) {
  if (typeof mediaPath !== 'string' || mediaPath.length === 0) throw new StyleSchemaMigrationError('style image is missing media_path', { phase: 'cleanup' });
  if (mediaPath.includes('\\') || mediaPath.includes('\u0000') || mediaPath.startsWith('/') || mediaPath.split('/').some((part) => part === '..' || part === '.' || part.length === 0)) {
    throw new StyleSchemaMigrationError(`style image media path is invalid: ${mediaPath}`, { phase: 'cleanup' });
  }
  const root = assertMediaRoot(mediaRoot, fileSystem);
  const target = resolve(root, mediaPath);
  const escaped = relative(root, target);
  if (escaped === '' || escaped === '..' || escaped.startsWith(`..${sep}`)) throw new StyleSchemaMigrationError(`style image escapes mediaRoot: ${mediaPath}`, { phase: 'cleanup' });
  assertMediaPathComponents(root, target, fileSystem);
  return target;
}
function stageStyleMedia(database, styleId, mediaRoot, fileSystem) {
  const images = database.prepare("SELECT id, media_path FROM item_images WHERE owner_kind = 'style' AND owner_id = ? ORDER BY id").all(styleId);
  if (images.length === 0) return [];
  const root = assertMediaRoot(mediaRoot, fileSystem);
  return images.map((image) => {
    const source = mediaTarget(root, image.media_path, fileSystem);
    const sourceStat = lstatIfPresent(source, fileSystem);
    if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw mediaError(`style media file is unavailable: ${image.media_path}`, 'MEDIA_FILE', source, {
        style_id: styleId,
        image_id: image.id,
        media_path: image.media_path
      });
    }
    let bytes;
    try {
      bytes = fileSystem.readFileSync(source);
    } catch (error) {
      throw mediaError(`style media file cannot be read: ${image.media_path}`, 'MEDIA_READ', source, {
        style_id: styleId,
        image_id: image.id,
        media_path: image.media_path,
        message: error.message
      });
    }
    return Object.freeze({
      source,
      bytes: Buffer.from(bytes),
      mode: sourceStat.mode & 0o7777,
      styleId,
      imageId: image.id,
      mediaPath: image.media_path
    });
  });
}

function restoreStagedMedia(moved, fileSystem) {
  const failures = [];
  for (const move of [...moved].reverse()) {
    try {
      fileSystem.writeFileSync(move.source, move.bytes, { flag: 'wx', mode: move.mode });
      fileSystem.chmodSync(move.source, move.mode);
      const restoredStat = fileSystem.statSync(move.source);
      const restoredMode = restoredStat.mode & 0o7777;
      if (restoredMode !== move.mode) {
        const error = new Error(`restored media mode ${restoredMode.toString(8)} does not match original ${move.mode.toString(8)}`);
        error.code = 'MEDIA_RESTORE_MODE';
        throw error;
      }
    } catch (error) {
      failures.push({ code: error?.code === 'EEXIST' ? 'MEDIA_RESTORE_CONFLICT' : error?.code === 'MEDIA_RESTORE_MODE' ? 'MEDIA_RESTORE_MODE' : 'MEDIA_RESTORE', path: move.source, message: error.message });
    }
  }
  if (failures.length > 0) {
    throw new StyleSchemaMigrationError('style media rollback failed', { phase: 'cleanup', failures });
  }
}

function deleteCleanupTarget(database, target, mediaRoot, fileSystem) {
  const row = database.prepare('SELECT id FROM styles WHERE id = ?').get(target.id);
  if (!row) return { id: target.id, reason: target.reason, status: 'already_absent' };
  const moved = stageStyleMedia(database, target.id, mediaRoot, fileSystem);
  const deleted = [];
  let committed = false;
  let transactionStarted = false;
  let mediaRestoreAttempted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    try {
      for (const media of moved) {
        try {
          fileSystem.unlinkSync(media.source);
          deleted.push(media);
        } catch (error) {
          throw mediaError(`style media file cannot be deleted: ${media.mediaPath}`, 'MEDIA_UNLINK', media.source, {
            style_id: media.styleId,
            image_id: media.imageId,
            media_path: media.mediaPath,
            message: error.message
          });
        }
      }
      database.prepare('UPDATE styles SET cover_media_path = NULL WHERE id = ?').run(target.id);
      if (tableExists(database, 'session_style_selections')) {
        database.prepare('DELETE FROM session_style_selections WHERE style_id = ?').run(target.id);
      }
      if (tableExists(database, 'artist_prompt_string_styles')) {
        database.prepare('DELETE FROM artist_prompt_string_styles WHERE style_id = ?').run(target.id);
      }
      if (tableExists(database, 'item_images')) {
        database.prepare("DELETE FROM item_images WHERE owner_kind = 'style' AND owner_id = ?").run(target.id);
      }
      if (tableExists(database, 'vector_entries')) {
        database.prepare("DELETE FROM vector_entries WHERE object_kind = 'style' AND object_id = ?").run(target.id);
      }
      database.prepare('DELETE FROM styles WHERE id = ?').run(target.id);
      database.exec('COMMIT;');
      committed = true;
    } catch (error) {
      if (transactionStarted && !committed) {
        try {
          database.exec('ROLLBACK;');
        } catch (rollbackError) {
          const rollbackFailure = combineMigrationErrors(error, [{ operation: 'ROLLBACK', error: rollbackError }], {
            phase: 'cleanup',
            transactionState: TRANSACTION_STATE.UNCERTAIN
          });
          if (deleted.length > 0) {
            mediaRestoreAttempted = true;
            try {
              restoreStagedMedia(deleted, fileSystem);
            } catch (restoreError) {
              throw combineMigrationErrors(rollbackFailure, [{ operation: 'MEDIA_RESTORE', error: restoreError }], {
                phase: 'cleanup',
                transactionState: TRANSACTION_STATE.UNCERTAIN
              });
            }
          }
          throw rollbackFailure;
        }
      }
      throw error;
    }
    return { id: target.id, reason: target.reason, status: 'deleted' };
  } catch (error) {
    if (!committed && deleted.length > 0 && !mediaRestoreAttempted) {
      mediaRestoreAttempted = true;
      try {
        restoreStagedMedia(deleted, fileSystem);
      } catch (restoreError) {
        throw combineMigrationErrors(error, [{ operation: 'MEDIA_RESTORE', error: restoreError }], {
          phase: 'cleanup',
          transactionState: transactionStateOf(error)
        });
      }
    }
    throw error instanceof StyleSchemaMigrationError
      ? error
      : new StyleSchemaMigrationError(`style cleanup failed: ${error.message}`, {
        phase: 'cleanup',
        failures: [{ id: target.id, reason: target.reason, message: error.message }]
      });
  }
}

function stripMigrationTransactionControl(sql) {
  return sql.replace(/^\s*(?:PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF)|BEGIN(?:\s+IMMEDIATE)?|COMMIT|ROLLBACK)\s*;\s*$/gimu, '');
}

function applyStyleTargetSchema(database, repositoryRoot, readMigrationSql = null, fileSystem) {
  const migrationPath = resolve(repositoryRoot, 'schema/database/015-style-base-model.sql');
  if (!fileSystem.existsSync(migrationPath)) throw new StyleSchemaMigrationError(`style migration SQL is missing: ${migrationPath}`, { phase: 'migration' });
  const originalForeignKeys = database.prepare('PRAGMA foreign_keys').get().foreign_keys;
  let primaryError = null;
  const controlErrors = [];
  let transactionStarted = false;
  let transactionCommitted = false;
  let transactionRolledBack = false;
  let result;
  try {
    const sql = typeof readMigrationSql === 'function' ? readMigrationSql(migrationPath) : fileSystem.readFileSync(migrationPath, 'utf8');
    if (typeof sql !== 'string' || sql.length === 0) throw new StyleSchemaMigrationError('style migration SQL is empty', { phase: 'migration' });
    database.exec('PRAGMA foreign_keys = OFF;');
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    database.exec(stripMigrationTransactionControl(sql));
    const foreignKeyProblems = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyProblems.length > 0) throw new StyleSchemaMigrationError('style migration produced foreign-key violations', { phase: 'migration', failures: foreignKeyProblems });
    const integrity = database.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') throw new StyleSchemaMigrationError('style migration failed SQLite integrity_check', { phase: 'migration', failures: [integrity] });
    database.exec('COMMIT;');
    transactionCommitted = true;
    result = undefined;
  } catch (error) {
    primaryError = error instanceof StyleSchemaMigrationError
      ? error
      : new StyleSchemaMigrationError(`style migration failed: ${errorMessage(error)}`, { phase: 'migration', failures: [{ message: errorMessage(error) }] });
    if (transactionStarted && !transactionCommitted) {
      try {
        database.exec('ROLLBACK;');
        transactionRolledBack = true;
      } catch (rollbackError) {
        controlErrors.push({ operation: 'ROLLBACK', error: rollbackError });
      }
    }
  }
  try {
    database.exec(`PRAGMA foreign_keys = ${originalForeignKeys ? 'ON' : 'OFF'};`);
  } catch (foreignKeysError) {
    controlErrors.push({ operation: 'FOREIGN_KEYS_RESTORE', error: foreignKeysError });
  }
  if (primaryError || controlErrors.length > 0) {
    if (controlErrors.length === 0) {
      if (primaryError && transactionRolledBack) {
        throw new StyleSchemaMigrationError(`${errorMessage(primaryError)}; transaction rolled back`, {
          phase: primaryError.phase,
          failures: primaryError.failures,
          transactionState: TRANSACTION_STATE.ROLLED_BACK
        });
      }
      throw primaryError;
    }
    throw combineMigrationErrors(primaryError ?? new StyleSchemaMigrationError('style migration control failed', { phase: 'migration' }), controlErrors, {
      phase: 'migration',
      transactionState: controlErrors.some(({ operation }) => operation === 'ROLLBACK')
        ? TRANSACTION_STATE.UNCERTAIN
        : transactionRolledBack ? TRANSACTION_STATE.ROLLED_BACK : null
    });
  }
  return result;
}

export function migrateStylesToBaseModel({ database, mediaRoot = null, repositoryRoot = defaultRepositoryRoot, readMigrationSql = null, fileSystem = null, onCleanupComplete = null } = {}) {
  requireDatabase(database);
  if (onCleanupComplete !== null && typeof onCleanupComplete !== 'function') throw new TypeError('onCleanupComplete must be a function or null');
  const resolvedFileSystem = resolveFileSystem(fileSystem);
  if (migrationApplied(database)) return Object.freeze({ status: 'already_applied', migrated: false, cleanup: [] });
  const originalForeignKeys = database.prepare('PRAGMA foreign_keys').get().foreign_keys;
  let result;
  let primaryError = null;
  const controlErrors = [];
  try {
    // Cleanup must run with SQLite foreign-key actions enabled. Some callers open
    // a raw DatabaseSync connection whose default is OFF.
    database.exec('PRAGMA foreign_keys = ON;');
    const preflight = runPreflight(database);
    if (preflight.alreadyTarget) throw new StyleSchemaMigrationError('styles target structure exists without migration ledger entry', { phase: 'preflight' });
    const cleanup = [];
    const failures = [];
    const cleanupControlFailures = [];
    let uncertainTransactionError = null;
    for (const target of preflight.cleanupTargets) {
      const targetFailure = preflight.targetFailures.get(target.id);
      if (targetFailure) {
        failures.push({ id: target.id, reason: target.reason, message: targetFailure.message, failures: targetFailure.failures });
        continue;
      }
      try {
        cleanup.push(deleteCleanupTarget(database, target, mediaRoot, resolvedFileSystem));
      } catch (error) {
        failures.push({ id: target.id, reason: target.reason, message: errorMessage(error), failures: error.failures ?? [] });
        cleanupControlFailures.push(...(error.controlFailures ?? []));
        if (hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN)) {
          uncertainTransactionError = error;
          break;
        }
      }
    }
    const pending = preflight.cleanupTargets.filter(({ id }) => database.prepare('SELECT 1 FROM styles WHERE id = ?').get(id) !== undefined);
    const nullPending = database.prepare('SELECT id FROM styles WHERE source_version IS NULL ORDER BY id').all().map(({ id }) => id);
    if (uncertainTransactionError !== null || pending.length > 0 || nullPending.length > 0 || failures.length > 0) {
      const controlSummary = cleanupControlFailures.length === 0
        ? ''
        : `; ${cleanupControlFailures.map(({ operation, message }) => `${operation} failed: ${message}`).join('; ')}`;
      const incompleteError = new StyleSchemaMigrationError(`style cleanup is incomplete; styles table migration is blocked${controlSummary}`, {
        phase: 'cleanup',
        failures,
        pending: [...new Set([...pending.map(({ id }) => id), ...nullPending])],
        controlFailures: cleanupControlFailures,
        transactionState: uncertainTransactionError === null ? null : TRANSACTION_STATE.UNCERTAIN
      });
      if (uncertainTransactionError === null) throw incompleteError;
      throw preserveTransactionEvidence(incompleteError, {
        originalError: uncertainTransactionError.originalError ?? uncertainTransactionError,
        ...(uncertainTransactionError.rollbackError === undefined ? {} : { rollbackError: uncertainTransactionError.rollbackError })
      });
    }
    onCleanupComplete?.(Object.freeze({ cleanup: Object.freeze(cleanup) }));
    applyStyleTargetSchema(database, repositoryRoot, readMigrationSql, resolvedFileSystem);
    result = Object.freeze({ status: 'complete', migrated: true, cleanup: Object.freeze(cleanup) });
  } catch (error) {
    primaryError = error instanceof StyleSchemaMigrationError
      ? error
      : new StyleSchemaMigrationError(`style migration failed: ${errorMessage(error)}`, { phase: 'migration', failures: [{ message: errorMessage(error) }] });
  }
  try {
    database.exec(`PRAGMA foreign_keys = ${originalForeignKeys ? 'ON' : 'OFF'};`);
  } catch (foreignKeysError) {
    controlErrors.push({ operation: 'FOREIGN_KEYS_RESTORE', error: foreignKeysError });
  }
  if (primaryError || controlErrors.length > 0) {
    if (controlErrors.length === 0) throw primaryError;
    throw combineMigrationErrors(primaryError ?? new StyleSchemaMigrationError('style migration control failed', { phase: 'migration' }), controlErrors, {
      phase: primaryError?.phase ?? 'migration',
      pending: primaryError?.pending ?? [],
      transactionState: transactionStateOf(primaryError)
    });
  }
  return result;
}
