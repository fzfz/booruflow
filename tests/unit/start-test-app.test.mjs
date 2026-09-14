import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';

function createChild({ startup = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, signal);
    });
    return true;
  };
  if (startup) queueMicrotask(() => child.stdout.write('应用已启动：fake\n'));
  return child;
}

function spawnFailureChild() {
  const child = createChild();
  child.on('error', () => {});
  queueMicrotask(() => {
    const error = Object.assign(new Error('spawn failed for test'), { code: 'EAGAIN' });
    child.emit('error', error);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', -1, null);
  });
  return child;
}

function childBeforeStartup(event) {
  const child = createChild();
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit(event, 1, null);
  });
  return child;
}

async function assertFailureReleasesEnvironment(spawnChild, predicate) {
  let failedRoot;
  await assert.rejects(
    () => startTestApp({
      startupTimeoutMs: 40,
      spawnChild: (...arguments_) => {
        failedRoot = arguments_[1][1];
        return spawnChild();
      }
    }),
    predicate
  );
  assert.ok(failedRoot);
  await assert.rejects(access(failedRoot), (error) => error?.code === 'ENOENT');

  const second = await startTestApp({ spawnChild: () => createChild({ startup: true }) });
  await second.close();
}

test('startTestApp releases the lock after a child spawn error and can acquire it again', { concurrency: false }, async () => {
  await assert.rejects(
    () => startTestApp({ spawnChild: spawnFailureChild }),
    (error) => error?.code === 'EAGAIN'
  );
  await assert.rejects(
    () => startTestApp({ spawnChild: spawnFailureChild }),
    (error) => error?.code === 'EAGAIN'
  );
});

test('startTestApp closes a started child through its close event and releases the lock once', { concurrency: false }, async () => {
  let child;
  const app = await startTestApp({
    spawnChild: () => {
      child = createChild({ startup: true });
      return child;
    }
  });
  await Promise.all([app.close(), app.close()]);
  assert.deepEqual(child.kills, ['SIGTERM']);

  const second = await startTestApp({ spawnChild: () => createChild({ startup: true }) });
  await second.close();
});

test('startTestApp cleans up when a child exits before startup', { concurrency: false }, async () => {
  await assertFailureReleasesEnvironment(
    () => childBeforeStartup('exit'),
    (error) => error?.message.includes('exited before startup')
  );
});

test('startTestApp cleans up when a child closes before startup', { concurrency: false }, async () => {
  await assertFailureReleasesEnvironment(
    () => childBeforeStartup('close'),
    (error) => error?.message.includes('closed before startup')
  );
});

