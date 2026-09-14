export const TRANSACTION_STATE = Object.freeze({
  NOT_STARTED: 'not_started',
  ROLLED_BACK: 'rolled_back',
  UNCERTAIN: 'uncertain'
});

const TRANSACTION_STATES = new Set(Object.values(TRANSACTION_STATE));
const EVIDENCE_KEYS = Object.freeze([
  'originalError',
  'rollbackError',
  'progressError',
  'mediaCleanupError'
]);

function assertTransactionState(transactionState) {
  if (!TRANSACTION_STATES.has(transactionState)) throw new TypeError(`unknown transaction state: ${String(transactionState)}`);
  return transactionState;
}

function isObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function hasOwn(value, property) {
  return isObject(value) && Object.hasOwn(value, property);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class TransactionStateError extends Error {
  constructor(error, transactionState, { evidence = {}, message = errorMessage(error) } = {}) {
    super(message, { cause: error });
    this.name = 'TransactionStateError';
    this.transactionState = assertTransactionState(transactionState);
    this.originalError = hasOwn(error, 'originalError') ? error.originalError : error;
    for (const key of EVIDENCE_KEYS) {
      if (key === 'originalError') continue;
      if (hasOwn(error, key)) this[key] = error[key];
    }
    for (const [key, value] of Object.entries(evidence)) {
      if (!EVIDENCE_KEYS.includes(key)) throw new TypeError(`unknown transaction evidence: ${key}`);
      this[key] = value;
    }
  }
}

function transactionStateCandidates(error) {
  if (!isObject(error)) return [];
  const candidates = [];
  if (error.transactionState !== undefined && error.transactionState !== null) {
    candidates.push(error.transactionState);
  }
  const evidence = error.evidence;
  if (isObject(evidence)) {
    if (evidence.transaction_state !== undefined && evidence.transaction_state !== null) {
      candidates.push(evidence.transaction_state);
    }
    if (evidence.transactionState !== undefined && evidence.transactionState !== null) {
      candidates.push(evidence.transactionState);
    }
  }
  return candidates;
}

export function transactionStateOf(error) {
  const [transactionState] = transactionStateCandidates(error);
  return transactionState === undefined ? null : assertTransactionState(transactionState);
}

export function hasTransactionState(error, transactionState) {
  const expectedState = assertTransactionState(transactionState);
  return transactionStateCandidates(error).some((candidate) => assertTransactionState(candidate) === expectedState);
}

export function markTransactionState(error, transactionState) {
  const requestedState = assertTransactionState(transactionState);
  const currentState = transactionStateOf(error);
  if (currentState === TRANSACTION_STATE.UNCERTAIN || currentState === requestedState) return error;
  if (isObject(error)) {
    try {
      error.transactionState = requestedState;
      if (transactionStateOf(error) === requestedState) return error;
    } catch {}
  }
  return new TransactionStateError(error, requestedState);
}

export function preserveTransactionEvidence(error, evidence, { message = null } = {}) {
  const transactionState = transactionStateOf(error);
  if (transactionState === null) throw new TypeError('transaction evidence requires a marked transaction error');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError('transaction evidence must be an object');
  const entries = Object.entries(evidence);
  for (const [key] of entries) {
    if (!EVIDENCE_KEYS.includes(key)) throw new TypeError(`unknown transaction evidence: ${key}`);
  }
  if (message !== null && typeof message !== 'string') throw new TypeError('transaction evidence message must be a string or null');
  if (isObject(error)) {
    try {
      for (const [key, value] of entries) error[key] = value;
      if (message !== null) error.message = message;
      const evidenceRetained = entries.every(([key, value]) => error[key] === value);
      const messageRetained = message === null || error.message === message;
      if (evidenceRetained && messageRetained) return error;
    } catch {}
  }
  return new TransactionStateError(error, transactionState, {
    evidence,
    message: message ?? errorMessage(error)
  });
}
