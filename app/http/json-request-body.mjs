export const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;

export class DuplicateJsonKeyError extends Error {
  constructor(key) {
    super(`JSON object contains a duplicate key: ${key}`);
    this.name = 'DuplicateJsonKeyError';
    this.key = key;
  }
}

function skipWhitespace(text, index) {
  while (index < text.length && isWhitespace(text[index])) index += 1;
  return index;
}

function isWhitespace(character) {
  return character === '\t' || character === '\n' || character === '\r' || character === ' ';
}

function isPrimitiveDelimiter(character) {
  return character === undefined || isWhitespace(character) || character === ',' || character === ']' || character === '}';
}

function scanString(text, start) {
  let index = start + 1;
  let escaped = false;
  while (index < text.length) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      const raw = text.slice(start, index + 1);
      return { end: index + 1, value: JSON.parse(raw) };
    }
    index += 1;
  }
  throw new SyntaxError('unterminated JSON string');
}

function scanValue(text, start) {
  let index = skipWhitespace(text, start);
  const character = text[index];
  if (character === '"') return scanString(text, index).end;
  if (character === '{') return scanObject(text, index);
  if (character === '[') return scanArray(text, index);
  while (index < text.length && !isPrimitiveDelimiter(text[index])) index += 1;
  return index;
}

function scanObject(text, start) {
  let index = skipWhitespace(text, start + 1);
  const keys = new Set();
  if (text[index] === '}') return index + 1;
  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (text[index] !== '"') throw new SyntaxError('JSON object key must be a string');
    const key = scanString(text, index);
    if (keys.has(key.value)) throw new DuplicateJsonKeyError(key.value);
    keys.add(key.value);
    index = skipWhitespace(text, key.end);
    if (text[index] !== ':') throw new SyntaxError('JSON object key must be followed by a colon');
    index = scanValue(text, index + 1);
    index = skipWhitespace(text, index);
    if (text[index] === '}') return index + 1;
    if (text[index] !== ',') throw new SyntaxError('JSON object entry must be followed by a comma');
    index = skipWhitespace(text, index + 1);
  }
  throw new SyntaxError('unterminated JSON object');
}

function scanArray(text, start) {
  let index = skipWhitespace(text, start + 1);
  if (text[index] === ']') return index + 1;
  while (index < text.length) {
    index = scanValue(text, index);
    index = skipWhitespace(text, index);
    if (text[index] === ']') return index + 1;
    if (text[index] !== ',') throw new SyntaxError('JSON array entry must be followed by a comma');
    index = skipWhitespace(text, index + 1);
  }
  throw new SyntaxError('unterminated JSON array');
}

function assertNoDuplicateJsonKeys(text) {
  const end = scanValue(text, 0);
  if (skipWhitespace(text, end) !== text.length) throw new SyntaxError('JSON body must contain one value');
}

export function parseJsonRequestBody(text) {
  const value = JSON.parse(text);
  assertNoDuplicateJsonKeys(text);
  return value;
}
