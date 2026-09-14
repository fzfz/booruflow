import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { publicPrefixPath } from './public-path.mjs';
import { detectMediaType } from '../media/media-storage.mjs';

const MEDIA_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
});
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function normalisePublicPath(publicPath) {
  const resolved = publicPrefixPath(publicPath);
  if (resolved.includes('//') || (resolved !== '' && resolved.endsWith('/'))) {
    throw new Error('media public path must not end with a slash or contain empty path segments');
  }
  return resolved;
}

function isInside(root, target) {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`);
}

function notFound() {
  return Object.freeze({
    status: 404,
    binary: true,
    headers: Object.freeze({ 'content-type': 'text/plain; charset=utf-8', 'content-length': '0' }),
    body: Buffer.alloc(0)
  });
}

function methodNotAllowed() {
  return Object.freeze({
    status: 405,
    binary: true,
    headers: Object.freeze({ allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'content-length': '0' }),
    body: Buffer.alloc(0)
  });
}

function decodeRelativePath(pathname, prefix) {
  const rawPath = pathname.slice(prefix.length);
  if (!rawPath.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath.slice(1));
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.includes(String.fromCharCode(0)) || decoded.includes('\\')) return null;
  if (decoded.startsWith('/') || /^[A-Za-z]:/u.test(decoded)) return null;
  const segments = decoded.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null;
  return segments;
}

function requestPathname(url) {
  if (typeof url === 'string' && url.startsWith('/')) return url.split(/[?#]/u, 1)[0];
  return new URL(url, 'http://noobai.local').pathname;
}

export function createStaticMediaDispatcher({ mediaRoot, publicPath = '/media' } = {}) {
  if (typeof mediaRoot !== 'string' || mediaRoot.length === 0) throw new Error('mediaRoot is required');
  const root = realpathSync(resolve(mediaRoot));
  const prefix = normalisePublicPath(publicPath);

  function canHandle({ listener, method, url }) {
    if (listener !== 'public') return false;
    const pathname = requestPathname(url);
    if (prefix === '') return MEDIA_TYPES[extname(pathname).toLocaleLowerCase('en-US')] !== undefined;
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }

  function dispatch({ listener, method, url }) {
    if (!canHandle({ listener, method, url })) return null;
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();
    const pathname = requestPathname(url);
    const segments = decodeRelativePath(pathname, prefix);
    if (segments === null) return notFound();
    const target = resolve(root, ...segments);
    if (!isInside(root, target)) return notFound();

    let realTarget;
    let stat;
    try {
      realTarget = realpathSync(target);
      stat = lstatSync(target);
    } catch {
      return notFound();
    }
    if (!isInside(root, realTarget) || !stat.isFile()) return notFound();
    let fileDescriptor;
    try {
      fileDescriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedRealTarget = realpathSync(target);
      const openedStat = fstatSync(fileDescriptor);
      const sameFile = openedStat.dev === stat.dev && openedStat.ino === stat.ino && openedStat.size === stat.size;
      if (!isInside(root, openedRealTarget) || !openedStat.isFile() || !sameFile) return notFound();
      const bytes = Buffer.from(readFileSync(fileDescriptor));
      const media = detectMediaType(bytes);
      if (media === null) return notFound();
      const body = method === 'HEAD' ? Buffer.alloc(0) : bytes;
      return Object.freeze({
        status: 200,
        binary: true,
        headers: Object.freeze({
          'content-type': media.mediaType,
          'content-length': String(openedStat.size),
          'cache-control': CACHE_CONTROL
        }),
        body
      });
    } catch {
      return notFound();
    } finally {
      if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    }
  }

  return Object.freeze({ publicPath: prefix || '/', canHandle, dispatch });
}
