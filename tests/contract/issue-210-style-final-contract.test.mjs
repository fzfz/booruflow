import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { loadAuthoritativeContracts, validateJsonSample } from '../../app/contracts/authoritative-contracts.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';
import { validationErrors } from '../../app/contracts/json-schema-validation.mjs';
import { createStyleSemanticService, createStyleVectorMaintenance } from '../../app/vector/style-semantic.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const NOW = '2026-08-05T00:00:00Z';
const STYLE_FIELDS = Object.freeze(['id', 'name', 'aliases', 'prompt_text', 'style_description']);

function readYaml(path) {
  return parseDocument(readFileSync(path, 'utf8'), { strict: true }).toJS();
}

function pointerValue(value, pointer) {
  return pointer.slice(1).split('/').reduce((current, segment) => current[segment.replace(/~1/g, '/').replace(/~0/g, '~')], value);
}

function validate(schema, value, document) {
  return validationErrors(value, schema, {
    context: 'schema/api/openapi.yaml',
    resolveReference(reference) {
      assert.match(reference, /^#\//u);
      return { schema: pointerValue(document, reference.slice(1)), context: 'schema/api/openapi.yaml' };
    }
  });
}

test('Issue #210 public semantic Style 200 body validates without category_name', async () => {
  const rootOpenApi = readYaml(resolve(repositoryRoot, 'schema/api/openapi.yaml'));
  const schema = rootOpenApi.components.schemas.SemanticStyle;
  assert.deepEqual(schema.required, STYLE_FIELDS);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...STYLE_FIELDS].sort());
  assert.equal(Object.hasOwn(schema.properties, 'category_name'), false);

  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(21001, 'wai', NOW, NOW);
    database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
      VALUES (?, ?, 'watercolor', '["aqua"]', 'wet paint', 'soft color wash', NULL)`).run(21001, 21001);
    const modelClient = Object.freeze({
      async embed(inputs) { return inputs.map(() => createFixtureVector()); },
      async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 - index / 100 })); }
    });
    const configuration = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });
    await createStyleVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }).rebuild({ reset: true });
    const semantic = createStyleSemanticService({ database, modelClient, configuration });
    const dispatcher = createCatalogHttpDispatcher({
      service: Object.freeze({ searchSemanticStyles: semantic.searchPublic }),
      errorMapper: createErrorMapper()
    });
    const response = await dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/semantic/styles?q=watercolor&base_model_name=wai&limit=1' });
    assert.equal(response.status, 200);
    assert.deepEqual(validate(rootOpenApi.components.schemas.SemanticStyle, response.body.data.items[0], rootOpenApi), []);
    assert.equal(Object.hasOwn(response.body.data.items[0], 'category_name'), false);
  } finally {
    database.close();
  }
});

test('Issue #210 crawler Style identity schemas require the base-model/name identity', () => {
  const rootCommon = JSON.parse(readFileSync(resolve(repositoryRoot, 'schema/crawler/common.schema.json'), 'utf8'));
  const styleIdentity = rootCommon.$defs.styleIdentity;
  assert.deepEqual(styleIdentity.required, ['kind', 'base_model_id', 'normalized_name']);
  assert.deepEqual(styleIdentity.properties.base_model_id, { type: 'integer', minimum: 1 });
  const catalogPath = resolve(repositoryRoot, 'schema/crawler/catalog-entry.schema.json');
  const catalogEntry = JSON.parse(readFileSync(catalogPath, 'utf8'));
  assert.match(catalogEntry.description, /画风 category_name 仅为来源证据，不写入 styles/u);
  assert.doesNotMatch(catalogEntry.description, /展示为未分类/u);
});

test('Issue #210 detail-result style schema rejects legacy source fields', () => {
  const rootPath = resolve(repositoryRoot, 'schema/crawler/detail-result.schema.json');

  const contracts = loadAuthoritativeContracts(repositoryRoot);
  const validStyleDetail = {
    identity: { kind: 'style', base_model_id: 9901, parent_identity: 'root', normalized_name: '示例画风' },
    base_model_id: 9901,
    source_url: 'https://api-ai.acofork.com/api/library?mode=WAI',
    name: '示例画风',
    aliases: [],
    prompt_text: 'soft watercolor',
    style_description: null,
    image_results: [],
    fetched_at: NOW
  };
  assert.deepEqual(validateJsonSample(validStyleDetail, rootPath, contracts.schemas), []);

  const legacyStyleDetail = {
    ...validStyleDetail,
    category_name: null,
    source_version: 'WAI',
    source_updated_at: null
  };
  assert.notDeepEqual(validateJsonSample(legacyStyleDetail, rootPath, contracts.schemas), []);
});
