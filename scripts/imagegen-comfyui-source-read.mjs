#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const CLI_NAME = 'imagegen-comfyui-source-read';
const CLI_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 120000;
const DISCOVERY_PATH = '/internal/comfyui-source';
const INSTANCE_PATH = '/internal/comfyui-source/instances/{instance_id}';
const TEMPLATE_BUNDLE_PATH = '/internal/comfyui-source/templates/{template_id}/bundle';
const INSTANCE_OPERATION_ID = 'getComfyuiInstanceSourceForHost';
const TEMPLATE_BUNDLE_OPERATION_ID = 'getComfyuiTemplateBundleForHost';
const INSTANCE_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u061c\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const UNSAFE_TEXT_GLOBAL_PATTERN = /[\u0000-\u001f\u061c\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const CLI_ERROR_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'CLI arguments are invalid.',
  DISCOVERY_HTTP_ERROR: 'Source discovery returned an error.',
  SOURCE_CONNECTION_FAILED: 'Source service is unavailable.',
  TOTAL_TIMEOUT: 'Source request timed out.',
  CONTRACT_PROTOCOL_ERROR: 'Source contract response is invalid.',
  INTERNAL_CLI_ERROR: 'Source CLI failed.'
});

class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

class ServiceHttpError extends Error {
  constructor(responseBuffer) {
    super('source service returned a non-2xx JSON response');
    this.name = 'ServiceHttpError';
    this.responseBuffer = responseBuffer;
    this.exitCode = 7;
  }
}

function fail(code, message, exitCode = 2) {
  throw new CliError(code, message, exitCode);
}

function invalid(message = CLI_ERROR_MESSAGES.INVALID_ARGUMENT) {
  fail('INVALID_ARGUMENT', message, 2);
}

function protocol() {
  throw new CliError('CONTRACT_PROTOCOL_ERROR', CLI_ERROR_MESSAGES.CONTRACT_PROTOCOL_ERROR, 6);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonStringify(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) protocol();
  return serialized.replace(UNSAFE_TEXT_GLOBAL_PATTERN, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function createExecutionContext(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CliError('TOTAL_TIMEOUT', CLI_ERROR_MESSAGES.TOTAL_TIMEOUT, 5)), timeoutMs);
  const signalHandlers = new Map([
    ['SIGINT', () => controller.abort(new CliError('PROCESS_CANCELLED', 'Source request was cancelled by SIGINT.', 130))],
    ['SIGTERM', () => controller.abort(new CliError('PROCESS_CANCELLED', 'Source request was cancelled by SIGTERM.', 143))]
  ]);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  return {
    signal: controller.signal,
    throwIfAborted() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    dispose() {
      clearTimeout(timer);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    }
  };
}

