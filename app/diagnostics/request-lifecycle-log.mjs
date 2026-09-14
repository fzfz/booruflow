import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export const REQUEST_LIFECYCLE_EVENTS = Object.freeze({
  HTTP_REQUEST_RECEIVED: 'http.request.received',
  HTTP_RESPONSE_COMPLETED: 'http.response.completed'
});

const EVENT_FIELDS = Object.freeze({
  [REQUEST_LIFECYCLE_EVENTS.HTTP_REQUEST_RECEIVED]: Object.freeze(['request_id', 'listener', 'method', 'path']),
  [REQUEST_LIFECYCLE_EVENTS.HTTP_RESPONSE_COMPLETED]: Object.freeze(['request_id', 'listener', 'method', 'path', 'operation_id', 'status', 'error_code', 'duration_ms'])
});

const LEVEL_WEIGHTS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

function eventLevel(entry) {
  if (entry.event === REQUEST_LIFECYCLE_EVENTS.HTTP_REQUEST_RECEIVED) return 'debug';
  if (entry.event === REQUEST_LIFECYCLE_EVENTS.HTTP_RESPONSE_COMPLETED) {
    if (entry.status >= 500) return 'error';
    if (entry.status >= 400) return 'warn';
  }
  return 'info';
}

function canonicalEvent(entry, now) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('request lifecycle event must be an object');
  const fields = EVENT_FIELDS[entry.event];
  if (fields === undefined) throw new TypeError(`unknown request lifecycle event: ${String(entry.event)}`);
  const event = { timestamp: now().toISOString(), level: eventLevel(entry), event: entry.event };
  for (const field of fields) {
    if (entry[field] !== undefined) event[field] = entry[field];
  }
  return Object.freeze(event);
}

function writeFailure({ attemptedEvent, error, now }) {
  return JSON.stringify({
    timestamp: now().toISOString(),
    event: 'diagnostic.write_failed',
    log: 'request-lifecycle',
    attempted_event: attemptedEvent.event,
    request_id: attemptedEvent.request_id ?? null,
    error_code: typeof error?.code === 'string' ? error.code : 'DIAGNOSTIC_WRITE_FAILED',
    message: 'request lifecycle diagnostic write failed'
  });
}

export function createRequestLifecycleLogger({
  logFile,
  level = 'debug',
  maxFileBytes = 10 * 1024 * 1024,
  maxArchives = 5,
  now = () => new Date(),
  initializeStorage = async () => { await mkdir(dirname(logFile), { recursive: true }); await appendFile(logFile, ''); },
  appendLine = (line) => appendFile(logFile, line),
  onWriteError = (line) => console.error(line),
  fileStat = (path) => stat(path),
  renameFile = (source, target) => rename(source, target),
  removeFile = (path) => rm(path, { force: true })
} = {}) {
  if (typeof logFile !== 'string' || logFile.length === 0) throw new TypeError('request lifecycle logFile is required');
  if (!Object.hasOwn(LEVEL_WEIGHTS, level)) throw new TypeError('request lifecycle level is invalid');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || !Number.isSafeInteger(maxArchives) || maxArchives < 1) throw new TypeError('request lifecycle rotation limits must be positive integers');
  if ([now, initializeStorage, appendLine, onWriteError, fileStat, renameFile, removeFile].some((dependency) => typeof dependency !== 'function')) {
    throw new TypeError('request lifecycle logger dependencies must be functions');
  }
  async function rotateIfNeeded(line) {
    let currentSize;
    try { currentSize = (await fileStat(logFile)).size; } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (currentSize === 0 || currentSize + Buffer.byteLength(line) <= maxFileBytes) return;
    await removeFile(`${logFile}.${maxArchives}`);
    for (let index = maxArchives - 1; index >= 1; index -= 1) {
      try { await renameFile(`${logFile}.${index}`, `${logFile}.${index + 1}`); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await renameFile(logFile, `${logFile}.1`);
  }
  let queue = Promise.resolve();
  return Object.freeze({
    logFile,
    async initialize() {
      await initializeStorage();
    },
    record(entry) {
      const event = canonicalEvent(entry, now);
      if (LEVEL_WEIGHTS[event.level] > LEVEL_WEIGHTS[level]) return queue;
      const line = `${JSON.stringify(event)}\n`;
      const write = queue.then(async () => { await rotateIfNeeded(line); await appendLine(line); });
      queue = write.catch((error) => { onWriteError(writeFailure({ attemptedEvent: event, error, now })); });
      return queue;
    }
  });
}
