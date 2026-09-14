import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { test } from 'node:test';

import { loadConfig } from '../../../app/config/load-config.mjs';
import { createStaticMediaDispatcher } from '../../../app/http/static-media.mjs';
import { createWebRenderer, renderHtmlDocument } from '../../../app/web/web-renderer.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('static media serves GET and HEAD with a stable immutable response', () => {
  const root = mkdtempSync(join(tmpdir(), 'noobai-static-media-'));
  mkdirSync(join(root, 'images'), { recursive: true });
  writeFileSync(join(root, 'images', 'sample.png'), png);
  const dispatcher = createStaticMediaDispatcher({ mediaRoot: root, publicPath: '/media' });

  const get = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/media/images/sample.png' });
  assert.equal(get.status, 200);
  assert.equal(get.headers['content-type'], 'image/png');
  assert.equal(get.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.deepEqual(get.body, png);

  const head = dispatcher.dispatch({ listener: 'public', method: 'HEAD', url: '/media/images/sample.png' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(png.length));
  assert.equal(head.body.length, 0);

  const rootMounted = createStaticMediaDispatcher({ mediaRoot: root, publicPath: '' });
  assert.equal(rootMounted.dispatch({ listener: 'public', method: 'GET', url: '/images/sample.png' }).status, 200);
});

test('static media rejects traversal, malformed segments, unknown types and symlink escape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'noobai-static-media-security-'));
  mkdirSync(join(root, 'images'), { recursive: true });
  writeFileSync(join(root, 'images', 'sample.png'), png);
  const outside = join(root, '..', 'outside.png');
  writeFileSync(outside, png);
  symlinkSync(outside, join(root, 'images', 'outside.png'));
  const dispatcher = createStaticMediaDispatcher({ mediaRoot: root, publicPath: '/media' });
  const paths = [
    '/media/../outside.png',
    '/media/images//sample.png',
    '/media/images/%2e%2e/outside.png',
    '/media//images/sample.png',
    '/media/images/sample.gif',
    '/media/images/outside.png',
    '/media/%2Fetc%2Fpasswd',
    '/media/images/sample%00.png',
    '/media/images/sample%5C.png',
    '/media/C:%5CWindows%5Cwin.ini',
    '/media/images/'
  ];
  for (const url of paths) assert.equal(dispatcher.dispatch({ listener: 'public', method: 'GET', url }).status, 404, url);
  assert.equal(dispatcher.dispatch({ listener: 'public', method: 'POST', url: '/media/images/sample.png' }).status, 405);
  assert.equal(dispatcher.dispatch({ listener: 'internal', method: 'GET', url: '/media/images/sample.png' }), null);
  const source = await readFile(new URL('../../../app/http/static-media.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /database|sqlite/iu);
});

test('HTML renderer injects public runtime configuration only into registered runtime templates', () => {
  const config = loadConfig({ environment: {} });
  const source = '<!doctype html><html><body><!-- NOOBAI_RUNTIME_CONFIG --></body></html>';
  const rendered = renderHtmlDocument(source, config);
  assert.match(rendered, /id="noobai-runtime-config"/u);
  assert.match(rendered, /"config_version":"v0\.11"/u);
  assert.match(rendered, /"http_request_timeout_ms":15000/u);
  assert.doesNotMatch(rendered, /pi_prompt_timeout_ms/u);
  assert.doesNotMatch(rendered, /data_directory|storage_root|app\.sqlite/u);
  assert.throws(() => renderHtmlDocument('<html></html>', config), /NOOBAI_RUNTIME_CONFIG/u);

  const root = mkdtempSync(join(tmpdir(), 'noobai-web-renderer-'));
  writeFileSync(join(root, 'management-home.html'), source);
  writeFileSync(join(root, 'works.html'), source);
  writeFileSync(join(root, 'standalone-prototype.html'), '<!doctype html><html><body>prototype</body></html>');
  const renderer = createWebRenderer({
    webRoot: root,
    config,
    runtimeTemplateFileNames: ['management-home.html', 'works.html']
  });
  assert.match(renderer.render('management-home.html').toString('utf8'), /noobai-runtime-config/u);
  assert.equal(renderer.isRuntimeTemplate('management-home.html'), true);
  assert.equal(renderer.isRuntimeTemplate('standalone-prototype.html'), false);
  const badRoot = mkdtempSync(join(tmpdir(), 'noobai-web-renderer-bad-'));
  writeFileSync(join(badRoot, 'management-home.html'), '<html></html>');
  assert.throws(
    () => createWebRenderer({ webRoot: badRoot, config, runtimeTemplateFileNames: ['management-home.html'] }),
    /missing its runtime configuration marker/u
  );
});

test('browser runtime URL resolver uses the configured prefixes and rejects unsafe media paths', async () => {
  const source = await readFile(new URL('../../../app/web/assets/runtime.js', import.meta.url), 'utf8');
  const sandbox = {
    document: { getElementById: () => ({ textContent: JSON.stringify({ config_version: 'v0.11', api_public_prefix: '/backend/api', media_public_prefix: 'https://cdn.example.test/assets', http_request_timeout_ms: 3210 }) }) },
    window: { location: { href: 'https://app.example.test/' } },
    URL, JSON, Object, Error, String, Number, encodeURIComponent
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'app/web/assets/runtime.js' });
  assert.equal(sandbox.__NOOBAI_URLS__.api('/manage/base-models').toString(), 'https://app.example.test/backend/api/manage/base-models');
  assert.equal(sandbox.__NOOBAI_URLS__.media('images/a b.png').toString(), 'https://cdn.example.test/assets/images/a%20b.png');
  assert.throws(() => sandbox.__NOOBAI_URLS__.media('../outside.png'), /unsafe segment/u);

  const sameOrigin = {
    document: { getElementById: () => ({ textContent: JSON.stringify({ config_version: 'v0.11', api_public_prefix: '', media_public_prefix: '', http_request_timeout_ms: 3210 }) }) },
    window: { location: { href: 'https://app.example.test/' } },
    URL, JSON, Object, Error, String, Number, encodeURIComponent
  };
  sameOrigin.globalThis = sameOrigin;
  vm.runInNewContext(source, sameOrigin, { filename: 'app/web/assets/runtime.js' });
  assert.equal(sameOrigin.__NOOBAI_URLS__.api('/manage/base-models').toString(), 'https://app.example.test/manage/base-models');
  assert.equal(sameOrigin.__NOOBAI_URLS__.media('images/a.png').toString(), 'https://app.example.test/images/a.png');

  for (const textContent of [null, '{', JSON.stringify({ config_version: 'v0.11' })]) {
    const invalid = {
      document: { getElementById: () => textContent === null ? null : ({ textContent }) },
      window: { location: { href: 'https://app.example.test/' } },
      URL, JSON, Object, Error, String, Number, encodeURIComponent
    };
    invalid.globalThis = invalid;
    assert.throws(() => vm.runInNewContext(source, invalid, { filename: 'app/web/assets/runtime.js' }));
  }

  const manageSource = await readFile(new URL('../../../app/web/assets/manage.js', import.meta.url), 'utf8');
  const executableManageSource = manageSource.replace(/^import .*?;\n/gmu, '');
  const missingResolver = { globalThis: null };
  missingResolver.globalThis = missingResolver;
  assert.throws(
    () => vm.runInNewContext(`const MANAGEMENT_LIST_PAGE_CONFIG = { catalog: { pageSize: 16 } };\nfunction bindManagementFilterForm() {}\n${executableManageSource}`, missingResolver),
    /runtime URL resolver is missing/u
  );
});
