import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CatalogTransactionError,
  inTransaction,
  databaseConnectionHasUncertainTransaction,
  databaseConnectionIsUsable
} from '../../app/catalog/database.mjs';
import { REPOSITORY_ROOT } from '../../app/contracts/authoritative-contracts.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';
import { InputValidationError } from '../../app/security/input-validation.mjs';
import {
  TRANSACTION_STATE,
  hasTransactionState,
  markTransactionState,
  transactionStateOf
} from '../../app/transaction-state.mjs';

function fakeDatabase({ beginError = null, commitError = null, rollbackError = null } = {}) {
  const statements = [];
  return {
    statements,
    exec(statement) {
      statements.push(statement);
      if (statement === 'BEGIN IMMEDIATE;' && beginError) throw beginError;
      if (statement === 'COMMIT;' && commitError) throw commitError;
      if (statement === 'ROLLBACK;' && rollbackError) throw rollbackError;
    }
  };
}

test('Issue #276 uncertain transaction preserves the original uncertain fact and disables the connection', () => {
  const database = fakeDatabase({
    commitError: new Error('commit result unavailable'),
    rollbackError: new Error('rollback result unavailable')
  });

  assert.throws(() => inTransaction(database, () => {}), (error) => {
    assert.equal(error instanceof CatalogTransactionError, true);
    assert.equal(transactionStateOf(error), TRANSACTION_STATE.UNCERTAIN);
    assert.equal(hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN), true);
    return true;
  });
  assert.equal(databaseConnectionHasUncertainTransaction(database), true);
  assert.equal(databaseConnectionIsUsable(database), false);

  const statementsBeforeRetry = [...database.statements];
  assert.throws(() => inTransaction(database, () => {}), /connection is not serviceable/u);
  assert.deepEqual(database.statements, statementsBeforeRetry);
});

test('Issue #276 error mapping gives uncertain transaction priority over application, validation, and busy errors', () => {
  const mapper = createErrorMapper(REPOSITORY_ROOT);
  const cases = [
    markTransactionState(new ApplicationError('SQLITE_BUSY', 'database is busy'), TRANSACTION_STATE.UNCERTAIN),
    markTransactionState(new InputValidationError('invalid write'), TRANSACTION_STATE.UNCERTAIN),
    markTransactionState(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }), TRANSACTION_STATE.UNCERTAIN)
  ];

  for (const error of cases) {
    const response = mapper.toResponse('createLora', error, 'request-uncertain');
    assert.equal(response.status, 500);
    assert.deepEqual(response.body.error, { code: 'INTERNAL_ERROR', message: 'internal service error' });
  }
});

test('Issue #276 error mapping recognizes the canonical structured transaction evidence', () => {
  const mapper = createErrorMapper(REPOSITORY_ROOT);
  const error = {
    code: 'SQLITE_BUSY',
    message: 'database is locked',
    evidence: { transaction_state: TRANSACTION_STATE.UNCERTAIN }
  };

  assert.equal(hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN), true);
  assert.equal(transactionStateOf(error), TRANSACTION_STATE.UNCERTAIN);
  const response = mapper.toResponse('createLora', error, 'request-structured-uncertain');
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'INTERNAL_ERROR');
});

test('Issue #276 normal not-started, rolled-back, and busy errors keep a connection serviceable', () => {
  const beginError = new Error('begin failed');
  const notStarted = fakeDatabase({ beginError });
  assert.throws(() => inTransaction(notStarted, () => {}), /begin failed/u);
  assert.equal(transactionStateOf(beginError), TRANSACTION_STATE.NOT_STARTED);
  assert.equal(databaseConnectionIsUsable(notStarted), true);

  const callbackError = new Error('business conflict');
  const rolledBack = fakeDatabase();
  assert.throws(() => inTransaction(rolledBack, () => { throw callbackError; }), /business conflict/u);
  assert.equal(transactionStateOf(callbackError), TRANSACTION_STATE.ROLLED_BACK);
  assert.equal(databaseConnectionIsUsable(rolledBack), true);

  const busyError = new Error('database is busy');
  busyError.code = 'SQLITE_BUSY';
  const busy = fakeDatabase();
  assert.throws(() => inTransaction(busy, () => { throw busyError; }), /database is busy/u);
  assert.equal(databaseConnectionIsUsable(busy), true);
  assert.equal(databaseConnectionHasUncertainTransaction(busy), false);
});