function parseDecimalInteger(value, label, minimum, maximum) {
  if (!/^[0-9]+$/u.test(value ?? '')) invalid(`${label} must be a decimal integer from ${minimum} to ${maximum}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) invalid(`${label} must be a decimal integer from ${minimum} to ${maximum}`);
  return number;
}

function parseArguments(argv) {
  const parsed = { port: null, timeoutMs: DEFAULT_TIMEOUT_MS, help: false, version: false, discoveryJson: false, command: null, id: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      if (!['instance', 'template-bundle'].includes(argument) || parsed.command !== null) invalid(`unsupported positional argument: ${argument}`);
      parsed.command = argument;
      continue;
    }
    if (argument.includes('=')) invalid(`equals-form arguments are not supported: ${argument}`);
    if (seen.has(argument)) invalid(`${argument} may appear only once`);
    seen.add(argument);
    if (argument === '--help') {
      parsed.help = true;
      continue;
    }
    if (argument === '--version') {
      parsed.version = true;
      continue;
    }
    if (argument === '--discovery-json') {
      parsed.discoveryJson = true;
      continue;
    }
    const option = argument.slice(2);
    if (!['port', 'timeout-ms', 'id'].includes(option)) invalid(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) invalid(`${argument} requires a value`);
    index += 1;
    if (option === 'port') parsed.port = parseDecimalInteger(value, '--port', 1, 65535);
    if (option === 'timeout-ms') parsed.timeoutMs = parseDecimalInteger(value, '--timeout-ms', 1, 600000);
    if (option === 'id') {
      if (!INSTANCE_ID_PATTERN.test(value)) invalid('--id must be a positive decimal instance identifier from 1 to 20 digits');
      parsed.id = value;
    }
  }
  if (parsed.version && argv.length !== 1) invalid('--version does not accept other arguments');
  if (parsed.help && (parsed.version || parsed.discoveryJson || parsed.id !== null || parsed.port !== null || parsed.timeoutMs !== DEFAULT_TIMEOUT_MS)) invalid('--help does not accept network or query arguments');
  if (parsed.discoveryJson && (parsed.command !== null || parsed.id !== null || parsed.help)) invalid('--discovery-json accepts no subcommand or instance id');
  if (parsed.command === null && !parsed.discoveryJson && !parsed.help && !parsed.version) invalid('a Source subcommand is required');
  if (parsed.command !== null && !parsed.help && parsed.id === null) invalid(`${parsed.command} requires --id`);
  if (parsed.command !== null && parsed.help && parsed.id !== null) invalid(`${parsed.command} --help does not accept --id`);
  if (parsed.command === null && parsed.id !== null) invalid('--id requires the instance subcommand');
  if ((parsed.discoveryJson || (parsed.command !== null && !parsed.help)) && parsed.port === null) invalid('--port is required before contacting the Source service');
  return parsed;
}

function parseJsonBuffer(responseBuffer) {
  let text;
  try {
    text = UTF8_DECODER.decode(responseBuffer);
  } catch {
    protocol();
  }
  if (text.trim().length === 0) protocol();
  let body;
  try { body = JSON.parse(text); } catch { protocol(); }
  return { text, body };
}

async function fetchJson(url, execution, discovery = false) {
  let response;
  try {
    response = await fetch(url, { method: 'GET', redirect: 'manual', signal: execution.signal });
  } catch {
    execution.throwIfAborted();
    fail('SOURCE_CONNECTION_FAILED', CLI_ERROR_MESSAGES.SOURCE_CONNECTION_FAILED, 4);
  }
  let responseBuffer;
  try {
    responseBuffer = Buffer.from(await response.arrayBuffer());
  } catch {
    execution.throwIfAborted();
    fail('SOURCE_CONNECTION_FAILED', CLI_ERROR_MESSAGES.SOURCE_CONNECTION_FAILED, 4);
  }
  execution.throwIfAborted();
  if (response.status < 200 || response.status >= 300) {
    if (discovery) fail('DISCOVERY_HTTP_ERROR', CLI_ERROR_MESSAGES.DISCOVERY_HTTP_ERROR, 3);
  }
  const { text, body } = parseJsonBuffer(responseBuffer);
  return { status: response.status, buffer: responseBuffer, text, body };
}

async function fetchDiscovery(port, execution) {
  const response = await fetchJson(`http://127.0.0.1:${port}${DISCOVERY_PATH}`, execution, true);
  if (response.status !== 200) protocol();
  if (!isObject(response.body)) protocol();
  return response;
}

function collectOperations(discovery) {
  if (!isObject(discovery.paths)) protocol();
  const entries = [
    [INSTANCE_PATH, INSTANCE_OPERATION_ID],
    [TEMPLATE_BUNDLE_PATH, TEMPLATE_BUNDLE_OPERATION_ID]
  ];
  return Object.freeze(entries.map(([path, operationId]) => {
    if (!isObject(discovery.paths[path]) || !isObject(discovery.paths[path].get)) protocol();
    return Object.freeze({ path, method: 'get', operationId });
  }));
}

async function executeSourceRead({ port, path }, execution) {
  const response = await fetchJson(`http://127.0.0.1:${port}${path}`, execution);
  if (response.status >= 200 && response.status < 300) {
    execution.throwIfAborted();
    process.stdout.write(response.buffer);
    return;
  }
  execution.throwIfAborted();
  throw new ServiceHttpError(response.buffer);
}

async function executeInstance({ port, id }, execution) {
  const path = INSTANCE_PATH.replace('{instance_id}', encodeURIComponent(id));
  await executeSourceRead({ port, path }, execution);
}

async function executeTemplateBundle({ port, id }, execution) {
  const path = TEMPLATE_BUNDLE_PATH.replace('{template_id}', encodeURIComponent(id));
  await executeSourceRead({ port, path }, execution);
}

function renderTopLevelHelp() {
  return [
    `${CLI_NAME} reads one registered ComfyUI Host Source record.`,
    '',
    'Usage:',
    `  ${CLI_NAME} --help`,
    `  ${CLI_NAME} instance --help`,
    `  ${CLI_NAME} template-bundle --help`,
    `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] --discovery-json`,
    `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] instance --id <stable-instance-id>`,
    `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] template-bundle --id <stable-template-id>`,
    `  ${CLI_NAME} --version`,
    '',
    'Global options:',
    '  --port <port>                    Explicit loopback port from 1 to 65535',
    `  --timeout-ms <milliseconds>      Total request deadline from 1 to 600000 (default: ${DEFAULT_TIMEOUT_MS})`,
    '  --discovery-json                 Print the live Source discovery wrapper',
    '  --help                           Show this help without contacting the service',
    '  --version                        Show the CLI name and version without contacting the service',
    '',
    'Next:',
    `  ${CLI_NAME} instance --help`,
    `  ${CLI_NAME} template-bundle --help`,
    ''
  ].join('\n');
}

function renderInstanceHelp() {
  return [
    `${CLI_NAME} instance reads one complete ComfyUI connection source by stable instance ID.`,
    '',
    'Usage:',
    `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] instance --id <stable-instance-id>`,
    '',
    'Parameters:',
    '  --port <port>                    Explicit loopback port from 1 to 65535',
    `  --timeout-ms <milliseconds>      Total request deadline from 1 to 600000 (default: ${DEFAULT_TIMEOUT_MS})`,
    '  --id <stable-instance-id>        Stable ID from the corresponding ComfyUI instance Catalog item; positive decimal ID from 1 to 20 digits',
    '',
    'Example:',
    `  ${CLI_NAME} --port 8188 instance --id 31`,
    '',
    'Output:',
    '  2xx body: the CLI requires the target HTTP body to be non-empty, decode as strict UTF-8, and contain exactly one JSON value; the CLI does not validate a response Schema or fields, and writes the original body Buffer to stdout without adding or removing bytes; stderr is empty and exit code is 0.',
    '  Non-2xx body: the CLI requires the target HTTP body to be non-empty, decode as strict UTF-8, and contain exactly one JSON value, then writes the original body Buffer to stderr without adding or removing bytes; stdout is empty and exit code is 7; the CLI does not validate the declared HTTP status, Schema, fields, or error code.',
    '  Target body failure: an empty body, invalid UTF-8, invalid JSON, or multiple JSON values leaves stdout empty, writes the fixed CONTRACT_PROTOCOL_ERROR JSON to stderr, and exits 6.',
    '  Local failure: the CLI writes a fixed CLI error JSON to stderr, leaves stdout empty, and exits with its corresponding non-zero code for invalid arguments, discovery failure, connection failure, timeout, cancellation, or any other local failure.',
    ''
  ].join('\n');
}

function renderTemplateBundleHelp() {
  return [
    `${CLI_NAME} template-bundle reads one complete ComfyUI TemplateBundle by stable template ID.`,
    '',
    'Usage:',
    `  ${CLI_NAME} --port <port> [--timeout-ms <milliseconds>] template-bundle --id <stable-template-id>`,
    '',
    'Parameters:',
    '  --port <port>                    Explicit loopback port from 1 to 65535',
    `  --timeout-ms <milliseconds>      Total request deadline from 1 to 600000 (default: ${DEFAULT_TIMEOUT_MS})`,
    '  --id <stable-template-id>        Stable ID from the corresponding ComfyUI template Catalog item; positive decimal ID from 1 to 20 digits',
    '',
    'Example:',
    `  ${CLI_NAME} --port 8188 template-bundle --id 284001`,
    '',
    'Output:',
    '  2xx body: the CLI requires the target HTTP body to be non-empty, decode as strict UTF-8, and contain exactly one JSON value; the CLI does not validate a response Schema or fields, and writes the original body Buffer to stdout without adding or removing bytes; stderr is empty and exit code is 0.',
    '  Non-2xx body: the CLI requires the target HTTP body to be non-empty, decode as strict UTF-8, and contain exactly one JSON value, then writes the original body Buffer to stderr without adding or removing bytes; stdout is empty and exit code is 7; the CLI does not validate the declared HTTP status, Schema, fields, or error code.',
    '  Target body failure: an empty body, invalid UTF-8, invalid JSON, or multiple JSON values leaves stdout empty, writes the fixed CONTRACT_PROTOCOL_ERROR JSON to stderr, and exits 6.',
    '  Local failure: the CLI writes a fixed CLI error JSON to stderr, leaves stdout empty, and exits with its corresponding non-zero code for invalid arguments, discovery failure, connection failure, timeout, cancellation, or any other local failure.',
    ''
  ].join('\n');
}

async function main(argv = [], testHooks = {}) {
  const options = parseArguments(argv);
  if (testHooks.injectInternalError === true) throw new Error('test-only internal failure');
  if (options.version) {
    process.stdout.write(`${CLI_NAME} ${CLI_VERSION}\n`);
    return;
  }
  if (options.help) {
    process.stdout.write(options.command === 'instance'
      ? renderInstanceHelp()
      : options.command === 'template-bundle' ? renderTemplateBundleHelp() : renderTopLevelHelp());
    return;
  }
  const execution = createExecutionContext(options.timeoutMs);
  try {
    const discoveryResponse = await fetchDiscovery(options.port, execution);
    execution.throwIfAborted();
    if (options.discoveryJson) {
      process.stdout.write(discoveryResponse.buffer);
      return;
    }
    if (options.command === 'instance') {
      await executeInstance({ port: options.port, id: options.id }, execution);
    } else {
      await executeTemplateBundle({ port: options.port, id: options.id }, execution);
    }
  } finally {
    execution.dispose();
  }
}

function writeError(error) {
  if (error instanceof ServiceHttpError) {
    process.stderr.write(error.responseBuffer);
    process.exitCode = error.exitCode;
    return;
  }
  const normalized = error instanceof CliError ? error : new CliError('INTERNAL_CLI_ERROR', CLI_ERROR_MESSAGES.INTERNAL_CLI_ERROR, 6);
  if (normalized.code === 'PROCESS_CANCELLED') {
    process.stderr.write(`${safeJsonStringify({ error: { code: 'PROCESS_CANCELLED', message: normalized.message } })}\n`);
    process.exitCode = normalized.exitCode === 143 ? 143 : 130;
    return;
  }
  const code = Object.hasOwn(CLI_ERROR_MESSAGES, normalized.code) ? normalized.code : 'INTERNAL_CLI_ERROR';
  const message = CLI_ERROR_MESSAGES[code];
  process.stderr.write(`${safeJsonStringify({ error: { code, message } })}\n`);
  process.exitCode = code === 'INVALID_ARGUMENT' ? 2 : code === 'DISCOVERY_HTTP_ERROR' ? 3 : code === 'SOURCE_CONNECTION_FAILED' ? 4 : code === 'TOTAL_TIMEOUT' ? 5 : 6;
}

let directInvocation = false;
if (process.argv[1] !== undefined) {
  try { directInvocation = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { directInvocation = false; }
}
if (directInvocation) main(process.argv.slice(2)).catch(writeError);

export { collectOperations, main, parseArguments, renderInstanceHelp, renderTemplateBundleHelp, renderTopLevelHelp, writeError };
