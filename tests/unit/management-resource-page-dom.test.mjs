import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/test-browser-launch-options.mjs';
import { MANAGEMENT_NAVIGATION_ITEMS } from '../../app/web/assets/management-navigation-config.mjs';

const webRoot = new URL('../../app/web/', import.meta.url);
const legacyHtml = readFileSync(new URL('generation-resources.html', webRoot), 'utf8');
const managementHomeHtml = readFileSync(new URL('management-home.html', webRoot), 'utf8');
const resources = Object.freeze([
  Object.freeze({
    page: 'base-models.html',
    selectors: Object.freeze(['#base-model-editor', '#base-model-delete'])
  }),
  Object.freeze({
    page: 'models.html',
    root: Object.freeze({ anchor: '#generation-model-heading', closest: '.generation-model-section' }),
    selectors: Object.freeze(['#model-editor', '#model-delete', '#model-image-delete'])
  }),
  Object.freeze({
    page: 'loras.html',
    root: Object.freeze({ anchor: '#generation-lora-heading', closest: '.generation-model-section' }),
    selectors: Object.freeze(['#lora-editor', '#lora-delete', '#lora-image-delete'])
  }),
  Object.freeze({
    page: 'artist-prompt-strings.html',
    root: Object.freeze({ anchor: '#artist-heading', closest: '.generation-model-section' }),
    selectors: Object.freeze(['#artist-editor', '#artist-delete', '#artist-image-delete'])
  }),
  Object.freeze({
    page: 'comfyui-instances.html',
    root: Object.freeze({ anchor: '#comfyui-instance-heading', closest: '.generation-model-section' }),
    selectors: Object.freeze(['#comfyui-instance-editor', '#comfyui-instance-delete'])
  }),
  Object.freeze({
    page: 'comfyui-templates.html',
    root: Object.freeze({ anchor: '#template-heading', closest: '#comfyui-template-section' }),
    selectors: Object.freeze(['#template-editor', '#template-delete', '#template-image-delete'])
  })
]);

function withoutScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gu, '');
}

async function managementHomeStructure(page, html) {
  await page.setContent(withoutScripts(html));
  return await page.locator('body').evaluate((body) => [...body.children].map(({ className, id, tagName }) => ({ className, id, tagName })));
}

test('管理首页的完整页面包含公共菜单、方案 B 标题和三个业务分区', async () => {
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const page = await browser.newPage();
  try {
    const expected = [
      { className: 'skip-link', id: '', tagName: 'A' },
      { className: 'manage-shell management-home-shell', id: '', tagName: 'MAIN' }
    ];
    assert.deepEqual(await managementHomeStructure(page, managementHomeHtml), expected);
    assert.deepEqual(await page.locator('main').evaluate((main) => [...main.children].map(({ id, tagName }) => ({ id, tagName }))), [
      { id: 'management-navigation', tagName: 'NAV' },
      { id: 'management-home-content', tagName: 'SECTION' }
    ]);
    assert.match(await page.locator('.management-home-purpose').textContent(), /维护内容目录、Prompt Tag、文生图模型资源，以及 ComfyUI 实例与 Workflow 模板/u);
    assert.equal(await page.locator('#management-home-groups').count(), 1);
    assert.match(managementHomeHtml, /NOOBAI_APPLICATION_VERSION/u);
    assert.match(await readFileSync(new URL('assets/management-home.js', webRoot), 'utf8'), /MANAGEMENT_NAVIGATION_ITEMS/u);
    assert.match(await readFileSync(new URL('assets/management-home.js', webRoot), 'utf8'), /prompt-term-management/u);
    assert.doesNotMatch(managementHomeHtml, /新增资源|跨资源搜索|最近更新|服务运行状态/u);
    assert.deepEqual(MANAGEMENT_NAVIGATION_ITEMS.filter(({ id }) => id !== 'management-home').map(({ label }) => label), [
      '角色画师管理',
      'Prompt Tag 管理',
      '底模管理',
      '模型管理',
      'LoRA 管理',
      '画师串管理',
      'ComfyUI 实例管理',
      'ComfyUI 模板管理'
    ]);
    const extraSection = managementHomeHtml.replace('</body>', '<section id="unexpected-content">额外内容</section></body>');
    assert.notDeepEqual(await managementHomeStructure(page, extraSection), expected);
  } finally {
    await browser.close();
  }
});

async function domSnapshot(page, html, { page: fileName, root, selectors, allowedAdditionalSelectors = [] }, isLegacy) {
  await page.setContent(withoutScripts(html));
  return await page.evaluate(({ fileName, isLegacy, root, selectors, allowedAdditionalSelectors }) => {
    document.querySelector('#management-navigation')?.remove();
    document.querySelector('.topbar .manage-actions')?.remove();
    const allowedAdditional = allowedAdditionalSelectors.map((selector) => document.querySelector(selector)?.outerHTML ?? null);
    for (const selector of allowedAdditionalSelectors) document.querySelector(selector)?.remove();

    const selectedRoot = root ? document.querySelector(root.anchor)?.closest(root.closest) : null;
    if (isLegacy) {
      for (const child of [...document.querySelector('#generation-resource-content').children]) {
        if (fileName === 'base-models.html') {
          if (child.matches('.generation-model-section')) child.remove();
        } else if (child !== selectedRoot) {
          child.remove();
        }
      }
      for (const dialog of document.querySelectorAll('dialog')) {
        if (!selectors.some((selector) => dialog.matches(selector))) dialog.remove();
      }
    }

    const whitespaceNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.nodeValue.trim()) whitespaceNodes.push(walker.currentNode);
    }
    for (const node of whitespaceNodes) node.remove();

    return {
      body: document.body.innerHTML,
      targetMain: document.querySelector('#generation-resource-content')?.outerHTML ?? null,
      targetDialogs: selectors.map((selector) => document.querySelector(selector)?.outerHTML ?? null),
      allowedAdditional
    };
  }, { fileName, isLegacy, root, selectors, allowedAdditionalSelectors });
}

test('完整页面主体比较拒绝额外顶层内容和额外弹层', async () => {
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const page = await browser.newPage();
  const resource = resources.find(({ page: fileName }) => fileName === 'models.html');
  const pageHtml = readFileSync(new URL(resource.page, webRoot), 'utf8');
  try {
    const expected = await domSnapshot(page, legacyHtml, resource, true);
    const extraSection = pageHtml.replace('</body>', '<aside id="unexpected-content">额外内容</aside></body>');
    const extraDialog = pageHtml.replace('</body>', '<dialog id="unexpected-dialog">额外弹层</dialog></body>');
    assert.notDeepEqual(await domSnapshot(page, extraSection, resource, false), expected);
    assert.notDeepEqual(await domSnapshot(page, extraDialog, resource, false), expected);
  } finally {
    await browser.close();
  }
});
