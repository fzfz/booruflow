import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { validateJsonSample } from '../contracts/authoritative-contracts.mjs';
import { loadFileCleanupContracts } from '../contracts/file-cleanup-contracts.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';

function nowUtc(clock) {
  return clock().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function isInside(root, target) {
  const remainder = relative(root, target);
  return remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`) && !remainder.includes(`..${sep}`);
}

export function createFileCleanupQueue({ queuePath, mediaRoot, now = () => new Date(), repositoryRoot } = {}) {
  if (typeof queuePath !== 'string' || queuePath.length === 0) throw new Error('queuePath is required');
  if (typeof mediaRoot !== 'string' || mediaRoot.length === 0) throw new Error('mediaRoot is required');
  const resolvedQueuePath = resolve(queuePath);
  const resolvedMediaRoot = resolve(mediaRoot);
  const imagesRoot = resolve(resolvedMediaRoot, 'images');
  const contracts = loadFileCleanupContracts(repositoryRoot);
  const { schemaPath } = contracts;

  function emptyQueue() {
    return { queue_version: 1, updated_at: nowUtc(now), entries: [], audit_failures: [] };
  }

  function assertEntryPath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\u0000') || path.includes('\\')) {
      throw new Error('cleanup path must be a non-empty slash-separated relative path');
    }
    const target = resolve(resolvedMediaRoot, path);
    if (!isInside(imagesRoot, target)) throw new Error('cleanup path escapes data/media/images');
    return target;
  }

  function validate(queue) {
    const failures = validateJsonSample(queue, schemaPath, contracts.schemas);
    if (failures.length > 0) throw new ApplicationError('FILE_OPERATION_FAILED', `cleanup queue is invalid: ${failures[0]}`);
    for (const entry of queue.entries) assertEntryPath(entry.path);
    return queue;
  }

  function read() {
    try {
      return validate(JSON.parse(readFileSync(resolvedQueuePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyQueue();
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('FILE_OPERATION_FAILED', `cleanup queue cannot be read: ${error.message}`);
    }
  }

  function write(queue) {
    validate(queue);
    const directory = dirname(resolvedQueuePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${resolvedQueuePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(queue, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporaryPath, resolvedQueuePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('FILE_OPERATION_FAILED', `cleanup queue cannot be persisted: ${error.message}`);
    }
  }

  function enqueue({ path, reason, error = null }) {
    assertEntryPath(path);
    const queue = read();
    const existing = queue.entries.find((entry) => entry.path === path);
    const next = existing
      ? { ...existing, reason, last_error: error === null ? null : String(error).slice(0, 1024) }
      : { path, reason, queued_at: nowUtc(now), attempts: 0, ...(error === null ? {} : { last_error: String(error).slice(0, 1024) }) };
    const entries = existing ? queue.entries.map((entry) => entry.path === path ? next : entry) : [...queue.entries, next];
    const updated = { queue_version: 1, updated_at: nowUtc(now), entries, ...(queue.audit_failures === undefined ? {} : { audit_failures: queue.audit_failures }) };
    write(updated);
    return Object.freeze(next);
  }

  function recordFailure({ path, reason, remove_error: removeError, enqueue_error: enqueueError }) {
    assertEntryPath(path);
    const queue = read();
    const failure = {
      path,
      reason,
      occurred_at: nowUtc(now),
      remove_error: String(removeError).slice(0, 1024),
      enqueue_error: String(enqueueError).slice(0, 1024)
    };
    const updated = {
      queue_version: 1,
      updated_at: nowUtc(now),
      entries: queue.entries,
      audit_failures: [...(queue.audit_failures ?? []), failure]
    };
    write(updated);
    return Object.freeze(failure);
  }

  function drain(remove) {
    if (typeof remove !== 'function') throw new Error('remove must be a function');
    const queue = read();
    const remaining = [];
    const completed = [];
    for (const entry of queue.entries) {
      try {
        remove(entry.path);
        completed.push(entry.path);
      } catch (error) {
        remaining.push({ ...entry, attempts: entry.attempts + 1, last_error: String(error?.message ?? error).slice(0, 1024) });
      }
    }
    write({ queue_version: 1, updated_at: nowUtc(now), entries: remaining, ...(queue.audit_failures === undefined ? {} : { audit_failures: queue.audit_failures }) });
    return Object.freeze({ completed: Object.freeze(completed), pending: Object.freeze(remaining) });
  }

  return Object.freeze({ queuePath: resolvedQueuePath, mediaRoot: resolvedMediaRoot, read, enqueue, recordFailure, drain });
}
