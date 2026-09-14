#!/usr/bin/env node

import { copyFile, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMAND_NAME = 'imagegen-semantic-query';
const SOURCE_CLI_NAME = 'imagegen-comfyui-source-read';
const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(SOURCE_DIRECTORY, `${COMMAND_NAME}.mjs`);
const SOURCE_CLI_PATH = resolve(SOURCE_DIRECTORY, `${SOURCE_CLI_NAME}.mjs`);

function fail(message) {
  throw new Error(message);
}

function installationDestination(argv, environment = process.env) {
  if (argv.length === 0) {
    if (environment.NODE_ENV === 'test') fail('test installation requires --test-destination <absolute-file>');
    return resolve(homedir(), '.local/bin', COMMAND_NAME);
  }
  if (argv.length !== 2 || argv[0] !== '--test-destination') fail('usage: npm run cli:install [-- --test-destination <absolute-file>]');
  if (environment.NODE_ENV !== 'test') fail('--test-destination is available only when NODE_ENV=test');
  if (!isAbsolute(argv[1])) fail('--test-destination must be an absolute file path');
  return argv[1];
}

async function install(argv) {
  const destinations = [
    { name: COMMAND_NAME, source: SOURCE_PATH, destination: installationDestination(argv) },
    { name: SOURCE_CLI_NAME, source: SOURCE_CLI_PATH }
  ];
  const destinationDirectory = dirname(destinations[0].destination);
  destinations[1].destination = resolve(destinationDirectory, SOURCE_CLI_NAME);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
  for (const { name, source, destination } of destinations) {
    const temporaryDestination = resolve(destinationDirectory, `.${name}.${process.pid}.tmp`);
    try {
      await copyFile(source, temporaryDestination);
      await chmod(temporaryDestination, 0o755);
      await rename(temporaryDestination, destination);
    } finally {
      await rm(temporaryDestination, { force: true });
    }
    process.stdout.write(`Installed ${name} to ${destination}\n`);
  }
}

if (typeof process.argv[1] === 'string' && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  install(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { installationDestination };
