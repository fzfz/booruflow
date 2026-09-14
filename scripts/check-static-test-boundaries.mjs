import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scanRoots = Object.freeze(['tests/integration', 'tests/e2e']);
const prohibitedPatterns = Object.freeze([
  Object.freeze({ kind: 'createServer', pattern: /\bcreateServer\s*\(/u }),
  Object.freeze({ kind: 'fake fetch', pattern: /(?:\b(?:globalThis|window|sandbox)\.fetch\s*=|\bfetch\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/u }),
  Object.freeze({ kind: 'direct dispatcher', pattern: /\b(?:createCatalogHttpDispatcher|createMediaHttpDispatcher)\b|\bdispatcher\.dispatch\s*\(/u }),
  Object.freeze({ kind: 'fake route', pattern: /\.(?:route|page\.route)\s*\(|\brequest\.method\s*===.*\burl\.(?:pathname|href)\b/u })
]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && path.endsWith('.mjs') ? [path] : [];
  }));
  return files.flat();
}

export async function findStaticBoundaryViolations(root = repositoryRoot) {
  const files = (await Promise.all(scanRoots.map((scanRoot) => filesUnder(resolve(root, scanRoot))))).flat().sort();
  const violations = [];
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((source, index) => {
      for (const { kind, pattern } of prohibitedPatterns) {
        if (pattern.test(source)) violations.push(Object.freeze({ file: relative(root, file), line: index + 1, kind, source: source.trim() }));
      }
    });
  }
  return Object.freeze(violations);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = await findStaticBoundaryViolations();
  if (violations.length === 0) {
    console.log('静态测试边界通过：tests/integration 与 tests/e2e 未发现假 HTTP、假 fetch、直接 dispatcher 或假路由。');
  } else {
    const files = new Set(violations.map((violation) => violation.file));
    console.error(`静态测试边界失败：${violations.length} 处违规，涉及 ${files.size} 个待迁移测试文件。`);
    for (const violation of violations) console.error(`${violation.file}:${violation.line} [${violation.kind}] ${violation.source}`);
    process.exitCode = 1;
  }
}
