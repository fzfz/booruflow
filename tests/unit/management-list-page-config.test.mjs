import assert from 'node:assert/strict';
import test from 'node:test';

import { MANAGEMENT_LIST_PAGE_CONFIG, MANAGEMENT_PAGE_SIZE } from '../../app/web/assets/management-list-page-config.mjs';

const EXPECTED_FILTERS = Object.freeze({
  catalog: ['kind', 'base_model_id', 'availability'],
  promptTerms: ['category', 'post_count_min', 'post_count_max'],
  baseModels: [],
  models: ['base_model_id', 'file_format', 'precision_or_quantization'],
  loras: ['base_model_id', 'model_id', 'file_format', 'precision_or_quantization'],
  artists: ['base_model_id', 'style_id'],
  comfyuiInstances: ['credential_type', 'is_valid', 'is_enabled'],
  comfyuiTemplates: ['base_model_id', 'model_id', 'lora_id', 'template_type']
});

test('八个管理列表页面使用同一结构化配置定义分页、搜索、筛选和卡片字段', () => {
  assert.equal(MANAGEMENT_PAGE_SIZE, 16);
  assert.deepEqual(Object.keys(MANAGEMENT_LIST_PAGE_CONFIG), Object.keys(EXPECTED_FILTERS));
  for (const [pageKey, expectedParameters] of Object.entries(EXPECTED_FILTERS)) {
    const config = MANAGEMENT_LIST_PAGE_CONFIG[pageKey];
    assert.equal(config.pageSize, MANAGEMENT_PAGE_SIZE, pageKey);
    assert.equal(config.keyword.queryParameter, 'q', pageKey);
    assert.ok(config.keyword.placeholder.startsWith('搜索'), pageKey);
    assert.deepEqual(config.filters.map(({ queryParameter }) => queryParameter), expectedParameters, pageKey);
    assert.ok(config.filters.every(({ label, selector }) => label.length > 0 && selector.startsWith('#')), pageKey);
    assert.ok(config.card.titleField.length > 0, pageKey);
    assert.ok(config.card.summaryFields.length > 0, pageKey);
    assert.ok(config.card.metadataFields.length > 0, pageKey);
    assert.ok(Object.isFrozen(config.filters), pageKey);
    assert.ok(Object.isFrozen(config.card.summaryFields), pageKey);
  }
});
