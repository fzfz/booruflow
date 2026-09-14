import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseOpenApiStructure } from '../../app/contracts/authoritative-contracts.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

test('产品树不再包含 Pi runtime、会话、Harness、TUI 或管理 Pi 包', () => {
  for (const relativePath of [
    'app/pi/system-runtime.mjs',
    'app/session/session-service.mjs',
    'management-skills/lora-adjustment/SKILL.md',
    'config/pi/settings.json',
    'config/management-pi/skills.json',
    'scripts/start-pi-skill-tui.mjs',
    'scripts/start-real-pi-test-app.mjs',
    'app/web/index.html',
    'app/web/assets/app.js'
  ]) {
    assert.equal(existsSync(resolve(repositoryRoot, relativePath)), false, relativePath);
  }

  const packageDocument = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(Object.keys(packageDocument.dependencies).some((name) => name.startsWith('@earendil-works/pi-')), false);
  assert.equal(Object.keys(packageDocument.scripts).some((name) => name.includes('skill:tui') || name.includes('management-skill')), false);
});

test('运行配置和 OpenAPI 不再声明 Pi 配置或退役 operation', () => {
  const defaults = JSON.parse(readFileSync(resolve(repositoryRoot, 'config/defaults.json'), 'utf8'));
  assert.equal(Object.hasOwn(defaults, 'pi_prompt_timeout_ms'), false);
  assert.equal(Object.hasOwn(defaults, 'management_pi'), false);

  const environmentExample = readFileSync(resolve(repositoryRoot, '.env.example'), 'utf8');
  assert.doesNotMatch(environmentExample, /NOOBAI_(?:PI|OPENAI_COMPATIBLE|MANAGEMENT_PI)/u);

  const openapi = parseOpenApiStructure(readFileSync(resolve(repositoryRoot, 'schema/api/openapi.yaml'), 'utf8'));
  const retired = new Set([
    'listChatBaseModels',
    'listSessions',
    'createSession',
    'getSession',
    'deleteSession',
    'listSessionHistory',
    'sendMessage',
    'reopenSession',
    'queryManagementPiGenerationLoras'
  ]);
  assert.deepEqual(openapi.operations.filter(({ operationId }) => retired.has(operationId)), []);
});
