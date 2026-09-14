import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const MEDIA_PATHS = Object.freeze({
  collection: '/api/items/{owner_kind}/{owner_id}/images',
  order: '/api/items/{owner_kind}/{owner_id}/images/order',
  cover: '/api/items/{owner_kind}/{owner_id}/cover',
  image: '/api/items/{owner_kind}/{owner_id}/images/{id}'
});
const MEDIA_OPERATIONS = Object.freeze([
  Object.freeze({ key: 'list', method: 'get', path: MEDIA_PATHS.collection, success: '200', write: false }),
  Object.freeze({ key: 'upload', method: 'post', path: MEDIA_PATHS.collection, success: '201', write: true }),
  Object.freeze({ key: 'reorder', method: 'put', path: MEDIA_PATHS.order, success: '200', write: true }),
  Object.freeze({ key: 'setCover', method: 'put', path: MEDIA_PATHS.cover, success: '200', write: true }),
  Object.freeze({ key: 'delete', method: 'delete', path: MEDIA_PATHS.image, success: '200', write: true })
]);
const DOCUMENTS = Object.freeze([
  Object.freeze({
    label: 'root OpenAPI',
    path: 'schema/api/openapi.yaml',
    successResponse: 'MediaSnapshot',
    forbiddenResponse: 'E403Write',
    notFoundResponse: 'E404',
    operationIds: Object.freeze({ list: 'listImages', upload: 'uploadImages', reorder: 'reorderImages', setCover: 'setCover', delete: 'deleteImage' })
  })
]);

function loadDocument(spec) {
  return parseYaml(readFileSync(resolve(root, spec.path), 'utf8'));
}

function schemaRef(name) {
  return `#/components/schemas/${name}`;
}

function responseRef(name) {
  return `#/components/responses/${name}`;
}

function assertResponseCode(document, responseName, code, label) {
  const response = document.components?.responses?.[responseName];
  assert.ok(response, `${label} is missing response ${responseName}`);
  const responseSchema = response.content?.['application/json']?.schema;
  assert.ok(responseSchema?.$ref, `${label} response ${responseName} must expose an error schema`);
  const errorSchemaName = responseSchema.$ref.split('/').at(-1);
  const errorSchema = document.components?.schemas?.[errorSchemaName];
  assert.ok(errorSchema, `${label} response ${responseName} references missing schema ${errorSchemaName}`);
  const errorCode = errorSchema.allOf?.find((part) => part.properties?.error)?.properties?.error?.properties?.code;
  assert.ok(errorCode, `${label} response ${responseName} must constrain error.code`);
  assert.equal(errorCode.const, code, `${label} response ${responseName} must declare ${code}`);
}

function assertSuccessEnvelope(document, spec) {
  const response = document.components?.responses?.[spec.successResponse];
  assert.ok(response, `${spec.label} is missing top-level ${spec.successResponse}`);
  const schema = response.content?.['application/json']?.schema;
  assert.ok(schema?.allOf, `${spec.label} ${spec.successResponse} must define an application/json envelope schema`);
  assert.ok(schema.allOf.some((part) => part.$ref === schemaRef('Envelope')), `${spec.label} ${spec.successResponse} must reuse Envelope`);
  assert.ok(
    schema.allOf.some((part) => part.properties?.data?.$ref === schemaRef('MediaSnapshot')),
    `${spec.label} ${spec.successResponse} must expose data as MediaSnapshot`
  );
}

function assertMediaContract(document, spec) {
  const ownerKind = document.components?.parameters?.OwnerKind?.schema;
  assert.ok(ownerKind, `${spec.label} is missing OwnerKind`);
  assert.ok(ownerKind.enum?.includes('model'), `${spec.label} OwnerKind must include model`);
  const orderedOwnerKind = document.components?.parameters?.OrderedImageOwnerKind?.schema;
  if (orderedOwnerKind) assert.ok(orderedOwnerKind.enum?.includes('model'), `${spec.label} OrderedImageOwnerKind must include model`);

  const mediaSnapshot = document.components?.schemas?.MediaSnapshot;
  assert.ok(mediaSnapshot, `${spec.label} is missing MediaSnapshot`);
  assert.equal(mediaSnapshot.type, 'object', `${spec.label} MediaSnapshot must be an object`);
  assert.equal(mediaSnapshot.additionalProperties, false, `${spec.label} MediaSnapshot must reject unknown fields`);
  for (const field of ['owner_kind', 'owner_id', 'cover_media_path', 'images', 'cleanup_warning']) {
    assert.ok(mediaSnapshot.required?.includes(field), `${spec.label} MediaSnapshot must require ${field}`);
  }
  assert.ok(mediaSnapshot.properties.owner_kind.enum?.includes('model'), `${spec.label} MediaSnapshot.owner_kind must include model`);
  assert.deepEqual(mediaSnapshot.properties.cleanup_warning, { type: 'boolean' }, `${spec.label} MediaSnapshot.cleanup_warning must be boolean`);
  assertSuccessEnvelope(document, spec);

  for (const operation of MEDIA_OPERATIONS) {
    const path = document.paths?.[operation.path];
    assert.ok(path, `${spec.label} is missing media path ${operation.path}`);
    const actual = path[operation.method];
    assert.ok(actual, `${spec.label} is missing ${operation.method.toUpperCase()} ${operation.path}`);
    assert.equal(actual.operationId, spec.operationIds[operation.key], `${spec.label} ${operation.method.toUpperCase()} ${operation.path} operationId changed`);
    assert.deepEqual(actual.responses?.[operation.success], { $ref: responseRef(spec.successResponse) }, `${spec.label} ${operation.method.toUpperCase()} success response changed`);
    assert.deepEqual(actual.responses?.['404'], { $ref: responseRef(spec.notFoundResponse) }, `${spec.label} ${operation.method.toUpperCase()} must declare unknown owner/image 404`);
    assertResponseCode(document, spec.notFoundResponse, 'NOT_FOUND', `${spec.label} ${operation.method.toUpperCase()} ${operation.path}`);
    if (operation.write) {
      assert.deepEqual(actual.responses?.['403'], { $ref: responseRef(spec.forbiddenResponse) }, `${spec.label} ${operation.method.toUpperCase()} must declare 403 WRITE_FORBIDDEN`);
      assertResponseCode(document, spec.forbiddenResponse, 'WRITE_FORBIDDEN', `${spec.label} ${operation.method.toUpperCase()} ${operation.path}`);
    }
  }
}

