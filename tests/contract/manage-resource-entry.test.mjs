import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

const expectedNavigation = Object.freeze([
  Object.freeze({ id: 'management-home', group: 'overview', label: '首页', url: '/', view: 'management-home', enabled: true }),
  Object.freeze({ id: 'catalog-management', group: 'catalog', label: '角色画师管理', url: '/app/web/manage.html', view: 'catalog-management', enabled: true }),
  Object.freeze({ id: 'prompt-term-management', group: 'catalog', label: 'Prompt Tag 管理', url: '/manage/prompt-terms', view: 'prompt-term-management', enabled: true }),
  Object.freeze({ id: 'base-model-management', group: 'generation', label: '底模管理', url: '/manage/base-models', view: 'base-model-management', enabled: true }),
  Object.freeze({ id: 'model-management', group: 'generation', label: '模型管理', url: '/manage/models', view: 'model-management', enabled: true }),
  Object.freeze({ id: 'lora-management', group: 'generation', label: 'LoRA 管理', url: '/manage/loras', view: 'lora-management', enabled: true }),
  Object.freeze({ id: 'artist-prompt-string-management', group: 'generation', label: '画师串管理', url: '/manage/artist-prompt-strings', view: 'artist-prompt-string-management', enabled: true }),
  Object.freeze({ id: 'comfyui-instance-management', group: 'comfyui', label: 'ComfyUI 实例管理', url: '/manage/comfyui-instances', view: 'comfyui-instance-management', enabled: true }),
  Object.freeze({ id: 'comfyui-template-management', group: 'comfyui', label: 'ComfyUI 模板管理', url: '/manage/comfyui-templates', view: 'comfyui-template-management', enabled: true })
]);

test('公共管理菜单配置定义唯一且有序的页面入口', async () => {
  const { MANAGEMENT_NAVIGATION_ITEMS, MANAGEMENT_PAGE_PATHS, RUNTIME_HTML_FILES } = await import('../../app/web/assets/management-navigation-config.mjs');

  assert.deepEqual(MANAGEMENT_NAVIGATION_ITEMS, expectedNavigation);
  assert.equal(new Set(MANAGEMENT_NAVIGATION_ITEMS.map(({ id }) => id)).size, expectedNavigation.length);
  assert.equal(new Set(MANAGEMENT_NAVIGATION_ITEMS.map(({ url }) => url)).size, expectedNavigation.length);
  assert.equal(new Set(MANAGEMENT_NAVIGATION_ITEMS.map(({ view }) => view)).size, expectedNavigation.length);
  assert.deepEqual(MANAGEMENT_PAGE_PATHS, {
    '/manage/prompt-terms': 'prompt-terms.html',
    '/manage/base-models': 'base-models.html',
    '/manage/models': 'models.html',
    '/manage/loras': 'loras.html',
    '/manage/artist-prompt-strings': 'artist-prompt-strings.html',
    '/manage/comfyui-instances': 'comfyui-instances.html',
    '/manage/comfyui-templates': 'comfyui-templates.html',
    '/manage/generation-resources': 'generation-resources.html'
  });
  assert.deepEqual(RUNTIME_HTML_FILES, [
    'management-home.html',
    'manage.html',
    'prompt-terms.html',
    'base-models.html',
    'models.html',
    'loras.html',
    'artist-prompt-strings.html',
    'comfyui-instances.html',
    'comfyui-templates.html',
    'generation-resources.html'
  ]);
});

test('管理首页和角色画师页使用菜单入口 id 装配同一公共菜单', () => {
  const pages = [
    ['management-home.html', 'management-home'],
    ['manage.html', 'catalog-management']
  ];

  for (const [fileName, id] of pages) {
    const html = readFileSync(resolve(repositoryRoot, 'app/web', fileName), 'utf8');
    assert.match(html, new RegExp(`<nav id="management-navigation"[^>]*data-management-page-id="${id}"`, 'u'));
    assert.match(html, /assets\/management-navigation\.js/u);
  }

  const manageHtml = readFileSync(resolve(repositoryRoot, 'app/web/manage.html'), 'utf8');
  assert.doesNotMatch(manageHtml, /manage-entry-card/u);

  const renderer = readFileSync(resolve(repositoryRoot, 'app/web/assets/management-navigation.js'), 'utf8');
  assert.match(renderer, /MANAGEMENT_NAVIGATION_ITEMS/u);
  assert.match(renderer, /aria-current/u);
  assert.doesNotMatch(renderer, /management-navigation-chat-link/u);
  assert.doesNotMatch(renderer, /返回聊天/u);

  const stylesheet = readFileSync(resolve(repositoryRoot, 'app/web/assets/management.css'), 'utf8');
  assert.match(stylesheet, /\.management-navigation\s*\{[^}]*overflow:\s*auto/u);
});

test('九个管理页面只加载独立的原型样式表', () => {
  const pages = [
    'management-home.html',
    'manage.html',
    'prompt-terms.html',
    'base-models.html',
    'models.html',
    'loras.html',
    'artist-prompt-strings.html',
    'comfyui-instances.html',
    'comfyui-templates.html'
  ];

  for (const page of pages) {
    const html = readFileSync(resolve(repositoryRoot, 'app/web', page), 'utf8');
    assert.match(html, /assets\/management\.css/u, page);
    assert.doesNotMatch(html, /assets\/(?:app|management-home|management-modal)\.css/u, page);
  }
});

