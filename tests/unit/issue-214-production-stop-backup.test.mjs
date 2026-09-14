import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { assertProductionStopped, createProductionRuntimeBackup } from '../../app/maintenance/production-runtime-data.mjs';
import { createProductionTcpPortProbe } from '../../app/maintenance/production-network-probe.mjs';
import { main as backupMain, runProductionBackup } from '../../scripts/prod-backup.mjs';

const LISTENERS = Object.freeze({
  public: Object.freeze({ port: 46211 }),
  internal: Object.freeze({ port: 46212 })
});
const RUNTIME_CONFIGURATION = Object.freeze({ listeners: LISTENERS });
const RUNTIME_FILES = Object.freeze([
  '.2x-nz-crawlee-records.json',
  'app.sqlite',
  'crawl_state.json',
  'media/cover.bin',
  'raw/source.json',
  'reports/latest.json'
]);

function createSocketProbe(answers) {
  const calls = [];
  const probe = createProductionTcpPortProbe({
    connectSocket: ({ port }) => {
      calls.push(port);
      const answer = answers.get(port);
      const socket = {
        once(event, callback) {
          if (event === 'connect') socket.onConnect = callback;
          if (event === 'error') socket.onError = callback;
          return socket;
        },
        setTimeout(_milliseconds, callback) {
          socket.onTimeout = callback;
          return socket;
        },
        destroy() {
          return socket;
        }
      };
      queueMicrotask(() => {
        if (answer?.type === 'connect') socket.onConnect?.();
        if (answer?.type === 'error') socket.onError?.(answer.error);
        if (answer?.type === 'timeout') socket.onTimeout?.();
      });
      return socket;
    }
  });
  return { calls, probe };
}

test('Issue #214 production runtime checks require explicit listener configuration and honor configured ports', async (t) => {
  const fixture = createRuntimeFixture(t);
  fixture.database.close();
  await assert.rejects(
    () => assertProductionStopped({ productionRoot: fixture.root, isPidAlive: () => false, isPortListening: () => false }),
    /production runtime configuration with listeners is required/u
  );
  await assert.rejects(
    () => createProductionRuntimeBackup({ dataRoot: fixture.dataRoot, productionRoot: fixture.root, isPidAlive: () => false, isPortListening: () => false }),
    /production runtime configuration with listeners is required/u
  );

  const calls = [];
  await assertProductionStopped({
    productionRoot: fixture.root,
    runtimeConfiguration: RUNTIME_CONFIGURATION,
    isPidAlive: () => false,
    isPortListening: (port) => {
      calls.push(port);
      return false;
    }
  });
  assert.deepEqual(calls, [46211, 46212]);

  const customCalls = [];
  await assertProductionStopped({
    productionRoot: fixture.root,
    runtimeConfiguration: { listeners: { public: { port: 46201 }, internal: { port: 46202 } } },
    isPidAlive: () => false,
    isPortListening: (port) => {
      customCalls.push(port);
      return false;
    }
  });
  assert.deepEqual(customCalls, [46201, 46202]);
});

function captureOutput() {
  const chunks = [];
  return {
    stream: { write(value) { chunks.push(String(value)); } },
    text() { return chunks.join(''); }
  };
}

