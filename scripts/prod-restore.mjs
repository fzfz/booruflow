import { resolve } from 'node:path';

import { restoreProductionRuntimeBackup } from '../app/maintenance/production-runtime-data.mjs';

function backupArgument(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== '--backup') throw new Error('usage: prod:restore -- --backup data/recovery/<timestamp>');
  return argumentsList[1];
}

try {
  const restored = restoreProductionRuntimeBackup({
    productionRoot: resolve(process.cwd()),
    backupArgument: backupArgument(process.argv.slice(2))
  });
  process.stdout.write(`Production restore verified with SHA-256: ${restored.restoredFiles} runtime files restored from ${restored.backupRoot}.\n`);
} catch (error) {
  process.stderr.write(`Production restore failed: ${error.message}\n`);
  process.exitCode = 1;
}
