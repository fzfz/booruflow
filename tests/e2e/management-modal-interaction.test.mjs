import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';
import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/testing/test-browser-launch-options.mjs';
import { assertManagementModal, assertManagementModalEscape } from './management-modal-assertions.mjs';

const VIEWPORTS = Object.freeze([
  Object.freeze({ width: 390, height: 812 }),
  Object.freeze({ width: 768, height: 1024 }),
  Object.freeze({ width: 1440, height: 900 })
]);
const CASES = Object.freeze([
  Object.freeze({ path: '/manage/loras', trigger: '[data-action="open-lora-detail"]', dialog: '#lora-editor' }),
  Object.freeze({ path: '/manage/artist-prompt-strings', trigger: '[data-action="open-artist-detail"]', dialog: '#artist-editor' }),
  Object.freeze({ path: '/manage/comfyui-instances', trigger: '[data-action="open-comfyui-instance-detail"]', dialog: '#comfyui-instance-editor' })
]);

async function createComfyuiInstance(app) {
  const response = await fetch(`${app.baseUrl}/api/manage/comfyui-instances`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-request-id': 'management-modal-layout-comfyui-instance'
    },
    body: JSON.stringify({
      title: 'Management modal layout instance',
      url: `${app.baseUrl}/manage/generation-resources`,
      credential: { type: 'none' },
      is_enabled: false
    })
  });
  assert.equal(response.status, 201);
}

test('三个管理页详情在三档视口使用顶层模态、锁定背景并通过 Esc 返回触发按钮', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  let browser;
  let context;
  try {
    await createComfyuiInstance(app);
    browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
    context = await browser.newContext();
    const page = await context.newPage();

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const entry of CASES) {
        const response = await page.goto(`${app.baseUrl}${entry.path}`, { waitUntil: 'domcontentloaded' });
        assert.equal(response?.status(), 200);
        const trigger = page.locator(entry.trigger).first();
        await trigger.waitFor({ state: 'visible' });
        await trigger.click();
        const dialog = page.locator(entry.dialog);
        await dialog.waitFor({ state: 'visible' });
        await assertManagementModal(dialog);
        if (viewport.width === 1440) {
          const geometry = await dialog.evaluate((element) => {
            const rectangle = (target) => {
              const value = target.getBoundingClientRect();
              return Object.fromEntries(['left', 'right', 'top', 'bottom', 'width', 'height'].map((key) => [key, Math.round(value[key])]));
            };
            return {
              dialog: rectangle(element),
              heading: rectangle(element.querySelector(':scope > .dialog-heading')),
              body: rectangle(element.querySelector(':scope > .detail-body')),
              footer: rectangle(element.querySelector(':scope > .dialog-actions')),
              hasInjectedStatus: Boolean(element.querySelector(':scope > .editor-status')),
              subtitle: element.querySelector('.editor-subtitle')?.textContent ?? ''
            };
          });
          assert.deepEqual(geometry.dialog, { left: 130, right: 1310, top: 40, bottom: 860, width: 1180, height: 820 }, entry.path);
          assert.deepEqual(geometry.heading, { left: 131, right: 1309, top: 41, bottom: 125, width: 1178, height: 84 }, entry.path);
          assert.deepEqual(geometry.body, { left: 131, right: 1309, top: 125, bottom: 798, width: 1178, height: 673 }, entry.path);
          assert.deepEqual(geometry.footer, { left: 131, right: 1309, top: 798, bottom: 859, width: 1178, height: 61 }, entry.path);
          assert.equal(geometry.hasInjectedStatus, false, entry.path);
          assert.notEqual(geometry.subtitle, '', entry.path);
        }
        await assertManagementModalEscape(page, dialog, trigger, `${entry.path} @ ${viewport.width}x${viewport.height}`);
      }
    }
  } finally {
    await context?.close();
    await browser?.close();
    await app.close();
  }
});
