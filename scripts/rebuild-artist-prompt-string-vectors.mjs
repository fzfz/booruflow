import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { openCatalogDatabase } from '../app/catalog/database.mjs';
import { loadVectorModelConfiguration, createConfiguredVectorModelClient } from '../app/vector/model-client.mjs';
import { createArtistPromptStringVectorMaintenance } from '../app/vector/artist-prompt-string-semantic.mjs';

const USAGE = 'usage: node scripts/rebuild-artist-prompt-string-vectors.mjs --database <app.sqlite> --media-root <data/media> [--reset]';

function argumentValue(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error(USAGE);
  return value;
}

function parseArguments(argv) {
  let databasePath = null;
  let mediaRoot = null;
  let reset = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database') {
      if (databasePath !== null) throw new Error(USAGE);
      databasePath = argumentValue(argv, index);
      index += 1;
    } else if (argument === '--media-root') {
      if (mediaRoot !== null) throw new Error(USAGE);
      mediaRoot = argumentValue(argv, index);
      index += 1;
    } else if (argument === '--reset') {
      if (reset) throw new Error(USAGE);
      reset = true;
    } else {
      throw new Error(USAGE);
    }
  }
  if (databasePath === null || mediaRoot === null) throw new Error(USAGE);
  return Object.freeze({ databasePath, mediaRoot, reset });
}

const options = parseArguments(process.argv.slice(2));
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const database = openCatalogDatabase({
  databasePath: resolve(options.databasePath),
  mediaRoot: resolve(options.mediaRoot),
  repositoryRoot
});
try {
  const configuration = loadVectorModelConfiguration(repositoryRoot);
  const result = await createArtistPromptStringVectorMaintenance({
    database,
    configuration,
    modelClient: createConfiguredVectorModelClient({ repositoryRoot, configuration })
  }).rebuild({ reset: options.reset });
  process.stdout.write(`${JSON.stringify({
    object_kind: result.object_kind,
    completed: result.completed,
    failures: result.failures.map(({ object_id, error }) => ({
      object_id,
      error_code: error?.code ?? 'INTERNAL_ERROR',
      message: String(error?.message ?? error)
    })),
    rebuilt_at: result.rebuilt_at
  })}\n`);
  if (result.failures.length > 0) process.exitCode = 1;
} finally {
  database.close();
}
