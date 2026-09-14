import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startTestApp } from '../../scripts/start-test-app.mjs';

test('应用不需要 Pi 配置即可启动，全部退役 HTTP 路径返回 404', { concurrency: false }, async () => {
  const app = await startTestApp();
  try {
    const requests = [
      ['GET', `${app.baseUrl}/api/base-models`],
      ['GET', `${app.baseUrl}/app/web/index.html`],
      ['GET', `${app.baseUrl}/app/web/assets/app.js`],
      ['GET', `${app.baseUrl}/api/sessions`],
      ['POST', `${app.baseUrl}/api/sessions`],
      ['GET', `${app.baseUrl}/api/sessions/1`],
      ['DELETE', `${app.baseUrl}/api/sessions/1`],
      ['GET', `${app.baseUrl}/api/sessions/1/history`],
      ['POST', `${app.baseUrl}/api/sessions/1/messages`],
      ['POST', `${app.baseUrl}/api/sessions/1/reopen`],
      ['POST', `${app.internalBaseUrl}/internal/management-pi/generation-loras`]
    ];
    for (const [method, url] of requests) {
      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' })
      });
      assert.equal(response.status, 404, `${method} ${url}`);
    }
  } finally {
    await app.close();
  }
});
