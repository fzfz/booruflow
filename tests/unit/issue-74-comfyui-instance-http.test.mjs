import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { startTestApp } from '../../scripts/start-test-app.mjs';

const BASIC_USERNAME = 'issue74-basic-user';
const BASIC_PASSWORD = 'issue74-basic-password';
const BEARER_TOKEN = 'issue74-bearer-token';
const UPDATED_BEARER_TOKEN = 'issue74-updated-bearer-token';

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-74-${operation}-${++requestSequence}`;
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-request-id': requestId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json(), requestId });
}

function assertSuccessEnvelope(result, expectedStatus) {
  assert.equal(result.status, expectedStatus);
  assert.deepEqual(Object.keys(result.body).sort(), ['data', 'ok', 'request_id']);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.request_id, result.requestId);
}

function assertErrorEnvelope(result, expectedStatus, expectedCode) {
  assert.equal(result.status, expectedStatus);
  assert.deepEqual(Object.keys(result.body).sort(), ['error', 'ok', 'request_id']);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.request_id, result.requestId);
  assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'message']);
  assert.equal(result.body.error.code, expectedCode);
}

function assertNoCredentialLeak(result, secrets = []) {
  const serialized = JSON.stringify(result.body);
  assert.equal(Object.hasOwn(result.body.data, 'credential_ciphertext'), false);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `response leaked ${secret}`);
}

function assertInstanceState(result, { valid, enabled, credentialType }) {
  assert.equal(result.body.data.is_valid, valid);
  assert.equal(result.body.data.is_enabled, enabled);
  assert.equal(result.body.data.credential_type, credentialType);
}

function readInstance(database, id) {
  return database.prepare(`SELECT id, title, url, credential_type, credential_ciphertext,
    is_enabled, is_valid FROM comfyui_instances WHERE id = ?`).get(id);
}

async function startComfyuiProbe() {
  const requests = [];
  let responseStatus = 200;
  const server = createServer((request, response) => {
    requests.push(Object.freeze({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null }));
    response.writeHead(responseStatus, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(responseStatus === 200 ? { system: 'issue-74-test' } : { error: 'unavailable' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    setResponseStatus(status) { responseStatus = status; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  });
}

async function createInstance(app, write, operation) {
  const { secrets: _secrets, ...payload } = write;
  const result = await requestJson(app, 'POST', '/api/manage/comfyui-instances', payload, operation);
  assertSuccessEnvelope(result, 201);
  return result;
}

test('真实应用 HTTP 接受 none、HTTP Basic、Bearer 三种实例写入，并只保存凭据密文', { concurrency: false }, async () => {
  const probe = await startComfyuiProbe();
  const app = await startTestApp({ generationResourceFixture: true });
  const database = new DatabaseSync(app.paths.database);
  try {
    const writes = [
      {
        title: 'Issue 74 none',
        url: `${probe.baseUrl}/none`,
        credential: { type: 'none' },
        is_enabled: true,
        secrets: []
      },
      {
        title: 'Issue 74 basic',
        url: `${probe.baseUrl}/basic`,
        credential: { action: 'replace', type: 'http_basic', username: BASIC_USERNAME, password: BASIC_PASSWORD },
        is_enabled: true,
        secrets: [BASIC_USERNAME, BASIC_PASSWORD]
      },
      {
        title: 'Issue 74 bearer',
        url: `${probe.baseUrl}/bearer`,
        credential: { action: 'replace', type: 'bearer', token: BEARER_TOKEN },
        is_enabled: true,
        secrets: [BEARER_TOKEN]
      }
    ];

    for (const [index, write] of writes.entries()) {
      const result = await createInstance(app, write, `instance-create-${index}`);
      assertInstanceState(result, { valid: false, enabled: false, credentialType: write.credential.type });

      const row = readInstance(database, result.body.data.id);
      assertNoCredentialLeak(result, [...write.secrets, ...(row.credential_ciphertext === null ? [] : [row.credential_ciphertext])]);
      assert.equal(row.url, write.url);
      assert.equal(row.is_valid, 0);
      assert.equal(row.is_enabled, 0);
      if (write.credential.type === 'none') {
        assert.equal(row.credential_ciphertext, null);
      } else {
        assert.equal(typeof row.credential_ciphertext, 'string');
        for (const secret of write.secrets) {
          assert.notEqual(row.credential_ciphertext, secret);
          assert.equal(row.credential_ciphertext.includes(secret), false);
        }
      }
    }
  } finally {
    database.close();
    await app.close();
    await probe.close();
  }
});

test('真实应用 HTTP 允许无凭据实例在连接检测成功后启用且不发送认证信息', { concurrency: false }, async () => {
  const probe = await startComfyuiProbe();
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const created = await createInstance(app, {
      title: 'Issue 74 none enable',
      url: `${probe.baseUrl}/none-enable`,
      credential: { type: 'none' },
      is_enabled: false
    }, 'none-enable-create');
    const id = created.body.data.id;

    const validation = await requestJson(app, 'POST', `/api/manage/comfyui-instances/${id}/validate`, undefined, 'none-enable-validate');
    assertSuccessEnvelope(validation, 200);
    assertInstanceState(validation, { valid: true, enabled: false, credentialType: 'none' });
    assert.equal(probe.requests.at(-1).authorization, null);

    const enabled = await requestJson(app, 'PUT', `/api/manage/comfyui-instances/${id}`, {
      title: 'Issue 74 none enable',
      url: `${probe.baseUrl}/none-enable`,
      credential: { action: 'keep' },
      is_enabled: true
    }, 'none-enable-save');
    assertSuccessEnvelope(enabled, 200);
    assertInstanceState(enabled, { valid: true, enabled: true, credentialType: 'none' });
  } finally {
    await app.close();
    await probe.close();
  }
});

test('真实应用 HTTP 在连接检测成功或失败后维护实例状态，并使用 Basic/Bearer 认证', { concurrency: false }, async () => {
  const probe = await startComfyuiProbe();
  const app = await startTestApp({ generationResourceFixture: true });
  const database = new DatabaseSync(app.paths.database);
  try {
    const created = await createInstance(app, {
      title: 'Issue 74 validation',
      url: `${probe.baseUrl}/validation`,
      credential: { action: 'replace', type: 'http_basic', username: BASIC_USERNAME, password: BASIC_PASSWORD },
      is_enabled: false
    }, 'validation-create');
    const id = created.body.data.id;
    const basicCiphertext = readInstance(database, id).credential_ciphertext;
    assertNoCredentialLeak(created, [BASIC_USERNAME, BASIC_PASSWORD, basicCiphertext]);

    const basicValidation = await requestJson(app, 'POST', `/api/manage/comfyui-instances/${id}/validate`, undefined, 'validation-basic-success');
    assertSuccessEnvelope(basicValidation, 200);
    assertInstanceState(basicValidation, { valid: true, enabled: false, credentialType: 'http_basic' });
    assertNoCredentialLeak(basicValidation, [BASIC_USERNAME, BASIC_PASSWORD, basicCiphertext]);
    assert.equal(probe.requests.at(-1).authorization, `Basic ${Buffer.from(`${BASIC_USERNAME}:${BASIC_PASSWORD}`).toString('base64')}`);

    const enabled = await requestJson(app, 'PUT', `/api/manage/comfyui-instances/${id}`, {
      title: 'Issue 74 validation',
      url: `${probe.baseUrl}/validation`,
      credential: { action: 'keep' },
      is_enabled: true
    }, 'validation-enable');
    assertSuccessEnvelope(enabled, 200);
    assertInstanceState(enabled, { valid: true, enabled: true, credentialType: 'http_basic' });
    assertNoCredentialLeak(enabled, [BASIC_USERNAME, BASIC_PASSWORD, basicCiphertext]);

    const changedUrl = await requestJson(app, 'PUT', `/api/manage/comfyui-instances/${id}`, {
      title: 'Issue 74 validation',
      url: `${probe.baseUrl}/validation-changed`,
      credential: { action: 'keep' },
      is_enabled: true
    }, 'validation-url-change');
    assertSuccessEnvelope(changedUrl, 200);
    assertInstanceState(changedUrl, { valid: false, enabled: false, credentialType: 'http_basic' });
    assertNoCredentialLeak(changedUrl, [BASIC_USERNAME, BASIC_PASSWORD, basicCiphertext]);
    assert.equal(readInstance(database, id).credential_ciphertext, basicCiphertext);

    const changedCredential = await requestJson(app, 'PUT', `/api/manage/comfyui-instances/${id}`, {
      title: 'Issue 74 validation',
      url: `${probe.baseUrl}/validation-changed`,
      credential: { action: 'replace', type: 'bearer', token: UPDATED_BEARER_TOKEN },
      is_enabled: true
    }, 'validation-credential-change');
    assertSuccessEnvelope(changedCredential, 200);
    assertInstanceState(changedCredential, { valid: false, enabled: false, credentialType: 'bearer' });
    const bearerRow = readInstance(database, id);
    assertNoCredentialLeak(changedCredential, [BASIC_USERNAME, BASIC_PASSWORD, UPDATED_BEARER_TOKEN, bearerRow.credential_ciphertext]);
    assert.notEqual(bearerRow.credential_ciphertext, basicCiphertext);
    assert.notEqual(bearerRow.credential_ciphertext, UPDATED_BEARER_TOKEN);
    assert.equal(bearerRow.credential_ciphertext.includes(UPDATED_BEARER_TOKEN), false);

    const bearerValidation = await requestJson(app, 'POST', `/api/manage/comfyui-instances/${id}/validate`, undefined, 'validation-bearer-success');
    assertSuccessEnvelope(bearerValidation, 200);
    assertInstanceState(bearerValidation, { valid: true, enabled: false, credentialType: 'bearer' });
    assertNoCredentialLeak(bearerValidation, [UPDATED_BEARER_TOKEN, bearerRow.credential_ciphertext]);
    assert.equal(probe.requests.at(-1).authorization, `Bearer ${UPDATED_BEARER_TOKEN}`);

    const reenabled = await requestJson(app, 'PUT', `/api/manage/comfyui-instances/${id}`, {
      title: 'Issue 74 validation',
      url: `${probe.baseUrl}/validation-changed`,
      credential: { action: 'keep' },
      is_enabled: true
    }, 'validation-reenable');
    assertSuccessEnvelope(reenabled, 200);
    assertInstanceState(reenabled, { valid: true, enabled: true, credentialType: 'bearer' });

    probe.setResponseStatus(503);
    const failedValidation = await requestJson(app, 'POST', `/api/manage/comfyui-instances/${id}/validate`, undefined, 'validation-failure');
    assertSuccessEnvelope(failedValidation, 200);
    assertInstanceState(failedValidation, { valid: false, enabled: false, credentialType: 'bearer' });
    assertNoCredentialLeak(failedValidation, [UPDATED_BEARER_TOKEN, bearerRow.credential_ciphertext]);
    const retained = await requestJson(app, 'GET', `/api/manage/comfyui-instances/${id}`, undefined, 'validation-failure-retained');
    assertSuccessEnvelope(retained, 200);
    assertInstanceState(retained, { valid: false, enabled: false, credentialType: 'bearer' });
    assertNoCredentialLeak(retained, [UPDATED_BEARER_TOKEN, bearerRow.credential_ciphertext]);
  } finally {
    database.close();
    await app.close();
    await probe.close();
  }
});

test('真实应用 HTTP 返回 ComfyUI 实例分页，并通过 impact_token 删除且不影响资源目录', { concurrency: false }, async () => {
  const probe = await startComfyuiProbe();
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const first = await createInstance(app, {
      title: 'Issue 74 page one',
      url: `${probe.baseUrl}/page-one`,
      credential: { type: 'none' },
      is_enabled: false
    }, 'page-create-one');
    const second = await createInstance(app, {
      title: 'Issue 74 page two',
      url: `${probe.baseUrl}/page-two`,
      credential: { type: 'none' },
      is_enabled: false
    }, 'page-create-two');

    const pageOne = await requestJson(app, 'GET', '/api/manage/comfyui-instances?page=1&page_size=1', undefined, 'page-one');
    const pageTwo = await requestJson(app, 'GET', '/api/manage/comfyui-instances?page=2&page_size=1', undefined, 'page-two');
    assertSuccessEnvelope(pageOne, 200);
    assertSuccessEnvelope(pageTwo, 200);
    assert.deepEqual({
      page: pageOne.body.data.page,
      page_size: pageOne.body.data.page_size,
      total_count: pageOne.body.data.total_count
    }, { page: 1, page_size: 1, total_count: 2 });
    assert.deepEqual({
      page: pageTwo.body.data.page,
      page_size: pageTwo.body.data.page_size,
      total_count: pageTwo.body.data.total_count
    }, { page: 2, page_size: 1, total_count: 2 });
    assert.equal(pageOne.body.data.items.length, 1);
    assert.equal(pageTwo.body.data.items.length, 1);
    assert.notEqual(pageOne.body.data.items[0].id, pageTwo.body.data.items[0].id);
    assertNoCredentialLeak(pageOne);
    assertNoCredentialLeak(pageTwo);

    const impact = await requestJson(app, 'GET', `/api/manage/comfyui-instances/${first.body.data.id}/delete-impact`, undefined, 'delete-impact');
    assertSuccessEnvelope(impact, 200);
    assert.deepEqual(Object.keys(impact.body.data).sort(), ['cascade_deleted', 'impact_token', 'retained', 'target']);
    assert.equal(impact.body.data.target.id, first.body.data.id);
    assert.deepEqual(impact.body.data.cascade_deleted, []);
    assert.deepEqual(impact.body.data.retained, []);
    assert.equal(typeof impact.body.data.impact_token, 'string');
    assert.notEqual(impact.body.data.impact_token.length, 0);

    const missingToken = await requestJson(app, 'DELETE', `/api/manage/comfyui-instances/${first.body.data.id}`, undefined, 'delete-missing-token');
    assertErrorEnvelope(missingToken, 422, 'VALIDATION_ERROR');
    const wrongToken = await requestJson(app, 'DELETE', `/api/manage/comfyui-instances/${first.body.data.id}`, { impact_token: 'issue-74-wrong-impact-token' }, 'delete-wrong-token');
    assertErrorEnvelope(wrongToken, 409, 'DELETE_IMPACT_STALE');
    const deleted = await requestJson(app, 'DELETE', `/api/manage/comfyui-instances/${first.body.data.id}`, { impact_token: impact.body.data.impact_token }, 'delete-confirmed');
    assertSuccessEnvelope(deleted, 200);
    assert.equal(deleted.body.data.target.id, first.body.data.id);

    const missing = await requestJson(app, 'GET', `/api/manage/comfyui-instances/${first.body.data.id}`, undefined, 'get-after-delete');
    assertErrorEnvelope(missing, 404, 'NOT_FOUND');
    const remaining = await requestJson(app, 'GET', '/api/manage/comfyui-instances?page=1&page_size=20', undefined, 'list-after-delete');
    assertSuccessEnvelope(remaining, 200);
    assert.equal(remaining.body.data.total_count, 1);
    assert.equal(remaining.body.data.items[0].id, second.body.data.id);
  } finally {
    await app.close();
    await probe.close();
  }
});
