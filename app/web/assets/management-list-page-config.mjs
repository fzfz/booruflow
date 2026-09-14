export const MANAGEMENT_PAGE_SIZE = 16;

function filter(queryParameter, label, selector) {
  return Object.freeze({ queryParameter, label, selector });
}

function card(titleField, summaryFields, metadataFields) {
  return Object.freeze({
    titleField,
    summaryFields: Object.freeze(summaryFields),
    metadataFields: Object.freeze(metadataFields)
  });
}

function page({ title, placeholder, endpoint, keywordSelector, filters, card: cardConfig }) {
  return Object.freeze({
    title,
    endpoint,
    pageSize: MANAGEMENT_PAGE_SIZE,
    keyword: Object.freeze({ label: '关键词', selector: keywordSelector, queryParameter: 'q', placeholder }),
    filters: Object.freeze(filters),
    card: cardConfig
  });
}

export const MANAGEMENT_LIST_PAGE_CONFIG = Object.freeze({
  catalog: page({
    title: '角色画师管理', placeholder: '搜索名称、别名、作品名称、提示词、画风描述', endpoint: '/manage/items', keywordSelector: '#manage-search',
    filters: [filter('kind', '类型', '#manage-kind'), filter('base_model_id', '底模', '#manage-base-model'), filter('availability', '可用状态', '#manage-availability')],
    card: card('name', ['aliases_json', 'category_name', 'prompt_text', 'style_description'], ['work_name', 'base_model_name', 'is_available'])
  }),
  promptTerms: page({
    title: 'Prompt Tag 管理', placeholder: '搜索规范标签、别名、常见拼写、中文译名', endpoint: '/manage/prompt-terms', keywordSelector: '#prompt-term-search',
    filters: [filter('category', '类别', '#prompt-term-filter-category'), filter('post_count_min', '关联图片数量下界', '#prompt-term-filter-min'), filter('post_count_max', '关联图片数量上界', '#prompt-term-filter-max')],
    card: card('canonical_tag', ['aliases_json'], ['category', 'post_count'])
  }),
  baseModels: page({
    title: '底模管理', placeholder: '搜索底模名称', endpoint: '/manage/base-models', keywordSelector: '#base-model-search', filters: [],
    card: card('name', ['model_count', 'lora_count', 'style_count'], ['created_at', 'updated_at'])
  }),
  models: page({
    title: '模型管理', placeholder: '搜索文件名、作者、版本、描述、使用说明、Skill 名称', endpoint: '/manage/models', keywordSelector: '#model-search',
    filters: [filter('base_model_id', '底模', '#model-filter-base-model'), filter('file_format', '文件格式', '#model-filter-file-format'), filter('precision_or_quantization', '精度或量化', '#model-filter-precision')],
    card: card('file_name', ['description'], ['base_model_name', 'file_format', 'precision_or_quantization'])
  }),
  loras: page({
    title: 'LoRA 管理', placeholder: '搜索文件名、作者、版本、描述、使用说明、触发词', endpoint: '/manage/loras', keywordSelector: '#lora-search',
    filters: [filter('base_model_id', '底模', '#lora-filter-base-model'), filter('model_id', '模型', '#lora-filter-model'), filter('file_format', '文件格式', '#lora-filter-file-format'), filter('precision_or_quantization', '精度或量化', '#lora-filter-precision')],
    card: card('file_name', ['description'], ['weight', 'trigger_words'])
  }),
  artists: page({
    title: '画师串管理', placeholder: '搜索名称、画师提示词串、描述', endpoint: '/manage/artist-prompt-strings', keywordSelector: '#artist-search',
    filters: [filter('base_model_id', '底模', '#artist-filter-base-model'), filter('style_id', '关联画风', '#artist-filter-style')],
    card: card('title', ['description', 'artist_string'], ['base_model_name', 'style_ids.length'])
  }),
  comfyuiInstances: page({
    title: 'ComfyUI 实例管理', placeholder: '搜索实例名称、服务地址', endpoint: '/manage/comfyui-instances', keywordSelector: '#comfyui-instance-search',
    filters: [filter('credential_type', '凭据类型', '#comfyui-instance-filter-credential'), filter('is_valid', '验证状态', '#comfyui-instance-filter-valid'), filter('is_enabled', '启用状态', '#comfyui-instance-filter-enabled')],
    card: card('title', ['url', 'credential_type'], ['is_valid', 'is_enabled'])
  }),
  comfyuiTemplates: page({
    title: 'ComfyUI 模板管理', placeholder: '搜索模板名称、Workflow JSON 内容', endpoint: '/manage/comfyui-templates', keywordSelector: '#template-search',
    filters: [filter('base_model_id', '底模', '#template-filter-base-model'), filter('model_id', '模型', '#template-filter-model'), filter('lora_id', 'LoRA', '#template-filter-lora'), filter('template_type', '工作流类型', '#template-filter-type')],
    card: card('title', ['template_type', 'base_model_name', 'model_name', 'lora_name'], ['template_type', 'model_name'])
  })
});