test('Issue #214 prod backup command seam reports configured listener and checkpoint failures and success without production sockets', async () => {
  for (const failure of ['configured port 46211 is already listening', 'SQLite WAL checkpoint is busy (busy=1, log=4, checkpointed=0)']) {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const exitCode = await backupMain({
      runner: () => runProductionBackup({
        cwd: '/tmp/noobai-issue214-backup-fixture',
        loadRuntimeConfiguration: () => RUNTIME_CONFIGURATION,
        createBackup: async ({ runtimeConfiguration }) => {
          assert.deepEqual(runtimeConfiguration, RUNTIME_CONFIGURATION);
          throw new Error(failure);
        },
        stdout: stdout.stream
      }),
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    assert.equal(exitCode, 1);
    assert.match(stderr.text(), new RegExp(failure.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.equal(stdout.text(), '');
  }

  const stdout = captureOutput();
  const stderr = captureOutput();
  const exitCode = await backupMain({
    runner: () => runProductionBackup({
      cwd: '/tmp/noobai-issue214-backup-fixture',
      loadRuntimeConfiguration: () => RUNTIME_CONFIGURATION,
      createBackup: async ({ runtimeConfiguration, productionRoot, dataRoot }) => {
        assert.deepEqual(runtimeConfiguration, RUNTIME_CONFIGURATION);
        assert.equal(productionRoot, '/tmp/noobai-issue214-backup-fixture');
        assert.equal(dataRoot, '/tmp/noobai-issue214-backup-fixture/data');
        return { name: '2026-08-06T12-00-00-000Z', createdAt: '2026-08-06T12:00:00.000Z' };
      },
      stdout: stdout.stream
    }),
    stdout: stdout.stream,
    stderr: stderr.stream
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), '');
  assert.match(stdout.text(), /2026-08-06T12-00-00-000Z/u);
  assert.match(stdout.text(), /SHA-256 manifest verified/u);
});

test('Issue #214 shared TCP probe fails closed for non-ECONNREFUSED errors and timeouts', async () => {
  const denied = createSocketProbe(new Map([
    [46151, { type: 'error', error: Object.assign(new Error('denied'), { code: 'EACCES' }) }]
  ]));
  await assert.rejects(denied.probe(46151), /cannot determine whether configured port 46151 is in use/u);

  const timedOut = createSocketProbe(new Map([[46152, { type: 'timeout' }]]));
  await assert.rejects(timedOut.probe(46152), /cannot determine whether configured port 46152 is in use/u);
});

function writeFile(root, path, contents) {
  const target = resolve(root, path);
  assert.equal(relative(root, target).startsWith('..'), false);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, contents);
}

function createRuntimeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'noobai-issue214-production-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data');
  for (const path of RUNTIME_FILES) {
    if (path === 'app.sqlite') continue;
    writeFile(dataRoot, path, `fixture:${path}\n`);
  }
  const databasePath = join(dataRoot, 'app.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE records (value TEXT); INSERT INTO records VALUES (\'wal-value\');');
  return { root, dataRoot, database, databasePath };
}

function backupNames(dataRoot) {
  const recoveryRoot = join(dataRoot, 'recovery');
  return existsSync(recoveryRoot) ? readdirSync(recoveryRoot).sort() : [];
}

function stopCheckOverrides(overrides = {}) {
  return {
    productionRoot: overrides.productionRoot,
    runtimeConfiguration: RUNTIME_CONFIGURATION,
    isPidAlive: overrides.isPidAlive ?? (() => false),
    isPortListening: overrides.isPortListening ?? (() => false),
    ...overrides
  };
}

test('Issue #214 prod backup independently rejects each stopped-condition failure', async (t) => {
  const scenarios = [
    {
      name: 'live PID',
      prepare(root) {
        writeFile(root, 'runtime/run/app.pid', '7301\n');
        return stopCheckOverrides({ productionRoot: root, isPidAlive: () => true });
      },
      expected: /production application PID .* still running/u
    },
    {
      name: 'residual PID file',
      prepare(root) {
        writeFile(root, 'runtime/run/app.pid', '7301\n');
        return stopCheckOverrides({ productionRoot: root, isPidAlive: () => false });
      },
      expected: /PID file remains/u
    },
    {
      name: 'public listener',
      prepare(root) {
        return stopCheckOverrides({ productionRoot: root, isPortListening: (port) => port === 46211 });
      },
      expected: /46211/u
    },
    {
      name: 'internal listener',
      prepare(root) {
        return stopCheckOverrides({ productionRoot: root, isPortListening: (port) => port === 46212 });
      },
      expected: /46212/u
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (nested) => {
      const fixture = createRuntimeFixture(nested);
      fixture.database.close();
      await assert.rejects(
        () => createProductionRuntimeBackup({ dataRoot: fixture.dataRoot, ...scenario.prepare(fixture.root) }),
        scenario.expected
      );
      assert.deepEqual(backupNames(fixture.dataRoot), [], 'stopped-condition failure must not create a timestamp directory');
    });
  }
});

test('Issue #214 prod backup checkpoints a real SQLite WAL before publishing app.sqlite only', async (t) => {
  const fixture = createRuntimeFixture(t);
  const backup = await createProductionRuntimeBackup({
    dataRoot: fixture.dataRoot,
    productionRoot: fixture.root,
    runtimeConfiguration: RUNTIME_CONFIGURATION,
    isPidAlive: () => false,
    isPortListening: () => false,
    now: new Date('2026-08-06T12:00:00.000Z')
  });
  fixture.database.close();

  const backupRoot = backup.backupRoot;
  assert.equal(existsSync(join(backupRoot, 'app.sqlite')), true);
  assert.equal(existsSync(join(backupRoot, 'app.sqlite-wal')), false);
  assert.equal(existsSync(join(backupRoot, 'app.sqlite-shm')), false);
  const manifest = JSON.parse(readFileSync(join(backupRoot, 'backup-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map(({ path }) => path).filter((path) => path.startsWith('app.sqlite')), ['app.sqlite']);
  const copied = new DatabaseSync(join(backupRoot, 'app.sqlite'), { readOnly: true });
  assert.equal(copied.prepare('SELECT value FROM records').get().value, 'wal-value');
  copied.close();
});

test('Issue #214 prod backup rejects busy, exceptional, and unmerged WAL checkpoints', async (t) => {
  const scenarios = [
    { name: 'busy', result: { busy: 1, log: 4, checkpointed: 0 }, expected: /busy/u },
    { name: 'unmerged', result: { busy: 0, log: 4, checkpointed: 3 }, expected: /not fully merged/u },
    { name: 'exception', error: new Error('checkpoint exploded'), expected: /checkpoint exploded/u }
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (nested) => {
      const fixture = createRuntimeFixture(nested);
      fixture.database.close();
      let closed = false;
      const databaseFactory = () => ({
        prepare() {
          return {
            get() {
              if (scenario.error !== undefined) throw scenario.error;
              return scenario.result;
            }
          };
        },
        close() { closed = true; }
      });
      await assert.rejects(
        () => createProductionRuntimeBackup({ dataRoot: fixture.dataRoot, ...stopCheckOverrides({ productionRoot: fixture.root }), databaseFactory }),
        scenario.expected
      );
      assert.equal(closed, true, 'checkpoint database must close on every checkpoint failure');
      assert.deepEqual(backupNames(fixture.dataRoot), []);
    });
  }
});

test('Issue #214 prod backup cleans staging and publishes no timestamp directory on hash-copy failure', async (t) => {
  const fixture = createRuntimeFixture(t);
  fixture.database.close();
  const copyFile = (source, target) => {
    copyFileSync(source, target);
    if (target.endsWith('crawl_state.json')) writeFileSync(target, 'tampered after copy\n');
  };
  await assert.rejects(
    () => createProductionRuntimeBackup({ dataRoot: fixture.dataRoot, ...stopCheckOverrides({ productionRoot: fixture.root }), copyFile }),
    /hash verification failed/u
  );
  assert.deepEqual(backupNames(fixture.dataRoot), []);
});

test('Issue #214 prod backup removes a published directory if final manifest verification fails', async (t) => {
  const fixture = createRuntimeFixture(t);
  fixture.database.close();
  let hashCalls = 0;
  const hashFile = (path) => {
    hashCalls += 1;
    if (hashCalls === 22) return '0'.repeat(64);
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  await assert.rejects(
    () => createProductionRuntimeBackup({ dataRoot: fixture.dataRoot, ...stopCheckOverrides({ productionRoot: fixture.root }), hashFile }),
    /manifest hash verification failed/u
  );
  assert.deepEqual(backupNames(fixture.dataRoot), []);
});

test('Issue #214 prod backup cleans staging and published directories when hashFile throws directly', async (t) => {
  const fixture = createRuntimeFixture(t);
  fixture.database.close();
  let throwOnPublished = false;
  const hashFile = (path) => {
    if (throwOnPublished && path.includes('/recovery/') && !path.includes('.staging-')) throw new Error('hash exploded');
    if (path.endsWith('crawl_state.json')) throwOnPublished = true;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  await assert.rejects(
    () => createProductionRuntimeBackup({ dataRoot: fixture.dataRoot, ...stopCheckOverrides({ productionRoot: fixture.root }), hashFile }),
    /hash exploded/u
  );
  assert.deepEqual(backupNames(fixture.dataRoot), [], 'direct hash errors must remove staging and formal backup directories');
});
