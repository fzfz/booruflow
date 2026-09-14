import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function nodeStep(label, ...args) {
  return Object.freeze({ label, command: process.execPath, args: Object.freeze(args) });
}

function npmStep(label, script) {
  return Object.freeze({ label, command: npmCommand, args: Object.freeze(['run', script]) });
}

const contractStructureStep = nodeStep('契约结构检查', 'scripts/step-05/check-contracts.mjs');
const contractTestsStep = nodeStep('契约测试', 'scripts/run-test-layer.mjs', 'tests/contract/');
const unitTestsStep = nodeStep('单元测试', 'scripts/run-test-layer.mjs', 'tests/unit/');
const staticBoundaryStep = nodeStep('静态测试边界检查', 'scripts/check-static-test-boundaries.mjs');
const integrationTestsStep = nodeStep('集成测试', 'scripts/run-test-layer.mjs', 'tests/integration/', '--test-concurrency=1');
const e2eTestsStep = npmStep('端到端测试', 'test:e2e:files');

export const TEST_SUITES = Object.freeze({
  contract: Object.freeze([
    contractStructureStep,
    contractTestsStep
  ]),
  integration: Object.freeze([
    staticBoundaryStep,
    integrationTestsStep
  ]),
  e2e: Object.freeze([
    staticBoundaryStep,
    e2eTestsStep
  ]),
  all: Object.freeze([
    contractStructureStep,
    contractTestsStep,
    unitTestsStep,
    staticBoundaryStep,
    integrationTestsStep,
    e2eTestsStep
  ])
});

function executeStep(step) {
  return new Promise((resolvePromise) => {
    const child = spawn(step.command, step.args, { stdio: 'inherit' });
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolvePromise(Object.freeze({ code: 1, signal: null, error }));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      resolvePromise(Object.freeze({ code: code ?? 1, signal, error: null }));
    });
  });
}

export async function runTestSteps(steps, { execute = executeStep, onStep = () => {} } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError('test steps must be a non-empty array');
  if (typeof execute !== 'function' || typeof onStep !== 'function') throw new TypeError('test step callbacks must be functions');
  const results = [];
  for (const step of steps) {
    if (!step || typeof step.label !== 'string' || typeof step.command !== 'string' || !Array.isArray(step.args)) {
      throw new TypeError('test step is invalid');
    }
    onStep(step);
    const result = await execute(step);
    if (!result || !Number.isInteger(result.code) || (result.signal !== null && typeof result.signal !== 'string')) {
      throw new TypeError('test step result is invalid');
    }
    results.push(Object.freeze({ step, ...result }));
    if (result.signal !== null) break;
  }
  return Object.freeze({
    exitCode: results.some(({ code, signal }) => code !== 0 || signal !== null) ? 1 : 0,
    signal: results.find(({ signal }) => signal !== null)?.signal ?? null,
    results: Object.freeze(results)
  });
}

async function main() {
  const suiteName = process.argv[2];
  const steps = TEST_SUITES[suiteName];
  if (steps === undefined) throw new Error(`unknown test suite: ${suiteName ?? ''}`);
  const result = await runTestSteps(steps, {
    onStep(step) {
      console.log(`\n[test-suite] ${step.label}`);
    }
  });
  console.log('\n[test-suite] 汇总');
  for (const { step, code, signal, error } of result.results) {
    const detail = error ? error.message : signal ?? String(code);
    console.log(`${code === 0 && signal === null ? 'PASS' : 'FAIL'} ${step.label} (${detail})`);
  }
  if (result.signal !== null) process.kill(process.pid, result.signal);
  process.exitCode = result.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
