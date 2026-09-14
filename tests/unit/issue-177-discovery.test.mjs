import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { parseDocument, stringify } from 'yaml';

import { assertSemanticDiscoveryMatchesRuntime, buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { assertSemanticHandlerRoutesMatchRuntime, SEMANTIC_HANDLER_ROUTE_MANIFEST } from '../../app/http/semantic-handler-routes.mjs';
import { assertRuntimeRouteInventory } from '../../app/http/runtime-operations.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const rootOpenapiPath = resolve(repositoryRoot, 'schema/api/openapi.yaml');

function resolveLocalDiscoveryReference(discovery, reference) {
  assert.match(reference, /^#\/components\/(schemas|responses|parameters|requestBodies|headers|securitySchemes)\//u);
  let current = discovery;
  for (const segment of reference.slice(1).split('/').slice(1)) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    assert.ok(current !== null && typeof current === 'object' && Object.hasOwn(current, key), `discovery reference is unresolved: ${reference}`);
    current = current[key];
  }
  return current;
}

function collectReferences(value, references = []) {
  if (Array.isArray(value)) value.forEach((item) => collectReferences(item, references));
  else if (value !== null && typeof value === 'object') {
    if (typeof value.$ref === 'string') references.push(value.$ref);
    Object.values(value).forEach((item) => collectReferences(item, references));
  }
  return references;
}

async function writeMutation(mutator) {
  const directory = await mkdtemp(join(tmpdir(), 'noobai-issue-177-discovery-mutation-'));
  const path = join(directory, 'openapi.yaml');
  const document = parseDocument(await readFile(rootOpenapiPath, 'utf8')).toJS();
  await writeFile(path, stringify(mutator(document)));
  return Object.freeze({ directory, path });
}

test('Issue #177 discovery filters the root OpenAPI to the implemented Catalog operations and closes references', () => {
  const discovery = buildSemanticDiscovery();
  assert.equal(discovery.openapi, '3.1.0');
  assert.deepEqual(Object.keys(discovery.paths), [
    '/internal/semantic/base-models',
    '/internal/semantic/generation-models',
    '/internal/semantic/loras',
    '/internal/semantic/works',
    '/internal/semantic/characters',
    '/internal/semantic/styles',
    '/internal/semantic/prompt-terms',
    '/internal/semantic/artist-prompt-strings',
    '/internal/semantic/comfyui-instances',
    '/internal/semantic/comfyui-templates'
  ]);
  assert.deepEqual(Object.values(discovery.paths).flatMap((path) => Object.values(path).map((operation) => operation.operationId)), [
    'querySemanticBaseModelsForSkill',
    'querySemanticGenerationModelsForSkill',
    'querySemanticLorasForSkill',
    'querySemanticWorksForSkill',
    'querySemanticCharactersForSkill',
    'querySemanticStylesForSkill',
    'querySemanticPromptTermsForSkill',
    'querySemanticArtistPromptStringsForSkill',
    'querySemanticComfyuiInstancesForSkill',
    'querySemanticComfyuiTemplatesForSkill'
  ]);
  assert.equal(Object.keys(discovery.components.parameters ?? {}).length, 0);
  assert.ok(Object.keys(discovery.components.schemas).length > 0);
  assert.equal(JSON.stringify(discovery).includes('/api/'), false);
  for (const reference of collectReferences(discovery)) assert.ok(resolveLocalDiscoveryReference(discovery, reference));
});

test('Issue #177 discovery startup validation rejects documentation and reference mutations', async () => {
  const malformedDirectory = await mkdtemp(join(tmpdir(), 'noobai-issue-177-discovery-malformed-'));
  const missingPath = join(malformedDirectory, 'missing.yaml');
  const parseErrorPath = join(malformedDirectory, 'parse-error.yaml');
  await writeFile(parseErrorPath, 'openapi: [');
  try {
    assert.throws(() => buildSemanticDiscovery({ openapiPath: missingPath }), /missing/u);
    assert.throws(() => buildSemanticDiscovery({ openapiPath: parseErrorPath }), /parsing failed/u);
  } finally { await rm(malformedDirectory, { recursive: true, force: true }); }
  const mutations = [
    (document) => { document.paths['/internal/semantic-discovery'] = document.paths['/internal/semantic']; delete document.paths['/internal/semantic']; return document; },
    (document) => { document.paths['/internal/semantic'].post = document.paths['/internal/semantic'].get; delete document.paths['/internal/semantic'].get; return document; },
    (document) => { document.paths['/internal/semantic'].get.operationId = 'getSemanticDiscoveryChanged'; return document; },
    (document) => { delete document.paths['/internal/semantic/base-models'].post.summary; return document; },
    (document) => { delete document.paths['/internal/semantic/base-models'].post.description; return document; },
    (document) => { delete document.components.schemas.CatalogBaseModelSearchRequest.properties.query.description; return document; },
    (document) => { delete document.components.schemas.CatalogBaseModelSearchRequest.properties.query.example; return document; },
    (document) => { delete document.components.schemas.CatalogBaseModelSearchRequest.properties.page.description; return document; },
    (document) => { delete document.components.schemas.CatalogBaseModelSearchRequest.properties.page.example; return document; },
    (document) => { delete document.components.responses.CatalogBaseModelPage.description; return document; },
    (document) => { delete document.components.responses.CatalogBaseModelPage.content['application/json'].examples; return document; },
    (document) => { document.paths['/internal/semantic/base-models'].post.responses['200'].$ref = '#/components/responses/Missing'; return document; },
    (document) => { document.paths['/internal/semantic/base-models'].post.requestBody.content['application/json'].schema.$ref = '#/components/schemas/CatalogCharacterRequest'; return document; }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = await writeMutation(mutate);
    try { assert.throws(() => buildSemanticDiscovery({ openapiPath: fixture.path }), undefined, `mutation ${index}`); }
    finally { await rm(fixture.directory, { recursive: true, force: true }); }
  }
});

test('Issue #222 discovery rejects a repository-external multi-level relative reference before reading the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-222-discovery-relative-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'noobai-issue-222-discovery-relative-outside-'));
  const apiDirectory = join(root, 'schema', 'api');
  const openapiPath = join(apiDirectory, 'openapi.yaml');
  const externalSchemaPath = join(outside, 'external.schema.json');
  try {
    await mkdir(apiDirectory, { recursive: true });
    const document = parseDocument(await readFile(rootOpenapiPath, 'utf8')).toJS();
    const relativeReference = `${relative(apiDirectory, externalSchemaPath).split(sep).join('/')}#/definitions/ExternalValue`;
    assert.equal(relativeReference.startsWith('../'), true);
    assert.equal(relative(root, externalSchemaPath).startsWith('..'), true);
    document.components.schemas.RepositoryExternalReferenceProbe = {
      type: 'object',
      properties: { external: { $ref: relativeReference } }
    };
    await writeFile(openapiPath, stringify(document));
    await writeFile(externalSchemaPath, JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      definitions: { ExternalValue: { type: 'string' } }
    }));
    assert.throws(
      () => buildSemanticDiscovery({ repositoryRoot: root }),
      (error) => /outside|repository|relative|external|boundary/u.test(error.message)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Issue #222 discovery rejects a referenced schema symlink before reading its external target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-222-discovery-symlink-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'noobai-issue-222-discovery-symlink-outside-'));
  const apiDirectory = join(root, 'schema', 'api');
  const openapiPath = join(apiDirectory, 'openapi.yaml');
  const externalSchemaPath = join(outside, 'external.schema.json');
  try {
    await mkdir(apiDirectory, { recursive: true });
    const document = parseDocument(await readFile(rootOpenapiPath, 'utf8')).toJS();
    document.components.schemas.RepositorySymlinkReferenceProbe = {
      type: 'object',
      properties: { external: { $ref: 'linked.schema.json#/definitions/ExternalValue' } }
    };
    await writeFile(openapiPath, stringify(document));
    await writeFile(externalSchemaPath, JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      definitions: { ExternalValue: { type: 'string' } }
    }));
    await symlink(externalSchemaPath, join(apiDirectory, 'linked.schema.json'));
    assert.throws(
      () => buildSemanticDiscovery({ repositoryRoot: root }),
      (error) => /symlink|regular|canonical|repository/u.test(error.message)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Issue #177 discovery detects declared-operation and implemented-handler drift', () => {
  const discovery = buildSemanticDiscovery();
  const missing = assertRuntimeRouteInventory(SEMANTIC_HANDLER_ROUTE_MANIFEST.filter((route) => route.operationId !== 'querySemanticBaseModelsForSkill'));
  assert.throws(() => assertSemanticDiscoveryMatchesRuntime(discovery, missing), /differ/u);
  const extra = assertRuntimeRouteInventory([
    ...SEMANTIC_HANDLER_ROUTE_MANIFEST,
    { listener: 'internal', method: 'post', path: '/internal/semantic/extra', operationId: 'querySemanticExtraForSkill' }
  ]);
  assert.throws(() => assertSemanticDiscoveryMatchesRuntime(discovery, extra), /differ/u);
  for (const [property, value] of [['method', 'post'], ['path', '/internal/semantic/drift'], ['operationId', 'querySemanticDriftForSkill']]) {
    const mutated = SEMANTIC_HANDLER_ROUTE_MANIFEST.map((route, index) => index === 0 ? { ...route, [property]: value } : route);
    assert.throws(() => assertSemanticHandlerRoutesMatchRuntime({
      manifest: mutated,
      runtimeRouteInventory: SEMANTIC_HANDLER_ROUTE_MANIFEST
    }), /differs/u);
  }
});
