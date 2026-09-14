import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

const documents = Object.freeze(['schema/api/openapi.yaml']);
const resourceSchemas = Object.freeze(['Model', 'Lora', 'ArtistPromptString', 'ComfyuiTemplate']);

function assertCoverContract(document, label) {
  for (const schemaName of resourceSchemas) {
    const schema = document.components.schemas[schemaName];
    assert.ok(schema, `${label} 缺少 ${schemaName}`);
    assert.ok(schema.required.includes('cover_media_path'), `${label} ${schemaName} 必须要求 cover_media_path`);
    assert.deepEqual(schema.properties.cover_media_path, { type: ['string', 'null'] }, `${label} ${schemaName}.cover_media_path 必须是可空字符串`);
  }
}

test('管理资源 HTTP 契约要求列表项目返回可空封面路径', () => {
  for (const path of documents) {
    const document = parseYaml(readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8'));
    assertCoverContract(document, path);
  }
});

test('管理资源封面契约检查能够拒绝缺少属性、必填声明或错误类型', () => {
  const document = parseYaml(readFileSync(resolve(import.meta.dirname, '../..', documents[0]), 'utf8'));
  const valid = structuredClone(document);
  for (const schemaName of resourceSchemas) {
    if (!valid.components.schemas[schemaName].required.includes('cover_media_path')) valid.components.schemas[schemaName].required.push('cover_media_path');
    valid.components.schemas[schemaName].properties.cover_media_path = { type: ['string', 'null'] };
  }
  assert.doesNotThrow(() => assertCoverContract(valid, 'valid'));

  for (const [label, mutate, expected] of [
    ['缺少属性', (target) => { delete target.components.schemas.Model.properties.cover_media_path; }, /可空字符串/u],
    ['缺少必填声明', (target) => { target.components.schemas.Lora.required = target.components.schemas.Lora.required.filter((field) => field !== 'cover_media_path'); }, /必须要求/u],
    ['错误类型', (target) => { target.components.schemas.ArtistPromptString.properties.cover_media_path = { type: 'string' }; }, /可空字符串/u]
  ]) {
    const mutated = structuredClone(valid);
    mutate(mutated);
    assert.throws(() => assertCoverContract(mutated, label), expected);
  }
});
