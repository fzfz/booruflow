import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { MEDIA_CUTOVER_VERSION } from './media-cutover-contract.mjs';
import { STYLE_SCHEMA_MIGRATION_VERSION } from './style-schema-migration.mjs';

export class MigrationBaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationBaselineError';
  }
}

function fail(message) {
  throw new MigrationBaselineError(message);
}

function migrationMetadata(path) {
  const match = /^(\d{3,})-([a-z0-9][a-z0-9-]*)\.sql$/u.exec(basename(path));
  if (!match) fail(`migration filename must use NNN-name.sql: ${path}`);
  return { path, version: Number(match[1]), name: `${match[1]}-${match[2]}` };
}

export function listOrderedMigrations(migrationDirectory) {
  if (!existsSync(migrationDirectory)) fail(`migration directory is missing: ${migrationDirectory}`);
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => migrationMetadata(resolve(migrationDirectory, name)))
    .sort((left, right) => left.version - right.version || left.name.localeCompare(right.name));
  if (migrations.length === 0) fail('no SQL migrations are available');
  const versions = new Set();
  for (const migration of migrations) {
    if (versions.has(migration.version)) fail(`duplicate migration version: ${migration.version}`);
    versions.add(migration.version);
  }
  return migrations;
}

function runSqlite(sqliteCommand, databasePath, input, commandArguments = []) {
  const result = spawnSync(sqliteCommand, [...commandArguments, databasePath], { input, encoding: 'utf8' });
  if (result.error) fail(`SQLite command is unavailable: ${sqliteCommand}: ${result.error.message}`);
  if (result.status !== 0) fail(`SQLite command failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

function runOfflineMediaCutover(migrationDirectory, databasePath) {
  const repositoryRoot = resolve(migrationDirectory, '../..');
  const result = spawnSync(process.execPath, [
    resolve(repositoryRoot, 'scripts/run-media-cutover.mjs'),
    '--database', databasePath,
    '--media-root', resolve(dirname(databasePath), 'media')
  ], { encoding: 'utf8' });
  if (result.error) fail(`offline media cutover command is unavailable: ${result.error.message}`);
  if (result.status !== 0) fail(`offline media cutover command failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

export function applyMigrationsToEmptyDatabase({ migrationDirectory, databasePath, sqliteCommand = 'sqlite3' }) {
  const migrations = listOrderedMigrations(migrationDirectory);
  if (existsSync(databasePath)) fail(`empty database path already exists: ${databasePath}`);
  for (const migration of migrations.filter((migration) => migration.version < MEDIA_CUTOVER_VERSION)) {
    runSqlite(sqliteCommand, databasePath, readFileSync(migration.path, 'utf8'));
  }
  runOfflineMediaCutover(migrationDirectory, databasePath);
  const applied = runSqlite(sqliteCommand, databasePath, 'SELECT version || \':\' || name FROM schema_migrations ORDER BY version;').trim().split('\n').filter(Boolean);
  // Style migration 015 runs at application startup with mediaRoot. Later
  // migrations must wait for it, so the offline cutover stops at 014.
  const expected = migrations.filter(({ version }) => version < STYLE_SCHEMA_MIGRATION_VERSION).map((migration) => `${migration.version}:${migration.name}`);
  if (JSON.stringify(applied) !== JSON.stringify(expected)) fail(`schema_migrations order differs from migration files: ${JSON.stringify(applied)}`);
  const foreignKeyProblems = runSqlite(sqliteCommand, databasePath, 'PRAGMA foreign_key_check;').trim();
  if (foreignKeyProblems !== '') fail(`empty migration database has foreign-key violations: ${foreignKeyProblems}`);
  return { migrations: expected };
}
