import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AFTER_RESPONSE_CALLBACK, registerResponseFinishCallback } from '../../app/http/catalog-http.mjs';

test('Issue #276 R2.3 invokes one after-response callback only after response finish', async () => {
  const response = new EventEmitter();
  const events = [];
  let resolveCallback;
  const callbackCompleted = new Promise((resolvePromise) => { resolveCallback = resolvePromise; });
  registerResponseFinishCallback(response, {
    [AFTER_RESPONSE_CALLBACK]: async () => {
      events.push('callback');
      resolveCallback();
    }
  });
  assert.deepEqual(events, []);
  response.emit('finish');
  await callbackCompleted;
  assert.deepEqual(events, ['callback']);
  response.emit('finish');
  assert.deepEqual(events, ['callback']);
});
