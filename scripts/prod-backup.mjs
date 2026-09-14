import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProductionRuntimeConfiguration } from '../app/config/production-environment.mjs';
import { createProductionRuntimeBackup } from '../app/maintenance/production-runtime-data.mjs';

export async function runProductionBackup({
  cwd = process.cwd(),
  loadRuntimeConfiguration = loadProductionRuntimeConfiguration,
  createBackup = createProductionRuntimeBackup,
  stdout = process.stdout
} = {}) {
  const productionRoot = resolve(cwd);
  const runtimeConfiguration = loadRuntimeConfiguration({
    environmentPath: resolve(productionRoot, '.env'),
    configPath: resolve(productionRoot, 'config', 'defaults.json')
  });
  const backup = await createBackup({
    productionRoot,
    dataRoot: resolve(productionRoot, 'data'),
    runtimeConfiguration,
    includeInstallationConfiguration: true
  });
  stdout.write(`Production backup ${backup.name} created at ${backup.createdAt}; SHA-256 manifest verified.\n`);
  return backup;
}

export async function main({
  runner = runProductionBackup,
  stdout = process.stdout,
  stderr = process.stderr,
  ...options
} = {}) {
  try {
    await runner({ ...options, stdout });
    return 0;
  } catch (error) {
    stderr.write(`Production backup failed: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
