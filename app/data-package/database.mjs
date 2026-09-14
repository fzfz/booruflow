import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openCatalogDatabase, openExistingCatalogDatabase } from '../catalog/database.mjs';
import { readFileSync } from 'node:fs';
const migrationPolicy=JSON.parse(readFileSync(new URL('../../config/migration-policy.json',import.meta.url),'utf8'));
export const definition = Object.freeze(JSON.parse(readFileSync(new URL('../../schema/data-package/definition.json', import.meta.url), 'utf8')));
export function assertCurrentDatabase(database) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version !== definition.database_version) throw new Error(`Database version ${version} requires migration to ${definition.database_version}. Run the update script before importing.`);
}
export function assertEmptyDatabase(database) {
  assertCurrentDatabase(database);
  const occupied = definition.empty_tables.map(table => ({table, count:database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count})).filter(row=>row.count>0);
  if (occupied.length) throw new Error(`目标数据库已有数据，本次导入已取消。请在新安装的空数据库中导入。 ${JSON.stringify(occupied)}`);
}
export function initializeDatabase(databasePath) {
  if (existsSync(databasePath)) throw new Error('Database already exists. Use the update script for this installation.');
  mkdirSync(dirname(databasePath), {recursive:true});
  const memory = openCatalogDatabase({includeBuiltinComfyuiCatalog:false});
  try { assertEmptyDatabase(memory); memory.prepare('VACUUM INTO ?').run(databasePath); }
  finally { memory.close(); }
}
export function migrateDatabase(databasePath) {
  const current=openExistingCatalogDatabase({databasePath});
  try {
    const version=current.prepare('PRAGMA user_version').get().user_version;
    if (!migrationPolicy.supported_upgrade_versions.includes(version)) throw new Error(`Database version ${version} is unsupported. Use a v0.87.0 database or a new installation.`);
  } finally { current.close(); }
  const migrated=openCatalogDatabase({databasePath,mediaRoot:resolve(dirname(databasePath),'media'),includeBuiltinComfyuiCatalog:false});
  try {assertCurrentDatabase(migrated);} finally {migrated.close();}
}
