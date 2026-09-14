import assert from 'node:assert/strict';
import test from 'node:test';

import { inTransaction, openCatalogDatabase } from '../../app/catalog/database.mjs';

const DERIVED_DATABASE_HANDLES_AVAILABLE = (() => {
  const database = openCatalogDatabase({ databasePath: ':memory:', includeBuiltinComfyuiCatalog: false });
  try {
    if (typeof database.createTagStore !== 'function' || typeof database.createSession !== 'function') return false;
    try {
      const tagStore = database.createTagStore();
      const session = database.createSession();
      const available = typeof tagStore.clear === 'function'
        && typeof session.changeset === 'function'
        && typeof session.patchset === 'function'
        && typeof session.close === 'function'
        && typeof session[Symbol.dispose] === 'function';
      if (typeof session.close === 'function') session.close();
      return available;
    } catch {
      return false;
    }
  } finally {
    database.close();
  }
})();

function createUncertainDatabase() {
  const rawDatabase = openCatalogDatabase({ databasePath: ':memory:', includeBuiltinComfyuiCatalog: false });
  let faultEnabled = false;
  const database = new Proxy(rawDatabase, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (faultEnabled && sql === 'COMMIT;') throw new Error('forced commit result unavailable');
          if (faultEnabled && sql === 'ROLLBACK;') throw new Error('forced rollback result unavailable');
          return target.exec(sql);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return Object.freeze({
    database,
    makeUncertain() {
      faultEnabled = true;
      assert.throws(() => inTransaction(database, () => {}), /ROLLBACK failed/u);
    }
  });
}

test('Issue #276 R3 blocks TagStore execution and iterators after uncertainty while allowing clear', {
  skip: DERIVED_DATABASE_HANDLES_AVAILABLE ? false : '当前 Node.js 运行时不提供 DatabaseSync.createTagStore/createSession'
}, () => {
  const fixture = createUncertainDatabase();
  const { database } = fixture;
  const tagStore = database.createTagStore();
  assert.deepEqual({ ...tagStore.get`SELECT 1 AS value` }, { value: 1 });
  const iterator = tagStore.iterate`SELECT 1 AS value`;
  assert.deepEqual({ ...iterator.next().value }, { value: 1 });
  fixture.makeUncertain();

  for (const invoke of [
    () => tagStore.get`SELECT 1 AS value`,
    () => tagStore.all`SELECT 1 AS value`,
    () => tagStore.run`SELECT 1 AS value`,
    () => tagStore.iterate`SELECT 1 AS value`,
    () => iterator.next(),
    () => tagStore.db.prepare('SELECT 1 AS value')
  ]) {
    assert.throws(invoke, /not serviceable/u);
  }
  assert.doesNotThrow(() => tagStore.clear());
  database.close();
});

test('Issue #276 R3 blocks Session changeset and patchset after uncertainty while allowing resource release', {
  skip: DERIVED_DATABASE_HANDLES_AVAILABLE ? false : '当前 Node.js 运行时不提供 DatabaseSync.createTagStore/createSession'
}, () => {
  const fixture = createUncertainDatabase();
  const { database } = fixture;
  const closeSession = database.createSession();
  const disposeSession = database.createSession();
  assert.ok(closeSession.changeset() instanceof Uint8Array);
  assert.ok(disposeSession.patchset() instanceof Uint8Array);
  fixture.makeUncertain();

  assert.throws(() => closeSession.changeset(), /not serviceable/u);
  assert.throws(() => disposeSession.patchset(), /not serviceable/u);
  assert.doesNotThrow(() => closeSession.close());
  assert.doesNotThrow(() => disposeSession[Symbol.dispose]());
  database.close();
});
