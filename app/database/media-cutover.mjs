import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { listOrderedMigrations } from './migration-baseline.mjs';
import { CREATE_MEDIA_CUTOVER_PLAN_TABLE_SQL, MEDIA_CUTOVER_NAME, MEDIA_CUTOVER_PLAN_TABLE, MEDIA_CUTOVER_VERSION } from './media-cutover-contract.mjs';
import { STYLE_SCHEMA_MIGRATION_VERSION } from './style-schema-migration.mjs';
import { hasSupportedImageSignature, inspectImage } from '../media/media-storage.mjs';

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);


export class MediaCutoverError extends Error {
  constructor(message, { evidencePath = null, cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'MediaCutoverError';
    this.evidencePath = evidencePath;
  }
}

function isInside(root, target) {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`);
}

function assertRelativeMediaPath(value) {
  if (typeof value !== 'string' || !value.startsWith('images/') || value.includes('\\') || value.includes('\u0000') || value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new MediaCutoverError(`legacy media path is invalid: ${String(value)}`);
  }
  return value;
}

function writeEvidence(path, evidence) {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

function currentVersions(database) {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return [];
  return database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
}

function migrationSql(repositoryRoot) {
  const migration = listOrderedMigrations(resolve(repositoryRoot, 'schema/database')).find(({ version, name }) => version === MEDIA_CUTOVER_VERSION && name === MEDIA_CUTOVER_NAME);
  if (!migration) throw new MediaCutoverError('media cutover migration is missing');
  return readFileSync(migration.path, 'utf8');
}

function applyPreCutoverMigrations(database, repositoryRoot) {
  const migrations = listOrderedMigrations(resolve(repositoryRoot, 'schema/database'));
  const prerequisites = migrations.filter(({ version }) => version < MEDIA_CUTOVER_VERSION);
  const versions = currentVersions(database);
  if (!versions.every((version, index) => prerequisites[index]?.version === version)) {
    throw new MediaCutoverError(`database must contain a contiguous migration prefix before migration ${MEDIA_CUTOVER_VERSION}`);
  }
  for (const migration of prerequisites.slice(versions.length)) database.exec(readFileSync(migration.path, 'utf8'));
}

function applyPostCutoverMigrations(database, repositoryRoot) {
  const migrations = listOrderedMigrations(resolve(repositoryRoot, 'schema/database'));
  for (const migration of migrations.filter(({ version }) => version > MEDIA_CUTOVER_VERSION)) {
    const versions = currentVersions(database);
    if (migration.version === STYLE_SCHEMA_MIGRATION_VERSION && !versions.includes(STYLE_SCHEMA_MIGRATION_VERSION)) break;
    if (!versions.includes(migration.version)) database.exec(readFileSync(migration.path, 'utf8'));
  }
}

function defaultRandomDigits() {
  return String(randomInt(0, 100000)).padStart(5, '0');
}

function planMoves(database, mediaRoot, skippedMediaDirectory, makeId, makeRandomDigits) {
  const root = resolve(mediaRoot);
  const rows = database.prepare('SELECT id, media_path FROM item_images ORDER BY id').all();
  const targets = new Set();
  const skipped = [];
  const moves = rows.flatMap((row) => {
    const sourcePath = assertRelativeMediaPath(row.media_path);
    const source = resolve(root, sourcePath);
    if (!isInside(root, source) || !existsSync(source)) throw new MediaCutoverError(`legacy media file is missing: ${sourcePath}`);
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new MediaCutoverError(`legacy media file is not a regular file: ${sourcePath}`);
    const sourceExtension = extname(sourcePath).toLowerCase();
    let extension = sourceExtension.slice(1);
    if (!EXTENSIONS.has(sourceExtension)) {
      const bytes = readFileSync(source);
      if (!hasSupportedImageSignature(bytes)) { skipped.push({ image_id: row.id, source_path: sourcePath, source, reason: 'unsupported_image_bytes' }); return []; }
      try { extension = inspectImage(bytes).extension; }
      catch { skipped.push({ image_id: row.id, source_path: sourcePath, source, reason: 'invalid_image_bytes' }); return []; }
    }
    const identifier = makeId();
    const suffix = makeRandomDigits();
    if (typeof identifier !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(identifier)) throw new MediaCutoverError('media cutover identifier must be a UUID');
    if (typeof suffix !== 'string' || !/^\d{5}$/u.test(suffix)) throw new MediaCutoverError('media cutover random suffix must contain exactly five digits');
    const targetPath = `images/${identifier.slice(0, 2).toLowerCase()}/${identifier.toLowerCase()}-${suffix}.${extension}`;
    const target = resolve(root, targetPath);
    if (!isInside(root, target) || targets.has(targetPath) || existsSync(target)) throw new MediaCutoverError(`media cutover path conflicts: ${targetPath}`);
    targets.add(targetPath);
    return [{ image_id: row.id, source_path: sourcePath, target_path: targetPath, source, target }];
  });
  const skippedMoves = skipped.map((entry) => {
    const target = resolve(skippedMediaDirectory, `${entry.image_id}${extname(entry.source_path).toLowerCase() || '.img'}`);
    if (existsSync(target)) throw new MediaCutoverError(`skipped media quarantine path conflicts: ${target}`);
    return { ...entry, target, target_path: target, database_path: `images/00/skipped-${entry.image_id}${extname(entry.source_path).toLowerCase() || '.img'}` };
  });
  return { moves, skipped, skippedMoves };
}

function moveWithoutOverwrite(move) {
  mkdirSync(dirname(move.target), { recursive: true, mode: 0o700 });
  linkSync(move.source, move.target);
  unlinkSync(move.source);
}

function reverseMove(move) {
  linkSync(move.target, move.source);
  unlinkSync(move.target);
}

export function runMediaCutover({ databasePath, mediaRoot, repositoryRoot = resolve(new URL('../..', import.meta.url).pathname), evidenceDirectory = dirname(databasePath), makeId = randomUUID, makeRandomDigits = defaultRandomDigits, readMigrationSql = migrationSql, applyPostMigrations = applyPostCutoverMigrations, reverse = reverseMove } = {}) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) throw new TypeError('databasePath is required');
  if (typeof mediaRoot !== 'string' || mediaRoot.length === 0) throw new TypeError('mediaRoot is required');
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedEvidenceDirectory = resolve(evidenceDirectory);
  mkdirSync(resolvedEvidenceDirectory, { recursive: true, mode: 0o700 });
  const evidencePath = resolve(resolvedEvidenceDirectory, `media-cutover-${randomUUID()}.json`);
  const database = new DatabaseSync(resolvedDatabasePath);
  let evidence = { version: 1, status: 'preflight', database_path: resolvedDatabasePath, media_root: resolve(mediaRoot), moves: [], recovery: [] };
  let moved = [];
  let cutoverCommitted = false;
  try {
    const versions = currentVersions(database);
    if (versions.includes(MEDIA_CUTOVER_VERSION)) {
      applyPostMigrations(database, repositoryRoot);
      return Object.freeze({ status: 'complete', evidence_path: null, already_applied: true });
    }
    applyPreCutoverMigrations(database, repositoryRoot);
    if (currentVersions(database).at(-1) !== MEDIA_CUTOVER_VERSION - 1) throw new MediaCutoverError(`database must stop at migration ${MEDIA_CUTOVER_VERSION - 1} before media cutover`);
    const skippedMediaDirectory = resolve(resolvedEvidenceDirectory, `${basename(evidencePath, '.json')}-skipped-media`);
    const plan = planMoves(database, mediaRoot, skippedMediaDirectory, makeId, makeRandomDigits);
    const moves = plan.moves;
    evidence = { ...evidence, moves: moves.map(({ image_id, source_path, target_path }) => ({ image_id, source_path, target_path })), skipped: plan.skippedMoves.map(({ image_id, source_path, target_path, reason }) => ({ image_id, source_path, quarantine_path: target_path, reason })) };
    writeEvidence(evidencePath, evidence);
    for (const move of moves) {
      moveWithoutOverwrite(move);
      moved.push(move);
    }
    for (const move of plan.skippedMoves) {
      moveWithoutOverwrite(move);
      moved.push(move);
    }
    evidence = { ...evidence, status: 'files_moved' };
    writeEvidence(evidencePath, evidence);
    try {
      database.exec(CREATE_MEDIA_CUTOVER_PLAN_TABLE_SQL);
      const insert = database.prepare(`INSERT INTO ${MEDIA_CUTOVER_PLAN_TABLE}(image_id, source_path, target_path) VALUES (?, ?, ?)`);
      for (const move of moves) insert.run(move.image_id, move.source_path, move.target_path);
      for (const skipped of plan.skippedMoves) insert.run(skipped.image_id, skipped.source_path, skipped.database_path);
      database.exec('CREATE TABLE media_cutover_skipped(image_id INTEGER PRIMARY KEY);');
      const insertSkipped = database.prepare('INSERT INTO media_cutover_skipped(image_id) VALUES (?)');
      for (const skipped of plan.skipped) insertSkipped.run(skipped.image_id);
      database.exec(readMigrationSql(repositoryRoot));
      cutoverCommitted = true;
      applyPostMigrations(database, repositoryRoot);
    } catch (error) {
      try { database.exec(`DROP TABLE IF EXISTS ${MEDIA_CUTOVER_PLAN_TABLE};`); } catch {}
      if (!cutoverCommitted) {
        try { database.exec('DROP TABLE IF EXISTS media_cutover_skipped;'); } catch {}
      }
      throw error;
    }
    evidence = { ...evidence, status: 'complete' };
    writeEvidence(evidencePath, evidence);
    return Object.freeze({ status: 'complete', evidence_path: evidencePath, moved_count: moved.length });
  } catch (error) {
    const recovery = [];
    if (!cutoverCommitted) {
      for (const move of [...moved].reverse()) {
        try { reverse(move); } catch (rollbackError) { recovery.push({ source_path: move.source_path, target_path: move.target_path, error: rollbackError.message }); }
      }
    }
    const status = cutoverCommitted || recovery.length > 0 ? 'recovery_required' : 'failed_reverted';
    evidence = { ...evidence, status, recovery, error: error.message };
    writeEvidence(evidencePath, evidence);
    throw new MediaCutoverError(`media cutover failed; evidence: ${evidencePath}`, { evidencePath, cause: error });
  } finally {
    database.close();
  }
}
