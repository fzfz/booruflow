import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { test } from 'node:test';

import { startManageTestApp } from '../../scripts/start-manage-test-app.mjs';

function rawGet(baseUrl, path) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, method: 'GET', path }, (response) => {
      response.resume();
      response.once('end', () => resolve(response));
    });
    req.once('error', reject);
    req.end();
  });
}

test('真实公共监听器注入运行时配置并直接提供静态媒体', async () => {
  const app = await startManageTestApp();
  try {
    const html = await fetch(`${app.baseUrl}/`);
    assert.equal(html.status, 200);
    const htmlText = await html.text();
    assert.match(htmlText, /id="noobai-runtime-config"/u);
    assert.match(htmlText, /"api_public_prefix":"\/api"/u);
    assert.match(htmlText, /src="\/app\/web\/assets\/management-navigation\.js"/u);

    const [relativeFileName] = (await readdir(join(app.paths.media, 'images'), { recursive: true })).filter((entry) => entry.endsWith('.png'));
    assert.ok(relativeFileName);
    const mediaPath = `/media/images/${relativeFileName.split(sep).map(encodeURIComponent).join('/')}`;
    const media = await fetch(`${app.baseUrl}${mediaPath}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.equal(media.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const mediaBytes = (await media.arrayBuffer()).byteLength;
    assert.ok(mediaBytes > 0);

    const head = await fetch(`${app.baseUrl}${mediaPath}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), mediaBytes);
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const missing = await fetch(`${app.baseUrl}/media/images/missing.png`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') || '', /^text\/plain/u);
    const apiError = await fetch(`${app.baseUrl}/api/manage/items?kind=all&limit=101`, { headers: { 'x-request-id': 'runtime-error' } });
    assert.equal(apiError.status, 422);
    assert.match(apiError.headers.get('content-type') || '', /^application\/json/u);
    assert.match(apiError.headers.get('server-timing') || '', /^app;dur=\d+\.\d{3}$/u);
    assert.equal((await apiError.json()).error.code, 'VALIDATION_ERROR');
    const traversal = await rawGet(app.baseUrl, '/media/../outside.png');
    assert.equal(traversal.statusCode, 404);
  } finally {
    await app.close();
  }
});
