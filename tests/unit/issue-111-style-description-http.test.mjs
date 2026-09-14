import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const NOW = '2026-08-03T00:00:00Z';
const STYLE_BASE_MODEL_ID = 11102;
const STYLE_FIELDS = ['aliases', 'character_ids', 'cover_media_path', 'id', 'image_count', 'is_available', 'name', 'prompt_text', 'style_description', 'work_id', 'work_name'];

function fixture() {
  const database = openCatalogDatabase();
  database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, 'wai', ?, ?)").run(STYLE_BASE_MODEL_ID, NOW, NOW);
  database.prepare(`INSERT INTO styles(
    id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
  ) VALUES (11111, ?, 'Blank Style', '["空白"]', 'blank prompt', NULL, NULL),
           (11112, ?, 'Described Style', '["描述"]', 'described prompt', NULL, NULL)`)
    .run(STYLE_BASE_MODEL_ID, STYLE_BASE_MODEL_ID);
  database.prepare('UPDATE styles SET style_description = ? WHERE id = 11112').run('cool restrained palette with dry texture');
  const service = createCatalogService({ database, repository: createCatalogRepository(database) });
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper() });
  return { database, dispatcher };
}

test('Issue #111 exposes nullable style_description from both Style collection and detail GET routes', () => {
  const { database, dispatcher } = fixture();
  try {
    const list = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/styles', requestId: 'issue-111-list' });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.items.map(({ id, style_description }) => ({ id, style_description })), [
      { id: 11111, style_description: null },
      { id: 11112, style_description: 'cool restrained palette with dry texture' }
    ]);
    for (const item of list.body.data.items) assert.deepEqual(Object.keys(item).sort(), [...STYLE_FIELDS].sort());

    const empty = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/styles/11111', requestId: 'issue-111-empty' });
    const described = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/styles/11112', requestId: 'issue-111-described' });
    assert.equal(empty.status, 200);
    assert.equal(described.status, 200);
    assert.equal(empty.body.data.style_description, null);
    assert.equal(described.body.data.style_description, 'cool restrained palette with dry texture');
    assert.deepEqual(Object.keys(empty.body.data).sort(), [...STYLE_FIELDS].sort());
    assert.deepEqual(Object.keys(described.body.data).sort(), [...STYLE_FIELDS].sort());
  } finally {
    database.close();
  }
});
