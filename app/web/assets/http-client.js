(function installHttpClient(global) {
  const runtimeConfig = global.__NOOBAI_URLS__?.config;
  const DEFAULT_TIMEOUT_MS = runtimeConfig?.http_request_timeout_ms;
  if (!Number.isSafeInteger(DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS < 1) {
    throw new Error('runtime configuration http_request_timeout_ms is required');
  }
  const TRANSPORT_ERROR_UI = Object.freeze({
    TIMEOUT: Object.freeze({ area: 'messages', action: 'retry', message: '请求超时，当前输入和页面内容已经保留。', next: '点击重试' }),
    CANCELED: Object.freeze({ area: 'messages', action: 'retry', message: '请求已取消，当前输入和页面内容已经保留。', next: '重新发起请求' }),
    NETWORK_ERROR: Object.freeze({ area: 'messages', action: 'retry', message: '网络请求失败，当前输入和页面内容已经保留。', next: '检查连接后重试' }),
    RESPONSE_JSON_INVALID: Object.freeze({ area: 'messages', action: 'retry', message: '服务返回了非 JSON 数据，当前输入和页面内容已经保留。', next: '稍后重试' }),
    RESPONSE_INVALID: Object.freeze({ area: 'messages', action: 'retry', message: '服务返回了无效的数据结构，当前输入和页面内容已经保留。', next: '稍后重试' })
  });

  function requestError(code, message, properties = {}) {
    return Object.assign(new Error(message), { code, isNoobaiHttpError: true, ...properties });
  }

  async function parseApiResponse(response) {
    const contentType = response?.headers?.get?.('content-type');
    if (typeof contentType === 'string' && !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      throw requestError('RESPONSE_JSON_INVALID', '服务返回了非 JSON 数据。', {
        category: 'NON_JSON_RESPONSE',
        status: response?.status
      });
    }
    let body;
    try {
      body = await response.json();
    } catch (cause) {
      throw requestError('RESPONSE_JSON_INVALID', '服务返回了非 JSON 数据。', {
        category: 'NON_JSON_RESPONSE',
        status: response?.status,
        cause
      });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.ok !== 'boolean') {
      throw requestError('RESPONSE_INVALID', '服务返回了无效的数据结构。', {
        category: 'JSON_STRUCTURE_INVALID',
        status: response?.status
      });
    }
    if (body.ok === false) {
      if (response.ok || body.error === null || typeof body.error !== 'object' || Array.isArray(body.error) || typeof body.error.code !== 'string' || typeof body.error.message !== 'string') {
        throw requestError('RESPONSE_INVALID', '服务错误响应缺少有效错误结构。', {
          category: 'JSON_STRUCTURE_INVALID',
          status: response?.status
        });
      }
      const errorProperties = {
        category: 'HTTP_ERROR',
        status: response.status,
        response: body
      };
      if (body.error.details !== undefined) errorProperties.details = body.error.details;
      if (typeof body.error.user_may_resubmit === 'boolean') errorProperties.user_may_resubmit = body.error.user_may_resubmit;
      if (typeof body.error.display === 'string') errorProperties.display = body.error.display;
      throw requestError(body.error.code, body.error.message, errorProperties);
    }
    if (!response.ok || !Object.hasOwn(body, 'data')) {
      throw requestError('RESPONSE_INVALID', '服务状态与响应结构不一致。', {
        category: 'JSON_STRUCTURE_INVALID',
        status: response?.status
      });
    }
    return body.data;
  }

  async function requestJson({ fetchImpl = (...args) => fetch(...args), path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal = undefined } = {}) {
    if (!(typeof path === 'string' && path.length > 0) && !(path instanceof URL)) throw new TypeError('request path is required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
    const controller = new AbortController();
    let timedOut = false;
    let canceledByCaller = false;
    const abortFromCaller = () => {
      canceledByCaller = true;
      controller.abort();
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(path, { ...options, cache: 'no-store', signal: controller.signal });
      return await parseApiResponse(response);
    } catch (cause) {
      if (cause?.isNoobaiHttpError === true) throw cause;
      if (timedOut) throw requestError('TIMEOUT', '请求超时。', { category: 'TIMEOUT', cause });
      if (canceledByCaller || cause?.name === 'AbortError') throw requestError('CANCELED', '请求已取消。', { category: 'CANCELED', cause });
      throw requestError('NETWORK_ERROR', '网络请求失败。', { category: 'NETWORK_ERROR', cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abortFromCaller);
    }
  }

  global.__NOOBAI_HTTP__ = Object.freeze({ DEFAULT_TIMEOUT_MS, TRANSPORT_ERROR_UI, requestJson });
}(globalThis));
