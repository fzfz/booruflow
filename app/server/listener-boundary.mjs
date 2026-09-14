const INTERNAL_SEMANTIC_PREFIX = '/internal/semantic/';
const INTERNAL_SOURCE_PREFIX = '/internal/comfyui-source/';

function isInternalSourcePath(requestPath) {
  return requestPath === '/internal/comfyui-source' || requestPath.startsWith(INTERNAL_SOURCE_PREFIX);
}

export function createListenerDefinitions(config) {
  return Object.freeze({
    public: Object.freeze({
      name: 'public',
      host: config.listeners.public.host,
      port: config.listeners.public.port,
      allowedPathPrefixes: Object.freeze(['/api/', '/'])
    }),
    internal: Object.freeze({
      name: 'internal',
      host: config.listeners.internal.host,
      port: config.listeners.internal.port,
      allowedPathPrefixes: Object.freeze(['/internal/semantic', INTERNAL_SEMANTIC_PREFIX, '/internal/comfyui-source', INTERNAL_SOURCE_PREFIX])
    })
  });
}

export function routeListenerRequest(listenerName, requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/')) {
    throw new Error('requestPath must be an absolute path');
  }

  if (listenerName === 'public') {
    if (requestPath === '/internal/semantic' || requestPath.startsWith(INTERNAL_SEMANTIC_PREFIX) || isInternalSourcePath(requestPath)) {
      return Object.freeze({ status: 404, route: null });
    }
    return Object.freeze({ status: 200, route: 'public' });
  }

  if (listenerName === 'internal') {
    if (requestPath === '/internal/semantic' || requestPath.startsWith(INTERNAL_SEMANTIC_PREFIX)) {
      return Object.freeze({ status: 200, route: 'internal-semantic' });
    }
    if (isInternalSourcePath(requestPath)) {
      return Object.freeze({ status: 200, route: 'internal-source' });
    }
    return Object.freeze({ status: 404, route: null });
  }

  throw new Error(`unknown listener: ${listenerName}`);
}