test('管理样式表只保留一套原型视觉基线且同一媒体条件没有重复选择器', () => {
  const stylesheetPath = resolve(repositoryRoot, 'app/web/assets/management.css');
  const stylesheet = readFileSync(stylesheetPath, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
  assert.equal((stylesheet.match(/:root\s*\{/gu) ?? []).length, 1);
  assert.doesNotMatch(stylesheet, /--moss|--vermilion|#f7f1e3|box-shadow:\s*8px 8px 0/u);
  assert.equal(existsSync(resolve(repositoryRoot, 'app/web/assets/management-home.css')), false);

  const stack = [];
  const selectors = new Set();
  const duplicates = [];
  for (const rawLine of stylesheet.split(/\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const opens = line.match(/\{/gu)?.length ?? 0;
    const closes = line.match(/\}/gu)?.length ?? 0;
    const selector = line.split('{')[0].trim();
    const context = stack.filter((value) => value.startsWith('@media')).join(' > ') || 'root';
    if (opens > 0 && selector.length > 0 && !selector.startsWith('@') && !stack.some((value) => value.startsWith('@keyframes'))) {
      const key = `${context}::${selector}`;
      if (selectors.has(key)) duplicates.push(key); else selectors.add(key);
    }
    if (opens > closes) for (let index = 0; index < opens - closes; index += 1) stack.push(index === 0 ? selector : '');
    if (closes > opens) for (let index = 0; index < closes - opens; index += 1) stack.pop();
  }
  assert.deepEqual(duplicates, []);
});

test('管理首页从公共导航配置渲染三个业务分区和八个固定入口', () => {
  const html = readFileSync(resolve(repositoryRoot, 'app/web/management-home.html'), 'utf8');
  const script = readFileSync(resolve(repositoryRoot, 'app/web/assets/management-home.js'), 'utf8');
  assert.match(html, /assets\/management\.css/u);
  assert.doesNotMatch(html, /assets\/(?:app|management-home)\.css/u);
  assert.match(html, /id="management-home-groups"/u);
  assert.match(html, /当前版本/u);
  assert.match(html, /NOOBAI_APPLICATION_VERSION/u);
  assert.match(script, /MANAGEMENT_NAVIGATION_GROUPS/u);
  assert.match(script, /MANAGEMENT_NAVIGATION_ITEMS/u);
  for (const group of ['catalog', 'generation', 'comfyui']) assert.match(script, new RegExp(`${group}:`, 'u'));
  for (const { id } of expectedNavigation.slice(1)) assert.match(script, new RegExp(`'${id}'`, 'u'));
  assert.doesNotMatch(`${html}\n${script}`, /comfyui-runs|异步运行|运行准入/u);
});

test('七个独立资源页面只装配目标资源区块和目标脚本', () => {
  const pages = [
    { file: 'prompt-terms.html', id: 'prompt-term-management', marker: 'prompt-term-list', script: 'prompt-term-management.js' },
    { file: 'base-models.html', id: 'base-model-management', marker: 'base-model-list', script: 'base-model-management.js' },
    { file: 'models.html', id: 'model-management', marker: 'model-list', script: 'model-management.js' },
    { file: 'loras.html', id: 'lora-management', marker: 'lora-list', script: 'lora-management.js' },
    { file: 'artist-prompt-strings.html', id: 'artist-prompt-string-management', marker: 'artist-list', script: 'artist-prompt-string-management.js' },
    { file: 'comfyui-instances.html', id: 'comfyui-instance-management', marker: 'comfyui-instance-list', script: 'comfyui-instance-management.js' },
    { file: 'comfyui-templates.html', id: 'comfyui-template-management', marker: 'template-list', script: 'comfyui-template-management.js' }
  ];
  const markers = pages.map(({ marker }) => marker);

  for (const page of pages) {
    const html = readFileSync(resolve(repositoryRoot, 'app/web', page.file), 'utf8');
    assert.match(html, new RegExp(`data-management-page-id="${page.id}"`, 'u'));
    assert.match(html, new RegExp(`id="${page.marker}"`, 'u'));
    assert.match(html, new RegExp(`assets/${page.script.replace('.', '\\.')}`, 'u'));
    assert.match(html, /assets\/management-navigation\.js/u);
    for (const marker of markers.filter((marker) => marker !== page.marker)) {
      assert.doesNotMatch(html, new RegExp(`id="${marker}"`, 'u'));
    }
  }

  const legacyPages = pages.filter(({ id }) => id !== 'prompt-term-management');
  const legacyHtml = readFileSync(resolve(repositoryRoot, 'app/web/generation-resources.html'), 'utf8');
  for (const { marker } of legacyPages) assert.match(legacyHtml, new RegExp(`id="${marker}"`, 'u'));
  assert.match(legacyHtml, /assets\/generation-resources\.js/u);

  const legacyEntry = readFileSync(resolve(repositoryRoot, 'app/web/assets/generation-resources.js'), 'utf8');
  for (const { script } of legacyPages) assert.match(legacyEntry, new RegExp(`\./${script.replace('.', '\\.')}`, 'u'));
});
