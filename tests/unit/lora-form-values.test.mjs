import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLoraTriggerWords, parseLoraWeight } from '../../app/web/assets/lora-form-values.js';

test('LoRA trigger-word textarea parser accepts LF and CRLF, removes blank lines and preserves order', () => {
  assert.deepEqual(parseLoraTriggerWords(' first \n\nsecond\n third '), ['first', 'second', 'third']);
  assert.deepEqual(parseLoraTriggerWords(' first \r\n\r\nsecond\r\n third '), ['first', 'second', 'third']);
  assert.deepEqual(parseLoraTriggerWords(' \r\n\t\r\n'), []);
  assert.equal(Object.isFrozen(parseLoraTriggerWords('alpha')), true);
});

test('LoRA weight parser preserves finite precision and rejects empty or non-finite input', () => {
  assert.equal(parseLoraWeight('-1.25'), -1.25);
  assert.equal(parseLoraWeight('0'), 0);
  assert.equal(parseLoraWeight('0.123456789'), 0.123456789);
  for (const value of ['', '   ', 'NaN', 'Infinity', '-Infinity']) {
    assert.throws(() => parseLoraWeight(value), /默认模型权重/u);
  }
});
