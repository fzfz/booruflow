import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

import { isPathWithinBoundary } from './path-boundary.mjs';

function assertDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular directory: ${path}`);
}

export function canonicalRepositoryRoot(repositoryRoot, label = 'repositoryRoot') {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  const rootPath = path.resolve(repositoryRoot);
  try {
    assertDirectory(rootPath, label);
    return realpathSync(rootPath);
  } catch (error) {
    throw new Error(`cannot resolve ${label} ${rootPath}: ${error.message}`, { cause: error });
  }
}

export function resolveRepositoryContractFile({ repositoryRoot, relativePath, label = 'repository contract' } = {}) {
  const root = canonicalRepositoryRoot(repositoryRoot);
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0 || path.isAbsolute(relativePath)) {
    throw new TypeError(`${label} relativePath must be a non-empty relative path`);
  }
  const target = path.resolve(root, relativePath);
  if (!isPathWithinBoundary(root, target)) {
    throw new Error(`${label} escapes repositoryRoot: ${target}`);
  }
  const rootRelative = path.relative(root, target);
  let current = root;
  const segments = rootRelative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.resolve(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      throw new Error(`cannot resolve ${label} target ${target}; path ${current}: ${error.message}`, { cause: error });
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} has a symlink ancestor: ${current}`);
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`${label} has a non-directory ancestor: ${current}`);
    if (index === segments.length - 1 && !stat.isFile()) throw new Error(`${label} is not a regular file: ${current}`);
  }
  let realTarget;
  try {
    realTarget = realpathSync(target);
  } catch (error) {
    throw new Error(`cannot resolve ${label} target ${target}: ${error.message}`, { cause: error });
  }
  if (!isPathWithinBoundary(root, realTarget)) {
    throw new Error(`${label} resolves outside repositoryRoot: ${target}`);
  }
  return Object.freeze({ repositoryRoot: root, path: target });
}
