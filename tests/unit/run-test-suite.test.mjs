import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runTestSteps } from '../../scripts/testing/run-test-suite.mjs';

function step(label) {
  return Object.freeze({ label, command: process.execPath, args: Object.freeze([]) });
}

test('测试套件在前一步失败后继续执行其余步骤并保留总失败结果', async () => {
  const executed = [];
  const result = await runTestSteps([step('first'), step('second'), step('third')], {
    async execute(current) {
      executed.push(current.label);
      return Object.freeze({ code: current.label === 'first' ? 1 : 0, signal: null, error: null });
    }
  });

  assert.deepEqual(executed, ['first', 'second', 'third']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
});

test('测试套件仅在全部步骤通过时返回成功', async () => {
  const result = await runTestSteps([step('first'), step('second')], {
    async execute() {
      return Object.freeze({ code: 0, signal: null, error: null });
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.results.length, 2);
});

test('测试套件把进程启动错误记为失败并继续后续步骤', async () => {
  const executed = [];
  const result = await runTestSteps([step('broken'), step('after')], {
    async execute(current) {
      executed.push(current.label);
      return current.label === 'broken'
        ? Object.freeze({ code: 1, signal: null, error: new Error('spawn failed') })
        : Object.freeze({ code: 0, signal: null, error: null });
    }
  });

  assert.deepEqual(executed, ['broken', 'after']);
  assert.equal(result.exitCode, 1);
});

test('测试套件收到进程信号时停止启动新步骤并返回该信号', async () => {
  const executed = [];
  const result = await runTestSteps([step('interrupted'), step('not-started')], {
    async execute(current) {
      executed.push(current.label);
      return Object.freeze({ code: 1, signal: 'SIGTERM', error: null });
    }
  });

  assert.deepEqual(executed, ['interrupted']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, 'SIGTERM');
});

test('测试套件拒绝空步骤、非法步骤和非法执行结果', async () => {
  await assert.rejects(runTestSteps([]), /non-empty array/u);
  await assert.rejects(runTestSteps([step('invalid-execute')], { execute: null }), /callbacks must be functions/u);
  await assert.rejects(runTestSteps([step('invalid-on-step')], { onStep: null }), /callbacks must be functions/u);
  await assert.rejects(runTestSteps([{}]), /test step is invalid/u);
  await assert.rejects(runTestSteps([step('invalid-result')], { async execute() { return {}; } }), /test step result is invalid/u);
});
