import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { startLocalApplication } from '../app/server/local-app.mjs';
import { ApplicationError } from '../app/security/error-mapping.mjs';
import { createFakeSemanticModelClient, FAKE_VECTOR_CONFIGURATION } from '../tests/fixtures/vector/fake-semantic-model-client.mjs';

const [root] = process.argv.slice(2);
const temporaryRoot = resolve(process.env.NOOBAI_TEST_TEMP_PARENT ?? tmpdir());
const testRoot = resolve(root ?? '');
const temporaryParent = realpathSync(temporaryRoot);
const testParent = realpathSync(dirname(testRoot));
if (process.env.NOOBAI_TEST_MODE !== '1' || typeof process.env.NOOBAI_TEST_TEMP_PARENT !== 'string' || testParent !== temporaryParent || basename(testRoot).startsWith('noobai-manage-e2e-') === false) {
  throw new Error('isolated test application requires a generated temporary test root');
}
const baseModelDetailReadBehavior = process.env.NOOBAI_TEST_BASE_MODEL_DETAIL_READ_BEHAVIOR ?? 'none';
if (!['none', 'delay', 'fail'].includes(baseModelDetailReadBehavior)) throw new Error('invalid base model detail read behavior');
const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
function decorateBaseModelService(service) {
  if (baseModelDetailReadBehavior === 'none') return service;
  return Object.freeze({
    ...service,
    async get(id) {
      if (baseModelDetailReadBehavior === 'delay') await delay(300);
      if (baseModelDetailReadBehavior === 'fail') throw new ApplicationError('DATABASE_BUSY', '详情读取失败，请稍后重试。');
      return service.get(id);
    }
  });
}
const application = await startLocalApplication({
  dataPaths: Object.freeze({ dataRoot: join(testRoot, 'catalog'), databasePath: join(testRoot, 'catalog', 'app.sqlite'), mediaRoot: join(testRoot, 'catalog', 'media') }),
  vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
  vectorModelClient: createFakeSemanticModelClient(),
  baseModelServiceDecorator: decorateBaseModelService
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await application.close();
    process.exit(0);
  });
}
