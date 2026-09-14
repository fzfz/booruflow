import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TRANSACTION_STATE,
  TransactionStateError,
  hasTransactionState,
  markTransactionState,
  preserveTransactionEvidence,
  transactionStateOf
} from '../../app/transaction-state.mjs';

test('transaction state reading accepts only absent, null, or the three canonical states', () => {
  assert.equal(transactionStateOf(new Error('missing state')), null);
  const nullStateError = new Error('explicitly state-less');
  nullStateError.transactionState = null;
  assert.equal(transactionStateOf(nullStateError), null);
  for (const transactionState of Object.values(TRANSACTION_STATE)) {
    const error = new Error(transactionState);
    error.transactionState = transactionState;
    assert.equal(transactionStateOf(error), transactionState);
  }
  const unknownStateError = new Error('unknown state');
  unknownStateError.transactionState = 'committed';
  assert.throws(() => transactionStateOf(unknownStateError), /unknown transaction state: committed/u);
});

test('transaction state helpers mark not-started and rolled-back errors and never downgrade uncertainty', () => {
  const beginError = new Error('begin failed');
  assert.equal(markTransactionState(beginError, TRANSACTION_STATE.NOT_STARTED), beginError);
  assert.equal(transactionStateOf(beginError), TRANSACTION_STATE.NOT_STARTED);
  assert.equal(hasTransactionState(beginError, TRANSACTION_STATE.NOT_STARTED), true);

  const callbackError = new Error('callback failed');
  assert.equal(markTransactionState(callbackError, TRANSACTION_STATE.ROLLED_BACK), callbackError);
  assert.equal(transactionStateOf(callbackError), TRANSACTION_STATE.ROLLED_BACK);

  const uncertainError = new Error('transaction uncertain');
  markTransactionState(uncertainError, TRANSACTION_STATE.UNCERTAIN);
  assert.equal(markTransactionState(uncertainError, TRANSACTION_STATE.ROLLED_BACK), uncertainError);
  assert.equal(transactionStateOf(uncertainError), TRANSACTION_STATE.UNCERTAIN);
});

test('a non-extensible error receives a typed transaction-state wrapper with the original cause', () => {
  const originalError = Object.preventExtensions(new Error('sealed begin failure'));
  const marked = markTransactionState(originalError, TRANSACTION_STATE.NOT_STARTED);
  assert.equal(marked instanceof TransactionStateError, true);
  assert.equal(transactionStateOf(marked), TRANSACTION_STATE.NOT_STARTED);
  assert.equal(marked.originalError, originalError);
  assert.equal(marked.cause, originalError);
});

test('preserving evidence keeps original, rollback, progress, and media cleanup causes on uncertain errors', () => {
  const originalError = new Error('SQL failed');
  const rollbackError = new Error('rollback failed');
  const progressError = new Error('progress failed');
  const mediaCleanupError = new Error('media cleanup failed');
  const frozen = new Error('transaction state uncertain');
  Object.assign(frozen, {
    transactionState: TRANSACTION_STATE.UNCERTAIN,
    originalError,
    rollbackError
  });
  Object.freeze(frozen);

  const preserved = preserveTransactionEvidence(frozen, { progressError, mediaCleanupError }, {
    message: `${frozen.message}; cleanup evidence retained`
  });
  assert.equal(preserved instanceof TransactionStateError, true);
  assert.equal(transactionStateOf(preserved), TRANSACTION_STATE.UNCERTAIN);
  assert.equal(preserved.originalError, originalError);
  assert.equal(preserved.rollbackError, rollbackError);
  assert.equal(preserved.progressError, progressError);
  assert.equal(preserved.mediaCleanupError, mediaCleanupError);
  assert.equal(preserved.cause, frozen);
  assert.match(preserved.message, /cleanup evidence retained/u);
});
