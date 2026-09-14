import { createHash } from 'node:crypto';

function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
    if (value === Infinity) return { type: 'number', value: 'Infinity' };
    if (value === -Infinity) return { type: 'number', value: '-Infinity' };
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (seen.has(value)) throw new TypeError('cannot fingerprint a cyclic contract structure');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .map((entry) => canonicalize(entry, seen))
        .filter((entry) => entry !== undefined);
    }
    const canonical = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const entry = canonicalize(value[key], seen);
      if (entry !== undefined) canonical[key] = entry;
    }
    return canonical;
  } finally {
    seen.delete(value);
  }
}

export function contractStructureFingerprint(value) {
  const serialized = JSON.stringify(canonicalize(value));
  return createHash('sha256').update(serialized).digest('hex');
}
