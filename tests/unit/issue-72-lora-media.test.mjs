import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { startTestApp } from '../../scripts/start-test-app.mjs';

const LORA_ID = 803;
const MODEL_ID = 802;
const TEMPLATE_ID = 804;
const INITIAL_LORA_IMAGE_ID = 807;
const TEMPLATE_IMAGE_ID = 808;
const MODEL_IMAGE_ID = 806;

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-72-lora-media-${operation}-${++requestSequence}`;
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

async function uploadMultipart(app) {
  const fixtureBytes = await readFile(app.uploadFixture);
  const form = new FormData();
  form.append('files', new Blob([fixtureBytes], { type: 'image/png' }), 'issue-72-lora-first.png');
  form.append('files', new Blob([fixtureBytes], { type: 'image/png' }), 'issue-72-lora-second.png');
  const requestId = `issue-72-lora-media-upload-${++requestSequence}`;
  const response = await fetch(`${app.baseUrl}/api/items/lora/${LORA_ID}/images`, {
    method: 'POST',
    headers: { accept: 'application/json', 'x-request-id': requestId },
    body: form
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

function assertMediaSnapshot(result, expectedStatus, imageIds, coverMediaPath = null) {
  assertSuccessEnvelope(result, expectedStatus);
  const snapshot = result.body.data;
  assert.deepEqual(Object.keys(snapshot).sort(), ['cleanup_warning', 'cover_media_path', 'images', 'owner_id', 'owner_kind']);
  assert.equal(snapshot.owner_kind, 'lora');
  assert.equal(snapshot.owner_id, LORA_ID);
  assert.equal(snapshot.cover_media_path, coverMediaPath);
  assert.equal(snapshot.cleanup_warning, false);
  assert.deepEqual(snapshot.images.map(({ id }) => id), imageIds);
  assert.deepEqual(snapshot.images.map(({ sort_order }) => sort_order), imageIds.map((_, index) => index));
  for (const image of snapshot.images) {
    assert.deepEqual(Object.keys(image).sort(), ['id', 'media_path', 'sort_order']);
    assert.match(image.media_path, /^images\//u);
  }
  return snapshot;
}

async function assertDisplayedMedia(app, images) {
  for (const image of images) {
    const response = await fetch(new URL(`/media/${image.media_path}`, app.baseUrl));
    assert.equal(response.status, 200, `media should be displayable: ${image.media_path}`);
    assert.match(response.headers.get('content-type') ?? '', /^image\/png(?:;|$)/u);
    assert.ok((await response.arrayBuffer()).byteLength > 0, `media should not be empty: ${image.media_path}`);
  }
}

test('真实 HTTP 覆盖 LoRA 图片上传、显示、排序、封面、删图和 LoRA 级联媒体删除', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const initial = await requestJson(app, 'GET', `/api/items/lora/${LORA_ID}/images`, undefined, 'list-initial');
    const initialSnapshot = assertMediaSnapshot(initial, 200, [INITIAL_LORA_IMAGE_ID]);
    await assertDisplayedMedia(app, initialSnapshot.images);

    const uploaded = await uploadMultipart(app);
    const uploadedSnapshot = assertMediaSnapshot(uploaded, 201, [INITIAL_LORA_IMAGE_ID, ...uploaded.body.data.images.slice(1).map(({ id }) => id)]);
    const [initialImage, firstUploadedImage, secondUploadedImage] = uploadedSnapshot.images;
    assert.equal(initialImage.id, INITIAL_LORA_IMAGE_ID);
    assert.notEqual(firstUploadedImage.id, secondUploadedImage.id);
    await assertDisplayedMedia(app, uploadedSnapshot.images);

    const reorderedIds = [secondUploadedImage.id, initialImage.id, firstUploadedImage.id];
    const reordered = await requestJson(app, 'PUT', `/api/items/lora/${LORA_ID}/images/order`, { ids: reorderedIds }, 'reorder');
    const reorderedSnapshot = assertMediaSnapshot(reordered, 200, reorderedIds);

    const covered = await requestJson(app, 'PUT', `/api/items/lora/${LORA_ID}/cover`, { id: firstUploadedImage.id }, 'cover');
    const coveredSnapshot = assertMediaSnapshot(covered, 200, reorderedIds, firstUploadedImage.media_path);
    assert.equal(coveredSnapshot.images.find(({ id }) => id === firstUploadedImage.id)?.media_path, coveredSnapshot.cover_media_path);

    const deletedImage = await requestJson(app, 'DELETE', `/api/items/lora/${LORA_ID}/images/${secondUploadedImage.id}`, undefined, 'delete-image');
    const afterImageDelete = assertMediaSnapshot(deletedImage, 200, [initialImage.id, firstUploadedImage.id], firstUploadedImage.media_path);
    await assertDisplayedMedia(app, afterImageDelete.images);

    const impact = await requestJson(app, 'GET', `/api/manage/loras/${LORA_ID}/delete-impact`, undefined, 'delete-impact');
    assertSuccessEnvelope(impact, 200);
    assert.equal(impact.body.data.target.id, LORA_ID);
    assert.deepEqual(impact.body.data.cascade_deleted.filter(({ kind }) => kind === 'template').map(({ id }) => id), [TEMPLATE_ID]);
    assert.deepEqual(impact.body.data.cascade_deleted.filter(({ kind, owner_kind: ownerKind, owner_id: ownerId }) => kind === 'image' && ownerKind === 'lora' && ownerId === LORA_ID).map(({ id }) => id).sort((left, right) => left - right), [INITIAL_LORA_IMAGE_ID, firstUploadedImage.id].sort((left, right) => left - right));
    assert.deepEqual(impact.body.data.cascade_deleted.filter(({ kind, owner_kind: ownerKind, owner_id: ownerId }) => kind === 'image' && ownerKind === 'template' && ownerId === TEMPLATE_ID).map(({ id }) => id), [TEMPLATE_IMAGE_ID]);

    const deletedLora = await requestJson(app, 'DELETE', `/api/manage/loras/${LORA_ID}`, { impact_token: impact.body.data.impact_token }, 'delete-lora');
    assertSuccessEnvelope(deletedLora, 200);
    assert.equal(deletedLora.body.data.target.id, LORA_ID);

    const missingLora = await requestJson(app, 'GET', `/api/items/lora/${LORA_ID}/images`, undefined, 'list-after-delete');
    assertErrorEnvelope(missingLora, 404, 'NOT_FOUND');

    const database = new DatabaseSync(app.paths.database);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = ?').get(LORA_ID).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = ?').get(TEMPLATE_ID).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = \'lora\' AND owner_id = ?').get(LORA_ID).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = \'template\' AND owner_id = ?').get(TEMPLATE_ID).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = \'model\' AND owner_id = ?').get(MODEL_ID).count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = ?').get(MODEL_IMAGE_ID).count, 1);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
  }
});
