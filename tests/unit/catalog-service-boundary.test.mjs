import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCatalogService } from '../../app/catalog/catalog-service.mjs';

const SEMANTIC_SERVICE_OPTIONS = Object.freeze([
  ['workSemanticService', 'workSemanticService'],
  ['characterSemanticService', 'characterSemanticService'],
  ['styleSemanticService', 'styleSemanticService'],
  ['promptTermSemanticService', 'promptTermSemanticService'],
  ['artistPromptStringSemanticService', 'artistPromptStringSemanticService'],
  ['generationLoraSemanticService', 'generationLoraSemanticService']
]);
const CATALOG_QUERY_OPERATIONS = Object.freeze([
  ['querySemanticWorksForSkill', 'workSemanticService'],
  ['querySemanticCharactersForSkill', 'characterSemanticService'],
  ['querySemanticStylesForSkill', 'styleSemanticService'],
  ['querySemanticPromptTermsForSkill', 'promptTermSemanticService'],
  ['querySemanticArtistPromptStringsForSkill', 'artistPromptStringSemanticService'],
  ['querySemanticLorasForSkill', 'generationLoraSemanticService']
]);

function assertApplicationErrorCode(expectedCode) {
  return (error) => error?.code === expectedCode;
}

test('Catalog service 拒绝缺少公开查询或 Skill 查询方法的语义服务', async (t) => {
  for (const [optionName, errorName] of SEMANTIC_SERVICE_OPTIONS) {
    await t.test(`${optionName} 缺少 searchPublic`, () => {
      assert.throws(() => createCatalogService({
        database: {},
        repository: {},
        [optionName]: { searchSkillForAgent() {} }
      }), new RegExp(`${errorName} must expose searchPublic and searchSkillForAgent`, 'u'));
    });
    await t.test(`${optionName} 缺少 searchSkillForAgent`, () => {
      assert.throws(() => createCatalogService({
        database: {},
        repository: {},
        [optionName]: { searchPublic() {} }
      }), new RegExp(`${errorName} must expose searchPublic and searchSkillForAgent`, 'u'));
    });
  }
});

test('Catalog service 在相应语义索引未配置时返回明确错误', () => {
  const service = createCatalogService({ database: {}, repository: {} });
  assert.throws(() => service.searchSemanticWorks({}), /work vector index is not ready/u);
  assert.throws(() => service.searchSemanticCharacters({}), /character vector index is not ready/u);
  assert.throws(() => service.searchSemanticStyles({}), /style semantic service is not configured/u);
  assert.throws(() => service.searchSemanticPromptTerms({}), /prompt term vector index is not ready/u);
});

test('Catalog Skill 查询拒绝无效请求和缺失的语义索引', async (t) => {
  const service = createCatalogService({ database: {}, repository: {} });
  assert.throws(
    () => service.querySemanticBaseModelsForSkill({ mode: 'unsupported' }),
    assertApplicationErrorCode('CATALOG_REQUEST_INVALID')
  );
  for (const [operation] of CATALOG_QUERY_OPERATIONS) {
    await t.test(operation, async () => {
      await assert.rejects(
        async () => service[operation]({ mode: 'search', query: 'catalog boundary' }),
        assertApplicationErrorCode('CATALOG_INDEX_NOT_READY')
      );
    });
  }
});

test('Catalog Skill 查询拒绝语义服务返回的非法分页', async (t) => {
  const semanticService = Object.freeze({
    searchPublic() {},
    searchSkillForAgent() {},
    async searchCatalog() { return null; }
  });
  const options = Object.fromEntries(SEMANTIC_SERVICE_OPTIONS.map(([optionName]) => [optionName, semanticService]));
  const service = createCatalogService({ database: {}, repository: {}, ...options });
  for (const [operation] of CATALOG_QUERY_OPERATIONS) {
    await t.test(operation, async () => {
      await assert.rejects(
        async () => service[operation]({ mode: 'search', query: 'catalog boundary' }),
        assertApplicationErrorCode('CATALOG_INTERNAL_ERROR')
      );
    });
  }
});

