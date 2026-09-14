import { resolve } from 'node:path';

import { openCatalogDatabase } from '../app/catalog/database.mjs';
import { loadVectorModelConfiguration, createConfiguredVectorModelClient } from '../app/vector/model-client.mjs';
import { createStyleVectorMaintenance } from '../app/vector/style-semantic.mjs';

const databaseFlag = process.argv.indexOf('--database');
const mediaRootFlag = process.argv.indexOf('--media-root');
const reset = process.argv.includes('--reset');
if (databaseFlag < 0 || typeof process.argv[databaseFlag + 1] !== 'string' || process.argv[databaseFlag + 1].startsWith('--') || mediaRootFlag < 0 || typeof process.argv[mediaRootFlag + 1] !== 'string' || process.argv[mediaRootFlag + 1].startsWith('--')) {
  throw new Error('usage: node scripts/rebuild-style-vectors.mjs --database <app.sqlite> --media-root <data/media> [--reset]');
}
const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);
const database = openCatalogDatabase({ databasePath: resolve(process.argv[databaseFlag + 1]), mediaRoot: resolve(process.argv[mediaRootFlag + 1]), repositoryRoot });
try {
  const configuration = loadVectorModelConfiguration(repositoryRoot);
  const result = await createStyleVectorMaintenance({ database, configuration, modelClient: createConfiguredVectorModelClient({ repositoryRoot, configuration }) }).rebuild({ reset });
  process.stdout.write(`${JSON.stringify({ object_kind: result.object_kind, completed: result.completed, failures: result.failures.map(({ object_id, error }) => ({ object_id, error_code: error?.code ?? 'INTERNAL_ERROR', message: String(error?.message ?? error) })), rebuilt_at: result.rebuilt_at })}\n`);
  if (result.failures.length > 0) process.exitCode = 1;
} finally { database.close(); }
