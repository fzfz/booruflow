import assert from 'node:assert/strict';

export async function assertManagementModal(dialog) {
  const state = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const scrollRegions = [...element.querySelectorAll('.detail-body, .editor-dialog-body > form, .model-editor > .detail-body > form, .editor-media-pane, .model-media-section')];
    return {
      modal: element.matches(':modal'),
      position: getComputedStyle(element).position,
      focusInside: element.contains(document.activeElement),
      bodyOverflow: getComputedStyle(document.body).overflow,
      backdropBackground: getComputedStyle(element, '::backdrop').backgroundColor,
      viewportContained: bounds.top >= 0 && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      internalOverflowY: scrollRegions.map((region) => getComputedStyle(region).overflowY)
    };
  });
  assert.equal(state.modal, true);
  assert.equal(state.position, 'fixed');
  assert.equal(state.focusInside, true);
  assert.equal(state.bodyOverflow, 'hidden');
  assert.doesNotMatch(state.backdropBackground, /^(?:transparent|rgba\(0, 0, 0, 0\))$/u);
  assert.equal(state.viewportContained, true);
  assert.ok(state.internalOverflowY.includes('auto'), `模态中部必须包含内部纵向滚动区：${JSON.stringify(state.internalOverflowY)}`);
}

export async function assertManagementModalEscape(page, dialog, trigger, context = '') {
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  const currentTrigger = await trigger.elementHandle();
  await page.waitForFunction((element) => document.activeElement === element, currentTrigger, { timeout: 1_000 });
  const focusState = await trigger.evaluate((element) => ({
    focused: document.activeElement === element,
    activeTag: document.activeElement?.tagName ?? null,
    activeAction: document.activeElement?.dataset?.action ?? null
  }));
  assert.equal(focusState.focused, true, `${context}: Esc 后焦点状态 ${JSON.stringify(focusState)}`);
}
