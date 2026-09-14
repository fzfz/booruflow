import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { PROMPT_TERM_CATEGORIES, PROMPT_TERM_CATEGORY_CODES } from '../../app/prompt-terms/prompt-term-categories.mjs';

test('Prompt Tag categories are the unique Danbooru category source used by management', () => {
  assert.deepEqual(PROMPT_TERM_CATEGORIES, [
    { code: 0, key: 'general', label_zh: '通用' },
    { code: 1, key: 'artist', label_zh: '作者' },
    { code: 3, key: 'copyright', label_zh: '作品/IP' },
    { code: 4, key: 'character', label_zh: '角色' },
    { code: 5, key: 'meta', label_zh: '元数据' }
  ]);
  assert.deepEqual(PROMPT_TERM_CATEGORY_CODES, [0, 1, 3, 4, 5]);
  for (const field of ['code', 'key', 'label_zh']) {
    assert.equal(new Set(PROMPT_TERM_CATEGORIES.map((category) => category[field])).size, PROMPT_TERM_CATEGORIES.length, field);
  }
  assert.equal(Object.isFrozen(PROMPT_TERM_CATEGORIES), true);
  assert.equal(PROMPT_TERM_CATEGORIES.every(Object.isFrozen), true);
});

test('Prompt Tag category source remains aligned with the database constraint', () => {
  const migration = readFileSync(resolve(import.meta.dirname, '../../schema/database/007-prompt-terms.sql'), 'utf8');
  assert.match(migration, /CHECK \(category IN \(0, 1, 3, 4, 5\)\)/u);
});
