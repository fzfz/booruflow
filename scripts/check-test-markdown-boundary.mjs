import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const testRoot = 'tests';
const testSourcePattern = /\.(?:cjs|js|mjs|ts|tsx|jsx)$/u;

const readCallNames = Object.freeze(['readFile', 'readFileSync', 'read_text', 'open']);
const shellCommandPattern = /\b(?:grep|rg)\b[^\n;]*\.md\b/gu;

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function lineSource(source, index) {
  return source.slice(source.lastIndexOf('\n', index - 1) + 1, source.indexOf('\n', index) === -1 ? source.length : source.indexOf('\n', index)).trim();
}

function findCallEnd(source, openIndex) {
  let depth = 0;
  let state = 'code';
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      if (character === '\\') {
        index += 1;
      } else if ((state === 'single-quote' && character === "'")
        || (state === 'double-quote' && character === '"')
        || (state === 'template' && character === '`')) {
        state = 'code';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (character === "'") {
      state = 'single-quote';
      continue;
    }
    if (character === '"') {
      state = 'double-quote';
      continue;
    }
    if (character === '`') {
      state = 'template';
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function findMarkdownReadViolations(source) {
  const violations = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index] === quote) {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (/[A-Za-z0-9_$]/u.test(source[index] ?? '')) index += 1;
      const name = source.slice(start, index);
      if (!readCallNames.includes(name)) continue;
      while (/\s/u.test(source[index] ?? '')) index += 1;
      if (source[index] !== '(') continue;
      const end = findCallEnd(source, index);
      if (end === -1) continue;
      const argumentsSource = source.slice(index + 1, end);
      if (/\.md\b/u.test(argumentsSource)) {
        violations.push(Object.freeze({
          line: lineNumber(source, start),
          kind: `${name}(...md`,
          source: lineSource(source, start)
        }));
      }
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return violations;
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && testSourcePattern.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

export async function findTestMarkdownBoundaryViolations(root = repositoryRoot) {
  const files = (await filesUnder(resolve(root, testRoot))).sort();
  const violations = [];
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    const source = lines.join('\n');
    for (const violation of findMarkdownReadViolations(source)) {
      violations.push(Object.freeze({ file: relative(root, file), ...violation }));
    }
    shellCommandPattern.lastIndex = 0;
    for (const match of source.matchAll(shellCommandPattern)) {
      violations.push(Object.freeze({
        file: relative(root, file),
        line: lineNumber(source, match.index),
        kind: 'grep/rg ...md',
        source: lineSource(source, match.index)
      }));
    }
  }
  return Object.freeze(violations);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = await findTestMarkdownBoundaryViolations();
  if (violations.length === 0) {
    console.log('测试 Markdown 边界通过：tests/ 下测试源码未发现 Markdown 引用或读取命令。');
  } else {
    const files = new Set(violations.map((violation) => violation.file));
    console.error(`测试 Markdown 边界失败：${violations.length} 处违规，涉及 ${files.size} 个测试文件。`);
    for (const violation of violations) console.error(`${violation.file}:${violation.line} [${violation.kind}] ${violation.source}`);
    process.exitCode = 1;
  }
}
