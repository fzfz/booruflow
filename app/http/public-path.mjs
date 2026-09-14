export function publicPrefixPath(prefix) {
  if (typeof prefix !== 'string') throw new TypeError('public prefix must be a string');
  if (prefix === '' || prefix === '/') return '';
  const pathname = prefix.startsWith('/') ? prefix : new URL(prefix).pathname;
  return pathname === '/' ? '' : pathname;
}

export function stripPublicPrefix(pathname, prefix) {
  const publicPath = publicPrefixPath(prefix);
  if (publicPath === '') return pathname;
  if (pathname === publicPath) return '/';
  if (!pathname.startsWith(`${publicPath}/`)) return null;
  return pathname.slice(publicPath.length);
}

export function joinPublicPrefix(prefix, suffix) {
  if (typeof suffix !== 'string' || !suffix.startsWith('/')) throw new TypeError('public suffix must be root-relative');
  const publicPath = publicPrefixPath(prefix);
  return `${publicPath}${suffix}` || '/';
}
