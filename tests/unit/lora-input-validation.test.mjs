import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InputValidationError, validateLoraWrite } from '../../app/security/input-validation.mjs';

const VALID_WRITE = Object.freeze({
  base_model_id: 1,
  model_id: 2,
  file_name: 'validation-lora.safetensors',
  file_format: 'safetensors',
  precision_or_quantization: 'none',
  author: null,
  version: null,
  release_url: null,
  description: 'Validation LoRA description',
  usage: 'Validation LoRA usage',
  trigger_words: Object.freeze(['alpha', 'beta']),
  weight: 1
});

function assertInvalid(overrides, message) {
  assert.throws(
    () => validateLoraWrite({ ...VALID_WRITE, ...overrides }),
    (error) => error instanceof InputValidationError && message.test(error.message)
  );
}

test('validateLoraWrite trims and freezes ordered trigger words and accepts every finite weight sign', () => {
  for (const weight of [-1.5, 0, 0.75]) {
    const result = validateLoraWrite({ ...VALID_WRITE, trigger_words: [' alpha ', '\tbeta\n'], weight });
    assert.deepEqual(result.trigger_words, ['alpha', 'beta']);
    assert.equal(Object.isFrozen(result.trigger_words), true);
    assert.equal(result.weight, weight);
  }
  assert.deepEqual(validateLoraWrite({ ...VALID_WRITE, trigger_words: [] }).trigger_words, []);
});

test('validateLoraWrite rejects invalid trigger-word shapes and normalized duplicates', () => {
  assertInvalid({ trigger_words: 'alpha' }, /must be an array/u);
  assertInvalid({ trigger_words: [1] }, /trigger_words\[0\].*non-empty string/u);
  assertInvalid({ trigger_words: ['   '] }, /trigger_words\[0\].*non-empty string/u);
  assertInvalid({ trigger_words: ['alpha', ' alpha '] }, /must not contain duplicates after trimming/u);
});

test('validateLoraWrite rejects missing, null, string and non-finite weights', () => {
  const { weight: _weight, ...missingWeight } = VALID_WRITE;
  assert.throws(() => validateLoraWrite(missingWeight), /missing weight/u);
  for (const weight of [null, '0.8', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assertInvalid({ weight }, /finite number/u);
  }
});