test('startTestApp uses the injected startup timeout and cleans up', { concurrency: false }, async () => {
  await assertFailureReleasesEnvironment(
    () => createChild(),
    (error) => error?.message.includes('startup timed out')
  );
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('startTestApp owns an in-process application lifecycle and restores its environment', { concurrency: false }, async () => {
  const sentinel = 'NOOBAI_START_TEST_APP_IN_PROCESS_SENTINEL';
  const previousSentinel = process.env[sentinel];
  delete process.env[sentinel];
  let closeCalls = 0;
  let root;
  let publicServer;
  let internalServer;
  const app = await startTestApp({
    environmentOverrides: {
      NOOBAI_PUBLIC_PORT: '19582',
      NOOBAI_INTERNAL_PORT: '19583',
      [sentinel]: 'in-process'
    },
    applicationStarter: async ({ root: starterRoot, environment }) => {
      root = starterRoot;
      assert.equal(process.env[sentinel], 'in-process');
      assert.equal(environment[sentinel], 'in-process');
      publicServer = createServer((_request, response) => response.end('public ok'));
      internalServer = createServer((_request, response) => response.end('internal ok'));
      const [publicAddress, internalAddress] = await Promise.all([
        listen(publicServer, Number(environment.NOOBAI_PUBLIC_PORT)),
        listen(internalServer, Number(environment.NOOBAI_INTERNAL_PORT))
      ]);
      return {
        publicAddress,
        internalAddress,
        async close() {
          closeCalls += 1;
          await Promise.all([close(publicServer), close(internalServer)]);
        }
      };
    }
  });
  assert.equal(await (await fetch(app.baseUrl)).text(), 'public ok');
  assert.equal(await (await fetch(app.internalBaseUrl)).text(), 'internal ok');
  assert.equal(app.baseUrl, 'http://127.0.0.1:19582');
  assert.equal(app.internalBaseUrl, 'http://127.0.0.1:19583');
  await Promise.all([app.close(), app.close()]);
  assert.equal(closeCalls, 1);
  await assert.rejects(access(root), (error) => error?.code === 'ENOENT');
  assert.equal(process.env[sentinel], previousSentinel);
});

test('startTestApp applies an undefined override by deleting the in-process environment value', { concurrency: false }, async () => {
  const sentinel = 'NOOBAI_START_TEST_APP_UNDEFINED_OVERRIDE_SENTINEL';
  const previousSentinel = process.env[sentinel];
  process.env[sentinel] = 'host-value';
  let app;
  let second;
  let root;
  try {
    app = await startTestApp({
      environmentOverrides: { [sentinel]: undefined },
      applicationStarter: async ({ root: starterRoot, environment }) => {
        root = starterRoot;
        assert.equal(Object.hasOwn(environment, sentinel), true);
        assert.equal(environment[sentinel], undefined);
        assert.equal(process.env[sentinel], undefined);
        return { close: async () => {} };
      }
    });
    await app.close();
    assert.equal(process.env[sentinel], 'host-value');
    assert.ok(root);
    await assert.rejects(access(root), (error) => error?.code === 'ENOENT');

    second = await startTestApp({ applicationStarter: async () => ({ close: async () => {} }) });
    await second.close();
  } finally {
    await second?.close().catch(() => {});
    await app?.close().catch(() => {});
    if (previousSentinel === undefined) delete process.env[sentinel];
    else process.env[sentinel] = previousSentinel;
  }
});

test('startTestApp restores the host environment when an in-process starter throws its exact error after deletion', { concurrency: false }, async () => {
  const sentinel = 'NOOBAI_START_TEST_APP_UNDEFINED_STARTER_ERROR_SENTINEL';
  const previousSentinel = process.env[sentinel];
  const exactError = new Error('starter failed after deleting host value');
  process.env[sentinel] = 'host-value';
  let root;
  let second;
  try {
    await assert.rejects(
      () => startTestApp({
        environmentOverrides: { [sentinel]: undefined },
        applicationStarter: async ({ root: starterRoot }) => {
          root = starterRoot;
          assert.equal(process.env[sentinel], undefined);
          throw exactError;
        }
      }),
      (error) => error === exactError
    );
    assert.equal(process.env[sentinel], 'host-value');
    assert.ok(root);
    await assert.rejects(access(root), (error) => error?.code === 'ENOENT');

    second = await startTestApp({ applicationStarter: async () => ({ close: async () => {} }) });
    await second.close();
  } finally {
    await second?.close().catch(() => {});
    if (previousSentinel === undefined) delete process.env[sentinel];
    else process.env[sentinel] = previousSentinel;
  }
});

test('startTestApp propagates application close errors after releasing all resources', { concurrency: false }, async () => {
  const sentinel = 'NOOBAI_START_TEST_APP_CLOSE_ERROR_SENTINEL';
  const previousSentinel = process.env[sentinel];
  const closeError = new Error('application close failed for test');
  let root;
  delete process.env[sentinel];
  try {
    const app = await startTestApp({
      environmentOverrides: { [sentinel]: 'close-error' },
      applicationStarter: async ({ root: starterRoot, environment }) => {
        root = starterRoot;
        assert.equal(process.env[sentinel], 'close-error');
        assert.equal(environment[sentinel], 'close-error');
        return { close: async () => { throw closeError; } };
      }
    });
    await assert.rejects(app.close(), (error) => error === closeError);
    assert.equal(process.env[sentinel], previousSentinel);
    await assert.rejects(access(root), (error) => error?.code === 'ENOENT');

    const second = await startTestApp({ spawnChild: () => createChild({ startup: true }) });
    await second.close();
  } finally {
    if (previousSentinel === undefined) delete process.env[sentinel];
    else process.env[sentinel] = previousSentinel;
  }
});

test('startTestApp rejects invalid environment overrides before acquiring resources', { concurrency: false }, async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () => startTestApp({ environmentOverrides: { NOOBAI_PUBLIC_PORT: 19182 } }),
    (error) => error instanceof TypeError && /must be a string/u.test(error.message)
  );
  assert.ok(Date.now() - startedAt < 5_000, 'invalid overrides must not wait for the global lock timeout');

  const second = await startTestApp({ spawnChild: () => createChild({ startup: true }) });
  await second.close();
});
