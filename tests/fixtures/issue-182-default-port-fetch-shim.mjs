const targetPort = process.env.ISSUE_182_DISCOVERY_TARGET_PORT;
if (!/^[0-9]+$/u.test(targetPort ?? '')) throw new Error('ISSUE_182_DISCOVERY_TARGET_PORT is required');

const nativeFetch = globalThis.fetch;
globalThis.fetch = function issue182DefaultPortFetch(input, init) {
  const requested = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (requested.protocol !== 'http:' || requested.hostname !== '127.0.0.1' || requested.port !== '18093' || requested.pathname !== '/internal/semantic') {
    throw new Error(`unexpected default discovery URL: ${requested.href}`);
  }
  requested.port = targetPort;
  return nativeFetch(requested, init);
};
