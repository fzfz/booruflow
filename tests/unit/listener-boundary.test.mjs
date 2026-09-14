import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../../app/config/load-config.mjs';
import { createListenerDefinitions, routeListenerRequest } from '../../app/server/listener-boundary.mjs';

test('declares distinct public and loopback listeners from loaded configuration', () => {
  const listeners = createListenerDefinitions(loadConfig({ environment: {} }));

  assert.deepEqual(listeners.public, {
    name: 'public',
    host: '0.0.0.0',
    port: 18082,
    allowedPathPrefixes: ['/api/', '/']
  });
  assert.deepEqual(listeners.internal, {
    name: 'internal',
    host: '127.0.0.1',
    port: 18083,
    allowedPathPrefixes: ['/internal/semantic', '/internal/semantic/', '/internal/comfyui-source', '/internal/comfyui-source/']
  });
});

test('keeps internal semantic routes off the public listener', () => {
  assert.deepEqual(routeListenerRequest('public', '/internal/semantic/works'), { status: 404, route: null });
  assert.deepEqual(routeListenerRequest('public', '/internal/semantic'), { status: 404, route: null });
  assert.deepEqual(routeListenerRequest('public', '/internal/comfyui-source'), { status: 404, route: null });
  assert.deepEqual(routeListenerRequest('public', '/internal/comfyui-source/instances/31'), { status: 404, route: null });
  assert.deepEqual(routeListenerRequest('public', '/api/catalog'), { status: 200, route: 'public' });
});

test('accepts internal semantic routes only through the loopback listener', () => {
  assert.deepEqual(routeListenerRequest('internal', '/internal/semantic/works'), {
    status: 200,
    route: 'internal-semantic'
  });
  assert.deepEqual(routeListenerRequest('internal', '/api/catalog'), { status: 404, route: null });
  assert.deepEqual(routeListenerRequest('internal', '/internal/comfyui-source'), {
    status: 200,
    route: 'internal-source'
  });
  assert.deepEqual(routeListenerRequest('internal', '/internal/comfyui-source/instances/31'), {
    status: 200,
    route: 'internal-source'
  });
  assert.throws(() => routeListenerRequest('unknown', '/'), /unknown listener/);
});
