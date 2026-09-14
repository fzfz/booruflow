import { createHash, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import { ApplicationError } from '../security/error-mapping.mjs';

const MIME_BY_EXTENSION = Object.freeze({
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm'
});
const IMAGE_MIME_BY_DECLARATION = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const ISO_NON_VIDEO_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

export function hasSupportedImageSignature(bytes) {
  return Buffer.isBuffer(bytes) && (bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'));
}

export function detectMediaType(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return Object.freeze({ media_kind: 'image', mediaType: 'image/png', extension: 'png' });
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return Object.freeze({ media_kind: 'image', mediaType: 'image/jpeg', extension: 'jpg' });
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return Object.freeze({ media_kind: 'image', mediaType: 'image/webp', extension: 'webp' });
  const video = videoContainer(bytes);
  if (video !== null) return Object.freeze({ media_kind: 'video', mediaType: video.mediaType, extension: video.extension });
  return null;
}

function failType(message) {
  throw new ApplicationError('UPLOAD_TYPE_UNSUPPORTED', message);
}

function assertWithin(root, target, label) {
  const relativePath = relative(root, target);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.includes(`..${sep}`)) {
    throw new Error(`${label} escapes its controlled root`);
  }
  return target;
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), extension: 'png', mediaType: 'image/png' };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 8) return null;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), extension: 'jpg', mediaType: 'image/jpeg' };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes) {
  if (bytes.length < 16 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), extension: 'webp', mediaType: 'image/webp' };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, extension: 'webp', mediaType: 'image/webp' };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), extension: 'webp', mediaType: 'image/webp' };
  }
  return null;
}

export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) failType('file must contain image bytes');
  const image = pngDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes);
  if (!image || image.width < 1 || image.height < 1) failType('file is not a valid JPEG, PNG, or WebP image');
  return Object.freeze({ ...image, content_hash: createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length });
}

function readIsoBox(bytes, offset) {
  if (offset + 8 > bytes.length) return null;
  const size = bytes.readUInt32BE(offset);
  const type = bytes.toString('ascii', offset + 4, offset + 8);
  let boxSize = size;
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    const extended = bytes.readBigUInt64BE(offset + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    boxSize = Number(extended);
    headerSize = 16;
  } else if (size === 0) {
    boxSize = bytes.length - offset;
  }
  if (boxSize < headerSize || offset + boxSize > bytes.length) return null;
  return { type, end: offset + boxSize, headerSize };
}

function validIsoVideo(bytes) {
  const first = readIsoBox(bytes, 0);
  if (first === null || first.type !== 'ftyp' || first.end < 16) return false;
  const brands = [];
  for (let offset = 8; offset + 4 <= first.end; offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4));
  if (brands.some((brand) => ISO_NON_VIDEO_BRANDS.has(brand))) return false;
  let offset = first.end;
  let hasMediaBox = false;
  while (offset < bytes.length) {
    const box = readIsoBox(bytes, offset);
    if (box === null) return false;
    if (['moov', 'mdat', 'moof'].includes(box.type)) hasMediaBox = true;
    offset = box.end;
  }
  return hasMediaBox;
}

function readEbmlVint(bytes, offset) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  let width = 1;
  let mask = 0x80;
  while (width <= 8 && (first & mask) === 0) { width += 1; mask >>= 1; }
  if (width > 8 || offset + width > bytes.length) return null;
  let value = first & (mask - 1);
  for (let index = 1; index < width; index += 1) value = value * 256 + bytes[offset + index];
  const unknown = value === (2 ** (7 * width)) - 1;
  return { width, value, unknown };
}

