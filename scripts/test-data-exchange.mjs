import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openCatalogDatabase } from '../app/catalog/database.mjs';
import { exportPackage } from '../app/data-package/package.mjs';
import { importPackage } from '../app/data-package/import.mjs';

const [command, path] = process.argv.slice(2);
assert.ok(['export', 'import'].includes(command) && path, 'Use export OUTPUT or import ARTIFACT_DIRECTORY');
const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'booruflow-exchange-'));
const name = '跨平台 · paisaje · 風景';
const relativeImage = 'sample/参考 image.png';
const sourceImage = resolve(root, 'docs/assets/screenshots/catalog.png');
const environment = {
  NOOBAI_EMBEDDING_BASE_URL: 'http://model.example.invalid/v1',
  NOOBAI_EMBEDDING_API_KEY: 'test', NOOBAI_EMBEDDING_MODEL: 'test-1024',
  NOOBAI_RERANKER_BASE_URL: 'http://model.example.invalid/v1',
  NOOBAI_RERANKER_API_KEY: 'test', NOOBAI_RERANKER_MODEL: 'test-rerank'
};
try {
  if (command === 'export') {
    const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
    try {
      const at = '2026-09-14T00:00:00Z';
      database.prepare('INSERT INTO works(id,name,name_normalized,created_at,updated_at) VALUES(1,?,?,?,?)').run(name, name, at, at);
      database.prepare("INSERT INTO item_images(id,owner_kind,owner_id,content_hash,media_path,sort_order,created_at,updated_at) VALUES(1,'work',1,'fixture',?,0,?,?)").run(relativeImage, at, at);
      database.prepare('UPDATE works SET cover_media_path=? WHERE id=1').run(relativeImage);
      mkdirSync(join(temporary, 'media/sample'), { recursive: true });
      copyFileSync(sourceImage, join(temporary, 'media', relativeImage));
      exportPackage({ database, mediaRoot: join(temporary, 'media'), output: resolve(path) });
      console.log(`Exported ${process.platform}/${process.arch} package`);
    } finally { database.close(); }
  } else {
    const directories = readdirSync(resolve(path), { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.equal(directories.length, 3, 'All three platform artifacts are required');
    for (const entry of directories) {
      const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
      const mediaRoot = join(temporary, entry.name, 'media');
      mkdirSync(mediaRoot, { recursive: true });
      try {
        const result = await importPackage({ database, repositoryRoot: root, environment,
          input: join(resolve(path), entry.name), mediaRoot,
          journalRoot: join(temporary, entry.name, 'batches'),
          modelClient: { embed: async rows => rows.map(() => Array(1024).fill(0.1)) }
        });
        assert.equal(result.vectors, 1);
        assert.equal(database.prepare('SELECT name FROM works WHERE id=1').get().name, name);
        assert.equal(database.prepare('SELECT cover_media_path FROM works WHERE id=1').get().cover_media_path, relativeImage);
        assert.equal(database.prepare('SELECT count(*) n FROM vector_knn_index').get().n, 1);
        assert.deepEqual(readFileSync(join(mediaRoot, relativeImage)), readFileSync(sourceImage));
        console.log(`Imported ${entry.name} on ${process.platform}/${process.arch}: records, image and KNN verified`);
      } finally { database.close(); }
    }
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
