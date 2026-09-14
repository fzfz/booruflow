import { MANAGEMENT_NAVIGATION_GROUPS, MANAGEMENT_NAVIGATION_ITEMS } from './management-navigation-config.mjs';

const descriptions = Object.freeze({
  'catalog-management': '作品、角色与画风',
  'prompt-term-management': '规范标签、类别、别名与关联图片数量',
  'base-model-management': '底模分类与名称',
  'model-management': '模型文件、格式与底模关系',
  'lora-management': '文件、触发词、权重与例图',
  'artist-prompt-string-management': '提示词串、关联画风与例图',
  'comfyui-instance-management': '服务地址、凭据与启用状态',
  'comfyui-template-management': '模板信息、封面与 Workflow JSON'
});
const groupContent = Object.freeze({
  catalog: Object.freeze({ register: '内容目录', title: '内容与 Prompt 目录', description: '维护作品、角色、画风、图片与生成提示词标签。' }),
  generation: Object.freeze({ register: '生成资源', title: '文生图资源', description: '维护模型文件、LoRA 和可复用的画师提示词串。' }),
  comfyui: Object.freeze({ register: 'ComfyUI 资源', title: '实例与 Workflow', description: '维护 ComfyUI 服务连接和可复用的 Workflow 模板。' })
});
const container = document.querySelector('#management-home-groups');

for (const group of MANAGEMENT_NAVIGATION_GROUPS.filter(({ id }) => id !== 'overview')) {
  const entries = MANAGEMENT_NAVIGATION_ITEMS.filter((item) => item.enabled && item.group === group.id);
  const content = groupContent[group.id];
  const section = document.createElement('article');
  section.className = 'home-function-card';
  section.innerHTML = `<header><div class="home-function-register"><strong>${group.code}</strong><span>${content.register}</span></div><h3>${content.title}</h3><p>${content.description}</p></header><div class="home-destinations"></div>`;
  const grid = section.querySelector('.home-destinations');
  for (const item of entries) {
    const link = document.createElement('a');
    link.className = 'home-destination';
    link.href = item.url;
    link.setAttribute('aria-label', `进入${item.label}`);
    link.innerHTML = `<strong>${item.label}</strong><small>${descriptions[item.id]}</small><span class="home-destination-arrow" aria-hidden="true">→</span>`;
    grid.append(link);
  }
  container.append(section);
}
