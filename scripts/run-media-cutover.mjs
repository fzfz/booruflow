import { resolve } from 'node:path';

import { runMediaCutover } from '../app/database/media-cutover.mjs';

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    if (required) throw new Error(`${name} requires a path`);
    return null;
  }
  const value = process.argv[index + 1];
  if (typeof value !== 'string' || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return value;
}

try {
  const databasePath = argument('--database');
  const mediaRoot = argument('--media-root');
  const evidenceDirectory = argument('--evidence-dir', { required: false });
  if (!databasePath || !mediaRoot) throw new Error('usage: node scripts/run-media-cutover.mjs --database <app.sqlite> --media-root <media-root> [--evidence-dir <directory>]');
  const result = runMediaCutover({
    databasePath: resolve(databasePath),
    mediaRoot: resolve(mediaRoot),
    ...(evidenceDirectory ? { evidenceDirectory: resolve(evidenceDirectory) } : {})
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
