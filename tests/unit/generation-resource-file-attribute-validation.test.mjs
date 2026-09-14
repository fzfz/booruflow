import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InputValidationError, validateLoraWrite, validateModelWrite } from '../../app/security/input-validation.mjs';

const MODEL_WRITE = Object.freeze({
  base_model_id: 1,
  file_name: 'custom.model',
  file_format: 'custom-container',
  precision_or_quantization: 'q6_k',
  author: null,
  version: null,
  release_url: null,
  published_at: null,
  description: 'Custom model format.',
  usage: 'Use with the matching runtime.',
  skill_name: null
});

const LORA_WRITE = Object.freeze({
  base_model_id: 1,
  model_id: 2,
  file_name: 'custom.lora',
  file_format: 'custom-container',
  precision_or_quantization: 'q6_k',
  author: null,
  version: null,
  release_url: null,
  description: 'Custom LoRA format.',
  usage: 'Use with the matching runtime.',
  trigger_words: [],
  weight: 1
});

test('model and LoRA writes accept configured suggestions and other valid file attributes', () => {
  assert.equal(validateModelWrite(MODEL_WRITE).file_format, 'custom-container');
  assert.equal(validateModelWrite(MODEL_WRITE).precision_or_quantization, 'q6_k');
  assert.equal(validateLoraWrite(LORA_WRITE).file_format, 'custom-container');
  assert.equal(validateLoraWrite(LORA_WRITE).precision_or_quantization, 'q6_k');
});

test('model and LoRA writes reject malformed file attributes at the HTTP validation boundary', () => {
  const invalidValues = [null, '', ' leading', 'trailing ', 'line\nbreak', 'x'.repeat(65)];
  for (const validate of [validateModelWrite, validateLoraWrite]) {
    const base = validate === validateModelWrite ? MODEL_WRITE : LORA_WRITE;
    for (const field of ['file_format', 'precision_or_quantization']) {
      for (const value of invalidValues) {
        assert.throws(
          () => validate({ ...base, [field]: value }),
          InputValidationError,
          `${validate.name} ${field} ${JSON.stringify(value)}`
        );
      }
    }
  }
});
