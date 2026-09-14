import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const documentPaths = Object.freeze(['schema/api/openapi.yaml']);
const loraPaths = Object.freeze([
  '/api/manage/loras',
  '/api/manage/loras/{id}',
  '/api/manage/loras/{id}/delete-impact'
]);

function loadDocument(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}

function loadOpenApi(path) {
  return loadDocument(resolve(repositoryRoot, path));
}

function decodeJsonPointerPart(part) {
  return part.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveReference(documentPath, document, reference) {
  const hashIndex = reference.indexOf('#');
  const relativePath = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : reference.slice(hashIndex + 1);
  const targetPath = relativePath === '' ? documentPath : resolve(dirname(documentPath), relativePath);
  const targetDocument = targetPath === documentPath ? document : loadDocument(targetPath);
  if (fragment === '') return { targetPath, targetDocument, target: targetDocument };
  assert.match(fragment, /^\//u, `reference fragment must be a JSON Pointer: ${reference}`);
  const target = fragment.slice(1).split('/').map(decodeJsonPointerPart).reduce((value, part) => value?.[part], targetDocument);
  return { targetPath, targetDocument, target };
}

function assertReferencesResolve(entryPath) {
  const visitedDocuments = new Set();
  const visitDocument = (documentPath, document = loadDocument(documentPath)) => {
    if (visitedDocuments.has(documentPath)) return;
    visitedDocuments.add(documentPath);
    visit(document, documentPath, document);
  };
  const visit = (value, documentPath, document) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, documentPath, document);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      const resolved = resolveReference(documentPath, document, value.$ref);
      assert.notEqual(resolved.target, undefined, `${documentPath} has unresolved reference ${value.$ref}`);
      visitDocument(resolved.targetPath, resolved.targetDocument);
    }
    for (const nested of Object.values(value)) visit(nested, documentPath, document);
  };
  visitDocument(entryPath);
}

function assertTriggerWeightSchema(schema, label) {
  assert.ok(schema.required.includes('trigger_words'), `${label} must require trigger_words`);
  assert.ok(schema.required.includes('weight'), `${label} must require weight`);
  assert.deepEqual(schema.properties.trigger_words, {
    type: 'array',
    uniqueItems: true,
    description: '服务端去除每个触发词的首尾空白后判断空值与重复。',
    items: { type: 'string', minLength: 1, pattern: '.*\\S.*' }
  });
  assert.equal(schema.properties.weight.type, 'number', `${label}.weight must be a number`);
}

test('根 OpenAPI 的全部本地引用可解析', () => {
  for (const path of documentPaths) assertReferencesResolve(resolve(repositoryRoot, path));
});

test('根 OpenAPI 保留 LoRA 管理路径和写入合同', () => {
  for (const documentPath of documentPaths) {
    const document = loadOpenApi(documentPath);
    for (const path of loraPaths) assert.ok(document.paths[path], `${documentPath} ${path}`);
    assert.equal(document.paths['/api/manage/loras'].post.requestBody.$ref, '#/components/requestBodies/LoraWrite');
    assert.equal(document.paths['/api/manage/loras/{id}'].put.requestBody.$ref, '#/components/requestBodies/LoraWrite');
    assert.ok(document.components.schemas.Lora);
    assert.ok(document.components.schemas.LoraWrite);
    assert.ok(document.components.requestBodies.LoraWrite);
  }
});

test('根 OpenAPI 的 Lora 与 LoraWrite 都要求触发词数组和数值权重', () => {
  for (const path of documentPaths) {
    const document = loadOpenApi(path);
    assertTriggerWeightSchema(document.components.schemas.Lora, `${path} Lora`);
    assertTriggerWeightSchema(document.components.schemas.LoraWrite, `${path} LoraWrite`);
  }
});
