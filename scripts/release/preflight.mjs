import { fileURLToPath } from 'node:url';

import { requireReleaseContext } from './release-context.mjs';

export function main([tag, expectedSha, repository] = process.argv.slice(2)) {
  if (!tag || !expectedSha || !repository || process.argv.slice(2).length !== 3) {
    throw new Error('Usage: node scripts/release/preflight.mjs vX.Y.Z COMMIT_SHA OWNER/REPOSITORY');
  }
  requireReleaseContext({ tag, expectedSha, repository });
  process.stdout.write(`Release preflight passed for ${tag} at ${expectedSha}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