function validWebm(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 4).equals(EBML_SIGNATURE)) return false;
  const headerSize = readEbmlVint(bytes, 4);
  if (headerSize === null) return false;
  const headerEnd = 4 + headerSize.width + headerSize.value;
  if (headerEnd > bytes.length) return false;
  let hasWebmDocType = false;
  for (let offset = 4 + headerSize.width; offset + 4 <= headerEnd; offset += 1) {
    if (bytes[offset] !== 0x42 || bytes[offset + 1] !== 0x82) continue;
    const size = readEbmlVint(bytes, offset + 2);
    if (size === null || size.unknown || offset + 2 + size.width + size.value > headerEnd) continue;
    hasWebmDocType = bytes.toString('ascii', offset + 2 + size.width, offset + 2 + size.width + size.value) === 'webm';
  }
  if (!hasWebmDocType || headerEnd + 4 > bytes.length || !bytes.subarray(headerEnd, headerEnd + 4).equals(Buffer.from([0x18, 0x53, 0x80, 0x67]))) return false;
  const segmentSize = readEbmlVint(bytes, headerEnd + 4);
  if (segmentSize === null) return false;
  const segmentStart = headerEnd + 4 + segmentSize.width;
  const segmentEnd = segmentSize.unknown ? bytes.length : segmentStart + segmentSize.value;
  if (segmentEnd > bytes.length || segmentStart >= segmentEnd) return false;
  return bytes.subarray(segmentStart, segmentEnd).includes(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
}

function videoContainer(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (validIsoVideo(bytes)) return { extension: 'mp4', mediaType: 'video/mp4', media_kind: 'video' };
  if (validWebm(bytes)) return { extension: 'webm', mediaType: 'video/webm', media_kind: 'video' };
  return null;
}

function assertUuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('media identifier must be a UUID');
  }
  return value.toLowerCase();
}

function defaultRandomDigits() {
  return String(randomInt(0, 100000)).padStart(5, '0');
}

