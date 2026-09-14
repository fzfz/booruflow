import assert from 'node:assert/strict';
import { test } from 'node:test';

import { comfyuiAuthorizationForStoredInstance } from '../../app/generation-resources/comfyui-instance-auth.mjs';

test('stored ComfyUI credentials produce the exact Basic and Bearer authorization values', () => {
  assert.equal(comfyuiAuthorizationForStoredInstance({ credential_type: 'none' }, { decrypt() {} }), null);
  assert.equal(comfyuiAuthorizationForStoredInstance(
    { credential_type: 'http_basic', credential_ciphertext: 'basic-ciphertext' },
    { decrypt(value) { assert.equal(value, 'basic-ciphertext'); return { type: 'http_basic', username: 'user', password: 'pass' }; } }
  ), 'Basic dXNlcjpwYXNz');
  assert.equal(comfyuiAuthorizationForStoredInstance(
    { credential_type: 'bearer', credential_ciphertext: 'bearer-ciphertext' },
    { decrypt(value) { assert.equal(value, 'bearer-ciphertext'); return { type: 'bearer', token: 'secret-token' }; } }
  ), 'Bearer secret-token');
});

test('stored ComfyUI credential failures never return a partial authorization value', () => {
  assert.throws(
    () => comfyuiAuthorizationForStoredInstance({ credential_type: 'bearer', credential_ciphertext: null }, { decrypt() {} }),
    (error) => error.code === 'COMFYUI_CREDENTIAL_ERROR' && /unavailable/u.test(error.message)
  );
  assert.throws(
    () => comfyuiAuthorizationForStoredInstance({ credential_type: 'bearer', credential_ciphertext: 'broken' }, { decrypt() { throw new Error('decrypt failed'); } }),
    (error) => error.code === 'COMFYUI_CREDENTIAL_ERROR' && /cannot be decrypted/u.test(error.message)
  );
  for (const [credentialType, credential] of [
    ['http_basic', { type: 'http_basic', username: 1, password: 'pass' }],
    ['http_basic', { type: 'bearer', token: 'wrong' }],
    ['bearer', { type: 'bearer', token: null }],
    ['unknown', { type: 'bearer', token: 'secret-token' }]
  ]) {
    assert.throws(
      () => comfyuiAuthorizationForStoredInstance({ credential_type: credentialType, credential_ciphertext: 'ciphertext' }, { decrypt() { return credential; } }),
      (error) => error.code === 'COMFYUI_CREDENTIAL_ERROR' && /invalid type/u.test(error.message)
    );
  }
});
