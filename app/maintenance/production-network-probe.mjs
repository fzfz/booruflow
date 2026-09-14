import { connect } from 'node:net';

export const PRODUCTION_NETWORK_CHECK_TIMEOUT_MS = 750;

function configuredPortError() {
  throw new Error('production runtime configuration listener ports are required');
}

export function productionListenerPorts(runtimeConfiguration) {
  if (runtimeConfiguration === null || typeof runtimeConfiguration !== 'object' || runtimeConfiguration.listeners === null || typeof runtimeConfiguration.listeners !== 'object') {
    throw new Error('production runtime configuration with listeners is required');
  }
  const listeners = [runtimeConfiguration.listeners.public, runtimeConfiguration.listeners.internal];
  if (listeners.some((listener) => listener === null || typeof listener !== 'object' || !Number.isSafeInteger(listener.port) || listener.port < 1 || listener.port > 65535)) {
    configuredPortError();
  }
  return Object.freeze(listeners.map(({ port }) => port));
}

export function createProductionTcpPortProbe({
  connectSocket = connect,
  timeoutMs = PRODUCTION_NETWORK_CHECK_TIMEOUT_MS
} = {}) {
  if (typeof connectSocket !== 'function') throw new Error('production TCP connect function is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('production TCP probe timeout must be positive');

  return (port) => new Promise((resolvePromise, reject) => {
    const socket = connectSocket({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    const failProbe = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED') finish(false);
      else failProbe(new Error(`cannot determine whether configured port ${port} is in use`, { cause: error }));
    });
    socket.setTimeout(timeoutMs, () => failProbe(new Error(`cannot determine whether configured port ${port} is in use`)));
  });
}

export const tcpPortIsListening = createProductionTcpPortProbe();
