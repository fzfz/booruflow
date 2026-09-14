import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { loadAuthoritativeContracts } from '../../app/contracts/authoritative-contracts.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);

const retiredSkillRuntimeModules = Object.freeze([
  'runtime-contract.mjs',
  'round-context.mjs',
  'loopback-query-client.mjs',
  'schema-validation.mjs',
  'output-validator.mjs',
  'wai-session-adapter.mjs'
]);

const sourceExtensions = Object.freeze(new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx', '.jsx']));

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (sourceExtensions.has(path.slice(path.lastIndexOf('.')))) files.push(path);
  }
  return files.sort();
}

test('Issue #224 removes the retired app/skill runtime modules', () => {
  for (const moduleName of retiredSkillRuntimeModules) {
    assert.equal(
      existsSync(resolve(repositoryRoot, 'app/skill', moduleName)),
      false,
      `retired app/skill module remains: ${moduleName}`
    );
  }
});

test('public repository does not contain retired prompt Skill packages', () => {
  for (const relativePath of [
    'skills/wai-sdxl-prompt-builder/SKILL.md',
    'skills/anima-prompt-builder/SKILL.md'
  ]) {
    assert.equal(existsSync(resolve(repositoryRoot, relativePath)), false, relativePath);
  }
});

test('Issue #224 keeps application and script source away from retired Skill schemas and runtime-contract.json', () => {
  const applicationFiles = sourceFiles(resolve(repositoryRoot, 'app'));
  const scriptFiles = sourceFiles(resolve(repositoryRoot, 'scripts'));
  const forbiddenSkillSchemaReference = /(?:skills[\\/]\S+[\\/]references[\\/][^\s'"`]*\.schema\.json|["']references["']\s*,\s*["'][^"']+\.schema\.json["']|references[\\/](?:input|common|semantic-adoption)\.schema\.json)/u;
  const forbiddenRuntimeContract = /runtime-contract\.json/u;
  for (const fileName of [...applicationFiles, ...scriptFiles]) {
    let source = readFileSync(fileName, 'utf8');
    assert.equal(forbiddenSkillSchemaReference.test(source), false, `application/script source references a retired Skill schema: ${fileName}`);
    assert.equal(forbiddenRuntimeContract.test(source), false, `application/script source references runtime-contract.json: ${fileName}`);
  }
});

test('Issue #224 keeps Skill paths out of authoritative system contracts', () => {
  const contracts = loadAuthoritativeContracts(repositoryRoot);

  assert.equal(Object.hasOwn(contracts, 'skillSchemaDirectory'), false);
  assert.equal(
    contracts.schemaPaths.every((schemaPath) => !schemaPath.includes('/skills/')),
    true
  );
  assert.equal(
    [...contracts.schemas.keys()].every((schemaPath) => !schemaPath.includes('/skills/')),
    true
  );
});
