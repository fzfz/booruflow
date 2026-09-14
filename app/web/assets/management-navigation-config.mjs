const managementPages = Object.freeze([
  Object.freeze({ id: 'management-home', group: 'overview', label: '首页', url: '/', view: 'management-home', enabled: true, htmlFile: 'management-home.html' }),
  Object.freeze({ id: 'catalog-management', group: 'catalog', label: '角色画师管理', url: '/app/web/manage.html', view: 'catalog-management', enabled: true, htmlFile: 'manage.html' }),
  Object.freeze({ id: 'prompt-term-management', group: 'catalog', label: 'Prompt Tag 管理', url: '/manage/prompt-terms', view: 'prompt-term-management', enabled: true, htmlFile: 'prompt-terms.html' }),
  Object.freeze({ id: 'base-model-management', group: 'generation', label: '底模管理', url: '/manage/base-models', view: 'base-model-management', enabled: true, htmlFile: 'base-models.html' }),
  Object.freeze({ id: 'model-management', group: 'generation', label: '模型管理', url: '/manage/models', view: 'model-management', enabled: true, htmlFile: 'models.html' }),
  Object.freeze({ id: 'lora-management', group: 'generation', label: 'LoRA 管理', url: '/manage/loras', view: 'lora-management', enabled: true, htmlFile: 'loras.html' }),
  Object.freeze({ id: 'artist-prompt-string-management', group: 'generation', label: '画师串管理', url: '/manage/artist-prompt-strings', view: 'artist-prompt-string-management', enabled: true, htmlFile: 'artist-prompt-strings.html' }),
  Object.freeze({ id: 'comfyui-instance-management', group: 'comfyui', label: 'ComfyUI 实例管理', url: '/manage/comfyui-instances', view: 'comfyui-instance-management', enabled: true, htmlFile: 'comfyui-instances.html' }),
  Object.freeze({ id: 'comfyui-template-management', group: 'comfyui', label: 'ComfyUI 模板管理', url: '/manage/comfyui-templates', view: 'comfyui-template-management', enabled: true, htmlFile: 'comfyui-templates.html' })
]);

export const MANAGEMENT_NAVIGATION_GROUPS = Object.freeze([
  Object.freeze({ id: 'overview', code: '00', label: '总览' }),
  Object.freeze({ id: 'catalog', code: 'C', label: '内容目录' }),
  Object.freeze({ id: 'generation', code: 'G', label: '生成资源' }),
  Object.freeze({ id: 'comfyui', code: 'F', label: 'ComfyUI' })
]);

export const MANAGEMENT_NAVIGATION_ITEMS = Object.freeze(managementPages.map(({ htmlFile: _htmlFile, ...item }) => Object.freeze(item)));
export const MANAGEMENT_PAGE_PATHS = Object.freeze({
  ...Object.fromEntries(managementPages.filter(({ url }) => url.startsWith('/manage')).map(({ url, htmlFile }) => [url, htmlFile])),
  '/manage/generation-resources': 'generation-resources.html'
});

export const RUNTIME_HTML_FILES = Object.freeze([
  ...new Set([
    ...managementPages.map(({ htmlFile }) => htmlFile),
    ...Object.values(MANAGEMENT_PAGE_PATHS)
  ])
]);
