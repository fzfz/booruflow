import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

function utc(now) {
  return now().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function relativeMediaPath(imagesRoot, path) {
  const value = relative(imagesRoot, path);
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || value.includes(`..${sep}`) || value.includes('\\')) {
    throw new Error('media file escapes the configured images root');
  }
  return `images/${value.split(sep).join('/')}`;
}

function listRegularMediaPaths(imagesRoot) {
  if (!existsSync(imagesRoot)) return [];
  const result = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw new Error(`symbolic link is not permitted in the media directory: ${entry.name}`);
      if (status.isDirectory()) {
        visit(path);
      } else if (status.isFile()) {
        result.push(relativeMediaPath(imagesRoot, path));
      }
    }
  }
  visit(imagesRoot);
  return result.sort();
}

function writeReport(reportRoot, report) {
  const target = resolve(reportRoot, 'media-maintenance-latest.json');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

export function createMediaMaintenanceTask({ database, mediaStorage, cleanupQueue, reportRoot, now = () => new Date() } = {}) {
  if (!database || typeof database.prepare !== 'function') throw new Error('database is required');
  if (!mediaStorage || typeof mediaStorage.remove !== 'function' || typeof mediaStorage.imagesRoot !== 'string') throw new Error('mediaStorage is required');
  if (!cleanupQueue || typeof cleanupQueue.enqueue !== 'function' || typeof cleanupQueue.drain !== 'function') throw new Error('cleanupQueue is required');
  if (typeof reportRoot !== 'string' || reportRoot.length === 0) throw new Error('reportRoot is required');

  function removeQueuedPath(path) {
    try {
      mediaStorage.remove(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }

  function run() {
    const before = cleanupQueue.drain(removeQueuedPath);
    const referencedPaths = database.prepare('SELECT media_path FROM item_images ORDER BY media_path').all()
      .map(({ media_path: mediaPath }) => mediaPath)
      .filter((mediaPath) => typeof mediaPath === 'string');
    const referenced = new Set(referencedPaths);
    const mediaPaths = listRegularMediaPaths(mediaStorage.imagesRoot);
    const present = new Set(mediaPaths);
    const missingMediaPaths = referencedPaths.filter((mediaPath) => !present.has(mediaPath));
    const orphanMediaPaths = mediaPaths.filter((mediaPath) => !referenced.has(mediaPath));
    for (const path of orphanMediaPaths) cleanupQueue.enqueue({ path, reason: 'orphan_cleanup' });
    const orphanCleanup = cleanupQueue.drain(removeQueuedPath);
    const pending = cleanupQueue.read().entries.map((entry) => entry.path);
    const report = Object.freeze({
      report_version: 1,
      generated_at: utc(now),
      status: missingMediaPaths.length > 0 || pending.length > 0 ? 'attention_required' : 'completed',
      database_relations: Object.freeze({
        referenced_media_paths: Object.freeze(referencedPaths),
        missing_media_paths: Object.freeze(missingMediaPaths)
      }),
      file_system: Object.freeze({
        orphan_media_paths: Object.freeze(orphanMediaPaths.filter((path) => !orphanCleanup.completed.includes(path)))
      }),
      cleanup: Object.freeze({
        completed_paths: Object.freeze([...before.completed, ...orphanCleanup.completed]),
        pending_paths: Object.freeze(pending)
      })
    });
    const reportPath = writeReport(reportRoot, report);
    return Object.freeze({ ...report, report_path: reportPath });
  }

  return Object.freeze({ run });
}
