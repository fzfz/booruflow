import { readFileSync, watchFile, unwatchFile, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseProductionEnvironment } from '../app/config/production-environment.mjs';
import { REPOSITORY_ROOT } from '../app/config/load-config.mjs';
import { openExistingCatalogDatabase } from '../app/catalog/database.mjs';
import { assertCurrentDatabase } from '../app/data-package/database.mjs';
import { startLocalApplication } from '../app/server/local-app.mjs';

if (process.env.NOOBAI_TEST_MODE !== undefined) throw new Error('start-local-app does not allow test mode');

const rootEnvironment = parseProductionEnvironment(readFileSync(resolve(REPOSITORY_ROOT, '.env'), 'utf8'));
for (const [key, value] of Object.entries(rootEnvironment)) process.env[key] ??= value;

const application = await startLocalApplication({databaseFactory: ({databasePath}) => {
  const database = openExistingCatalogDatabase({databasePath});
  try { assertCurrentDatabase(database); return database; }
  catch (error) { database.close(); throw error; }
}});
const release = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT,'config/release/release.json'),'utf8'));
const shutdownPath=resolve(REPOSITORY_ROOT,release.runtime.shutdown_file);
let closing=false;
async function closeApplication() {
  if(closing) return;
  closing=true;unwatchFile(shutdownPath);
  await application.close();
  if(existsSync(shutdownPath)) rmSync(shutdownPath);
  process.exit(0);
}
watchFile(shutdownPath,{interval:release.runtime.poll_interval_seconds*1000},()=>{if(existsSync(shutdownPath)) void closeApplication();});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal,()=>{void closeApplication();});
