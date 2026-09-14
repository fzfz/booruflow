import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';

const ARTIST_PROMPT_STRING_ID = 805;

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-73-artist-prompt-string-media-${operation}-${++requestSequence}`;
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
  form.append('files', new Blob([fixtureBytes], { type: 'image/png' }), 'issue-73-artist-first.png');
  form.append('files', new Blob([fixtureBytes], { type: 'image/png' }), 'issue-73-artist-second.png');
  const requestId = `issue-73-artist-prompt-string-media-upload-${++requestSequence}`;
  const response = await fetch(`${app.baseUrl}/api/items/artist_prompt_string/${ARTIST_PROMPT_STRING_ID}/images`, {
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

function assertMediaSnapshot(result, expectedStatus, imageIds, coverMediaPath = null) {
  assertSuccessEnvelope(result, expectedStatus);
  const snapshot = result.body.data;
  assert.deepEqual(Object.keys(snapshot).sort(), ['cleanup_warning', 'cover_media_path', 'images', 'owner_id', 'owner_kind']);
  assert.equal(snapshot.owner_kind, 'artist_prompt_string');
  assert.equal(snapshot.owner_id, ARTIST_PROMPT_STRING_ID);
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

test('真实 HTTP 覆盖画师串图片 GET、POST、排序、封面和删图', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const initial = await requestJson(app, 'GET', `/api/items/artist_prompt_string/${ARTIST_PROMPT_STRING_ID}/images`, undefined, 'list-initial');
    const initialSnapshot = assertMediaSnapshot(initial, 200, []);
    await assertDisplayedMedia(app, initialSnapshot.images);

    const uploaded = await uploadMultipart(app);
    const uploadedSnapshot = assertMediaSnapshot(uploaded, 201, uploaded.body.data.images.map(({ id }) => id));
    const [firstUploadedImage, secondUploadedImage] = uploadedSnapshot.images;
    assert.notEqual(firstUploadedImage.id, secondUploadedImage.id);
    await assertDisplayedMedia(app, uploadedSnapshot.images);

    const reorderedIds = [secondUploadedImage.id, firstUploadedImage.id];
    const reordered = await requestJson(app, 'PUT', `/api/items/artist_prompt_string/${ARTIST_PROMPT_STRING_ID}/images/order`, { ids: reorderedIds }, 'reorder');
    const reorderedSnapshot = assertMediaSnapshot(reordered, 200, reorderedIds);

    const covered = await requestJson(app, 'PUT', `/api/items/artist_prompt_string/${ARTIST_PROMPT_STRING_ID}/cover`, { id: firstUploadedImage.id }, 'cover');
    const coveredSnapshot = assertMediaSnapshot(covered, 200, reorderedIds, firstUploadedImage.media_path);
    assert.equal(coveredSnapshot.images.find(({ id }) => id === firstUploadedImage.id)?.media_path, coveredSnapshot.cover_media_path);

    const deletedImage = await requestJson(app, 'DELETE', `/api/items/artist_prompt_string/${ARTIST_PROMPT_STRING_ID}/images/${secondUploadedImage.id}`, undefined, 'delete-image');
    const afterImageDelete = assertMediaSnapshot(deletedImage, 200, [firstUploadedImage.id], firstUploadedImage.media_path);
    await assertDisplayedMedia(app, afterImageDelete.images);
  } finally {
    await app.close();
  }
});