test('Catalog Skill resolve 查询拒绝非对象的仓储记录', async (t) => {
  function invalidRow() {}
  Object.assign(invalidRow, {
    id: 1,
    is_available: 1,
    work_is_available: 1,
    workflow_json: '{}'
  });
  const getterNames = Object.freeze([
    ['querySemanticBaseModelsForSkill', 'getCatalogBaseModel'],
    ['querySemanticGenerationModelsForSkill', 'getCatalogGenerationModel'],
    ['querySemanticLorasForSkill', 'getCatalogLora'],
    ['querySemanticWorksForSkill', 'getCatalogWork'],
    ['querySemanticCharactersForSkill', 'getCatalogCharacter'],
    ['querySemanticStylesForSkill', 'getCatalogStyle'],
    ['querySemanticPromptTermsForSkill', 'getCatalogPromptTerm'],
    ['querySemanticArtistPromptStringsForSkill', 'getCatalogArtistPromptString'],
    ['querySemanticComfyuiInstancesForSkill', 'getCatalogComfyuiInstance'],
    ['querySemanticComfyuiTemplatesForSkill', 'getCatalogComfyuiTemplate']
  ]);
  const repository = Object.fromEntries(getterNames.map(([, getterName]) => [getterName, () => invalidRow]));
  repository.listCatalogImagesByOwners = () => [];
  const service = createCatalogService({ database: {}, repository });
  for (const [operation] of getterNames) {
    await t.test(operation, async () => {
      await assert.rejects(
        async () => service[operation]({ mode: 'resolve', id: '1' }),
        assertApplicationErrorCode('CATALOG_INTERNAL_ERROR')
      );
    });
  }
});

test('Catalog Skill 查询拒绝非法媒体路径和媒体公开配置', async (t) => {
  const validRow = Object.freeze({
    id: 1,
    base_model_id: 1,
    file_name: 'model.safetensors',
    file_format: 'safetensors',
    precision_or_quantization: 'fp16',
    description: 'model',
    usage: 'usage'
  });
  for (const [name, coverMediaPath, mediaOrigin, mediaPublicPrefix] of [
    ['媒体路径不是字符串', 42, 'http://127.0.0.1:18082', '/media'],
    ['媒体路径包含父目录段', '../outside.png', 'http://127.0.0.1:18082', '/media'],
    ['媒体来源无效', 'models/cover.png', 'invalid-origin', '/media'],
    ['媒体公开前缀不是字符串', 'models/cover.png', 'http://127.0.0.1:18082', null],
    ['媒体公开前缀无效', 'models/cover.png', 'http://127.0.0.1:18082', 'not a URL']
  ]) {
    await t.test(name, async () => {
      const repository = {
        getCatalogGenerationModel: () => ({ ...validRow, cover_media_path: coverMediaPath }),
        listCatalogImagesByOwners: () => []
      };
      const service = createCatalogService({ database: {}, repository, mediaOrigin, mediaPublicPrefix });
      await assert.rejects(
        async () => service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '1' }),
        assertApplicationErrorCode('CATALOG_INTERNAL_ERROR')
      );
    });
  }
});

test('Catalog Skill 查询拒绝非法 JSON 投影和超过上限的结果页', async () => {
  for (const triggerWords of [42, '[invalid']) {
    const service = createCatalogService({
      database: {},
      repository: {
        getCatalogLora: () => ({ id: 1, trigger_words_json: triggerWords }),
        listCatalogImagesByOwners: () => []
      }
    });
    await assert.rejects(
      async () => service.querySemanticLorasForSkill({ mode: 'resolve', id: '1' }),
      assertApplicationErrorCode('CATALOG_INTERNAL_ERROR')
    );
  }
  const invalidAliasService = createCatalogService({
    database: {},
    repository: {
      getCatalogWork: () => ({ id: 1, is_available: 1, aliases_json: 42 }),
      listCatalogImagesByOwners: () => []
    }
  });
  await assert.rejects(
    async () => invalidAliasService.querySemanticWorksForSkill({ mode: 'resolve', id: '1' }),
    assertApplicationErrorCode('CATALOG_INTERNAL_ERROR')
  );
  const oversizedPageService = createCatalogService({
    database: {},
    repository: {
      listCatalogBaseModels: () => ({
        rows: Array.from({ length: 101 }, (_, index) => ({ id: index + 1, name: `base-${index + 1}` })),
        total_count: 101
      })
    }
  });
  assert.throws(
    () => oversizedPageService.querySemanticBaseModelsForSkill({ mode: 'search' }),
    assertApplicationErrorCode('CATALOG_INTERNAL_ERROR')
  );
});

test('ComfyUI 模板 Catalog 拒绝缺失当前 Workflow 的仓储记录', () => {
  const service = createCatalogService({
    database: {},
    repository: {
      getCatalogComfyuiTemplate: () => ({ id: 1, workflow_json: null })
    }
  });
  assert.throws(
    () => service.querySemanticComfyuiTemplatesForSkill({ mode: 'resolve', id: '1' }),
    assertApplicationErrorCode('CATALOG_RESOURCE_UNAVAILABLE')
  );
});