export function createMediaStorage({
  mediaRoot,
  maxFileBytes = 10 * 1024 * 1024,
  maxFiles = 10,
  allowedMediaTypes = [...IMAGE_MIME_BY_DECLARATION],
  makeId = randomUUID,
  makeRandomDigits = defaultRandomDigits
} = {}) {
  if (typeof mediaRoot !== 'string' || mediaRoot.length === 0) throw new Error('mediaRoot is required');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error('maxFileBytes must be a positive integer');
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10) throw new Error('maxFiles must be an integer from 1 to 10');
  if (!Array.isArray(allowedMediaTypes) || allowedMediaTypes.some((value) => !IMAGE_MIME_BY_DECLARATION.has(value))) throw new Error('allowedMediaTypes must contain only image media types');
  if (typeof makeId !== 'function' || typeof makeRandomDigits !== 'function') throw new TypeError('media identifier factories must be functions');
  const root = resolve(mediaRoot);
  const imagesRoot = resolve(root, 'images');
  const videosRoot = resolve(root, 'videos');
  const stagingRoot = resolve(root, '.staging');
  const committedEntries = new WeakSet();
  mkdirSync(imagesRoot, { recursive: true, mode: 0o700 });
  mkdirSync(videosRoot, { recursive: true, mode: 0o700 });
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });

  function pathFor(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\u0000') || relativePath.includes('\\')) {
      throw new Error('media path must be a non-empty slash-separated relative path');
    }
    const target = resolve(root, relativePath);
    assertWithin(root, target, 'media path');
    if (!isInsideMediaRoot(target)) throw new Error('media path must be inside the images or videos root');
    return target;
  }

  function isInsideMediaRoot(target) {
    return [imagesRoot, videosRoot].some((mediaDirectory) => {
      const path = relative(mediaDirectory, target);
      return path !== '' && path !== '..' && !path.startsWith(`..${sep}`);
    });
  }

  function stageMediaFiles(files, { maxBytes, fileLimit, mediaTypes } = {}) {
    if (!Array.isArray(files) || files.length < 1) throw new ApplicationError('VALIDATION_ERROR', 'files must contain at least 1 entry');
    if (files.length > fileLimit) throw new ApplicationError('VALIDATION_ERROR', `files must contain at most ${fileLimit} entries`);
    const staged = [];
    let currentTemporaryPath = null;
    try {
      for (const [index, file] of files.entries()) {
        if (!file || typeof file !== 'object' || !Buffer.isBuffer(file.bytes)) throw new ApplicationError('VALIDATION_ERROR', `files[${index}] must provide Buffer bytes`);
        if (file.bytes.length > maxBytes) throw new ApplicationError('UPLOAD_TOO_LARGE', `files[${index}] exceeds the upload size limit`);
        if (file.media_type !== undefined && !IMAGE_MIME_BY_DECLARATION.has(file.media_type)) failType(`files[${index}] declares an unsupported media type`);
        const temporaryPath = resolve(stagingRoot, `${assertUuid(makeId())}.part`);
        assertWithin(stagingRoot, temporaryPath, 'staging path');
        const descriptor = openSync(temporaryPath, 'wx', 0o600);
        currentTemporaryPath = temporaryPath;
        try {
          writeFileSync(descriptor, file.bytes);
        } finally {
          closeSync(descriptor);
        }
        const inspected = { ...inspectImage(readFileSync(temporaryPath)), media_kind: 'image' };
        if (file.media_kind !== undefined && file.media_kind !== inspected.media_kind) failType(`files[${index}] media kind does not match its bytes`);
        if (file.media_type !== undefined && file.media_type !== inspected.mediaType) failType(`files[${index}] media type does not match its bytes`);
        if (!mediaTypes.includes(inspected.mediaType)) failType(`files[${index}] media type is disabled by configuration`);
        let media_path = null;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const identifier = assertUuid(makeId());
          const randomDigits = makeRandomDigits();
          if (typeof randomDigits !== 'string' || !/^\d{5}$/u.test(randomDigits)) throw new Error('media random suffix must contain exactly five digits');
          const mediaDirectory = inspected.media_kind === 'video' ? 'videos' : 'images';
          const candidate = `${mediaDirectory}/${identifier.slice(0, 2)}/${identifier}-${randomDigits}.${inspected.extension}`;
          if (!existsSync(pathFor(candidate))) {
            media_path = candidate;
            break;
          }
        }
        if (media_path === null) throw new Error('unable to allocate a unique media path');
        mkdirSync(dirname(pathFor(media_path)), { recursive: true, mode: 0o700 });
        staged.push(Object.freeze({ temporaryPath, media_path, finalPath: pathFor(media_path), ...inspected }));
        currentTemporaryPath = null;
      }
      return Object.freeze(staged);
    } catch (error) {
      for (const entry of staged) rmSync(entry.temporaryPath, { force: true });
      if (currentTemporaryPath !== null) rmSync(currentTemporaryPath, { force: true });
      throw error;
    }
  }

  function stageFiles(files) {
    return stageMediaFiles(files, { maxBytes: maxFileBytes, fileLimit: maxFiles, mediaTypes: allowedMediaTypes });
  }

  function commit(staged) {
    for (const entry of staged) {
      if (existsSync(entry.finalPath)) throw new Error(`refusing to replace existing media file ${basename(entry.finalPath)}`);
      try {
        linkSync(entry.temporaryPath, entry.finalPath);
        committedEntries.add(entry);
        unlinkSync(entry.temporaryPath);
      } catch (error) {
        if (error?.code === 'EEXIST') throw new Error(`refusing to replace existing media file ${basename(entry.finalPath)}`);
        throw error;
      }
    }
  }

  function discard(staged) {
    for (const entry of staged) {
      rmSync(entry.temporaryPath, { force: true });
      if (committedEntries.has(entry)) {
        rmSync(entry.finalPath, { force: true });
        committedEntries.delete(entry);
      }
    }
  }

  function remove(localPath) {
    const target = pathFor(localPath);
    rmSync(target);
  }

  return Object.freeze({ mediaRoot: root, imagesRoot, videosRoot, pathFor, stageFiles, commit, discard, remove });
}
