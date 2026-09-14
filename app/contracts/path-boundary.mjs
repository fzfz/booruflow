import * as path from 'node:path';

export function isPathWithinBoundary(boundary, target, pathModule = path) {
  if (typeof boundary !== 'string' || typeof target !== 'string') {
    throw new TypeError('path boundary and target must be strings');
  }
  const remainder = pathModule.relative(boundary, target);
  return remainder !== ''
    && remainder !== '..'
    && !remainder.startsWith(`..${pathModule.sep}`)
    && !pathModule.isAbsolute(remainder);
}
