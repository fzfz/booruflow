import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = resolve(testDirectory, '../fixtures/step-04/local-catalog.json');
const EXPECTED_SHA256 = 'b275bbe56d7839baceb5f00aa9cb28379d66dd06b022f0c00d3a07462d1074bd';

test('the fixed local sample is repeatable and has no external runtime dependency', () => {
  const firstRead = readFileSync(fixturePath, 'utf8');
  const secondRead = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(firstRead);

  assert.equal(firstRead, secondRead);
  assert.equal(createHash('sha256').update(firstRead).digest('hex'), EXPECTED_SHA256);
  assert.equal(fixture.origin, 'repository-local');
  assert.equal(fixture.network_access, false);
  assert.equal(/https?:\/\//iu.test(firstRead), false);
  assert.equal(fixture.catalog.length, 3);
});
