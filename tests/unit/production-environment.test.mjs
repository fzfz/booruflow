import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REQUIRED_PRODUCTION_ENVIRONMENT_VALUES,
  loadProductionRuntimeConfiguration,
  parseProductionEnvironment,
  resolveProductionRuntimeConfiguration
} from '../../app/config/production-environment.mjs';

function completeEnvironment(overrides = {}) {
  return Object.fromEntries(REQUIRED_PRODUCTION_ENVIRONMENT_VALUES.map((name) => [name, `${name}-value`]).map(([name, value]) => [name, overrides[name] ?? value]));
}

test('parses environment values and sends arbitrary listener ports to the configuration loader', () => {
  const environment = completeEnvironment({
    NOOBAI_PUBLIC_PORT: '45123',
    NOOBAI_INTERNAL_PORT: '45124'
  });
  const text = `${Object.entries(environment).map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
  const parsed = parseProductionEnvironment(text);
  const calls = [];
  const runtimeConfiguration = resolveProductionRuntimeConfiguration({
    environment: parsed,
    configPath: 'memory://configuration.json',
    configLoader: (options) => {
      calls.push(options);
      return Object.freeze({ listeners: { public: { port: Number(options.environment.NOOBAI_PUBLIC_PORT) }, internal: { port: Number(options.environment.NOOBAI_INTERNAL_PORT) } } });
    }
  });

  assert.deepEqual(calls, [{ environment: parsed, configPath: 'memory://configuration.json' }]);
  assert.deepEqual(runtimeConfiguration.listeners, { public: { port: 45123 }, internal: { port: 45124 } });
  assert.equal(Object.isFrozen(parsed), true);
});

test('rejects malformed, duplicate, and incomplete environment values before configuration loading', () => {
  assert.throws(() => parseProductionEnvironment('INVALID'), /invalid entry/u);
  assert.throws(() => parseProductionEnvironment('bad-name=value'), /invalid setting name/u);
  assert.throws(() => parseProductionEnvironment('A=one\nA=two'), /duplicate setting/u);

  const incomplete = completeEnvironment({ NOOBAI_INTERNAL_PORT: '' });
  assert.throws(
    () => resolveProductionRuntimeConfiguration({ environment: incomplete, configLoader: () => assert.fail('configuration loader must not run') }),
    /NOOBAI_INTERNAL_PORT/u
  );
  assert.throws(
    () => resolveProductionRuntimeConfiguration({ environment: completeEnvironment(), configLoader: () => { throw new Error('listener values are invalid'); } }),
    /listener values are invalid/u
  );
});

test('loads supplied content only through an injected reader', () => {
  const environment = completeEnvironment({ NOOBAI_PUBLIC_PORT: '45801', NOOBAI_INTERNAL_PORT: '45802' });
  const reads = [];
  const configuration = loadProductionRuntimeConfiguration({
    environmentPath: 'memory://settings',
    configPath: 'memory://defaults',
    readFile: (path, encoding) => {
      reads.push([path, encoding]);
      return Object.entries(environment).map(([name, value]) => `${name}=${value}`).join('\n');
    },
    configLoader: ({ environment: loaded }) => ({ listeners: { public: { port: Number(loaded.NOOBAI_PUBLIC_PORT) }, internal: { port: Number(loaded.NOOBAI_INTERNAL_PORT) } } })
  });

  assert.deepEqual(reads, [['memory://settings', 'utf8']]);
  assert.equal(configuration.listeners.internal.port, 45802);
  assert.throws(() => loadProductionRuntimeConfiguration({ readFile: () => '' }), /path is required/u);
});