function addMissingContractPieces(document, spec) {
  const fixed = structuredClone(document);
  fixed.components.schemas.MediaSnapshot ??= {
    type: 'object',
    additionalProperties: false,
    required: ['owner_kind', 'owner_id', 'cover_media_path', 'images', 'cleanup_warning'],
    properties: {
      owner_kind: { enum: ['model'] },
      owner_id: { type: 'integer', minimum: 1 },
      cover_media_path: { type: ['string', 'null'] },
      images: { type: 'array', items: { $ref: schemaRef('Image') } },
      cleanup_warning: { type: 'boolean' }
    }
  };
  if (!fixed.components.schemas.MediaSnapshot.properties.owner_kind.enum.includes('model')) fixed.components.schemas.MediaSnapshot.properties.owner_kind.enum.push('model');
  if (!fixed.components.schemas.MediaSnapshot.required.includes('cleanup_warning')) fixed.components.schemas.MediaSnapshot.required.push('cleanup_warning');
  fixed.components.schemas.MediaSnapshot.properties.cleanup_warning = { type: 'boolean' };
  fixed.components.responses[spec.successResponse].content ??= {
    'application/json': {
      schema: {
        allOf: [
          { $ref: schemaRef('Envelope') },
          { properties: { data: { $ref: schemaRef('MediaSnapshot') } } }
        ]
      }
    }
  };
  for (const operation of MEDIA_OPERATIONS.filter(({ write }) => write)) {
    fixed.paths[operation.path][operation.method].responses['403'] ??= { $ref: responseRef(spec.forbiddenResponse) };
  }
  for (const operation of MEDIA_OPERATIONS) {
    fixed.paths[operation.path][operation.method].responses['404'] ??= { $ref: responseRef(spec.notFoundResponse) };
  }
  return fixed;
}

test('根 OpenAPI 声明完整的 model media contract', () => {
  for (const spec of DOCUMENTS) assertMediaContract(loadDocument(spec), spec);
});

test('model media contract assertions reject path, operationId, envelope, schema, 403, and 404 mutations', () => {
  for (const spec of DOCUMENTS) {
    const valid = addMissingContractPieces(loadDocument(spec), spec);
    assert.doesNotThrow(() => assertMediaContract(valid, spec));
    const mutations = [
      ['path', (document) => { delete document.paths[MEDIA_PATHS.image]; }, /missing media path/u],
      ['operationId', (document) => { document.paths[MEDIA_PATHS.collection].get.operationId = 'mutatedMediaOperation'; }, /operationId changed/u],
      ['owner_kind enum', (document) => { document.components.schemas.MediaSnapshot.properties.owner_kind.enum = ['work']; }, /owner_kind must include model/u],
      ['envelope', (document) => { delete document.components.responses[spec.successResponse].content; }, /application\/json envelope schema/u],
      ['cleanup_warning', (document) => { document.components.schemas.MediaSnapshot.properties.cleanup_warning = { type: 'string' }; }, /cleanup_warning must be boolean/u],
      ['403', (document) => { delete document.paths[MEDIA_PATHS.collection].post.responses['403']; }, /403 WRITE_FORBIDDEN/u],
      ['404', (document) => { delete document.paths[MEDIA_PATHS.collection].get.responses['404']; }, /unknown owner\/image 404/u]
    ];
    for (const [label, mutate, expected] of mutations) {
      const mutated = structuredClone(valid);
      mutate(mutated);
      assert.throws(() => assertMediaContract(mutated, spec), expected, `${spec.label} ${label} mutation must be detected`);
    }
  }
});
