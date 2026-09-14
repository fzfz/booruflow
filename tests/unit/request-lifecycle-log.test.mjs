import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REQUEST_LIFECYCLE_EVENTS, createRequestLifecycleLogger } from '../../app/diagnostics/request-lifecycle-log.mjs';

test('request lifecycle logger writes only the event contract fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-request-lifecycle-'));
  const logFile = join(root, 'diagnostics/request-lifecycle.jsonl');
  try {
    const logger = createRequestLifecycleLogger({ logFile, now: () => new Date('2026-08-07T10:00:00.000Z') });
    await logger.initialize();
    await logger.record({
      event: REQUEST_LIFECYCLE_EVENTS.HTTP_REQUEST_RECEIVED,
      request_id: 'trace-1',
      listener: 'public',
      method: 'POST',
      path: '/api/manage/works',
      body: { user_text: 'must not be logged' },
      headers: { authorization: 'must not be logged' }
    });
    const event = JSON.parse((await readFile(logFile, 'utf8')).trim());
    assert.deepEqual(event, {
      timestamp: '2026-08-07T10:00:00.000Z',
      level: 'debug',
      event: 'http.request.received',
      request_id: 'trace-1',
      listener: 'public',
      method: 'POST',
      path: '/api/manage/works'
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('request lifecycle logger filters below the configured level and rotates retained files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-request-lifecycle-'));
  const logFile = join(root, 'diagnostics/request-lifecycle.jsonl');
  try {
    const logger = createRequestLifecycleLogger({ logFile, level: 'info', maxFileBytes: 180, maxArchives: 2 });
    await logger.initialize();
    await logger.record({ event: REQUEST_LIFECYCLE_EVENTS.HTTP_REQUEST_RECEIVED, request_id: 'filtered', listener: 'public', method: 'GET', path: '/api/a' });
    await logger.record({ event: REQUEST_LIFECYCLE_EVENTS.HTTP_RESPONSE_COMPLETED, request_id: 'one', listener: 'public', method: 'GET', path: '/api/a', operation_id: 'listWorks', status: 200, duration_ms: 1 });
    await logger.record({ event: REQUEST_LIFECYCLE_EVENTS.HTTP_RESPONSE_COMPLETED, request_id: 'two', listener: 'public', method: 'GET', path: '/api/b', operation_id: 'listCharacters', status: 404, error_code: 'NOT_FOUND', duration_ms: 2 });
    await logger.record({ event: REQUEST_LIFECYCLE_EVENTS.HTTP_RESPONSE_COMPLETED, request_id: 'three', listener: 'public', method: 'GET', path: '/api/c', operation_id: 'listStyles', status: 500, error_code: 'INTERNAL_ERROR', duration_ms: 3 });
    const files = await Promise.all([
      readFile(logFile, 'utf8'),
      readFile(`${logFile}.1`, 'utf8'),
      readFile(`${logFile}.2`, 'utf8')
    ]);
    const serialized = files.join('\n');
    assert.equal(serialized.includes('filtered'), false);
    assert.equal(serialized.includes('one'), true);
    assert.equal(serialized.includes('two'), true);
    assert.equal(serialized.includes('three'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('request lifecycle logger reports append failures as structured stderr diagnostics', async () => {
  const failures = [];
  const logger = createRequestLifecycleLogger({
    logFile: '/fixture/request-lifecycle.jsonl',
    initializeStorage: async () => {},
    appendLine: async () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); },
    onWriteError: (line) => failures.push(JSON.parse(line)),
    now: () => new Date('2026-08-07T10:00:00.000Z')
  });
  await logger.initialize();
  await logger.record({ event: REQUEST_LIFECYCLE_EVENTS.HTTP_REQUEST_RECEIVED, request_id: 'trace-2', listener: 'public', method: 'GET', path: '/api/works' });
  assert.deepEqual(failures, [{
    timestamp: '2026-08-07T10:00:00.000Z',
    event: 'diagnostic.write_failed',
    log: 'request-lifecycle',
    attempted_event: 'http.request.received',
    request_id: 'trace-2',
    error_code: 'EIO',
    message: 'request lifecycle diagnostic write failed'
  }]);
});
