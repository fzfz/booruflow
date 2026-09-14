import assert from 'node:assert/strict';
import test from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { startTestApp } from '../../scripts/start-test-app.mjs';
import { createFixtureVector, FIXTURE_VECTOR_DIMENSION } from '../fixtures/vector/fake-semantic-model-client.mjs';

const GENERATION_RESOURCE_KINDS = Object.freeze(['artist_prompt_string', 'generation_lora']);
const FIXTURE_VECTOR = createFixtureVector();

function readGenerationResourceVectorState(databasePath, mediaRoot) {
  const database = openCatalogDatabase({ databasePath, mediaRoot });
  try {
    return Object.freeze({
      spaces: database.prepare(`SELECT object_kind, embedding_model, dimension
        FROM vector_spaces WHERE object_kind IN (?, ?) ORDER BY object_kind`)
        .all(...GENERATION_RESOURCE_KINDS)
        .map((row) => ({ ...row })),
      entries: database.prepare(`SELECT object_kind, object_id, embedding_f32
        FROM vector_entries WHERE object_kind IN (?, ?) ORDER BY object_kind, object_id`)
        .all(...GENERATION_RESOURCE_KINDS)
        .map(({ object_kind, object_id, embedding_f32 }) => {
          const bytes = Buffer.from(embedding_f32);
          const vector = new Float32Array(Uint8Array.from(bytes).buffer);
          return { object_kind, object_id, bytes: bytes.byteLength, vector: [...vector] };
        })
    });
  } finally {
    database.close();
  }
}

const EXPECTED_STATE = Object.freeze({
  spaces: [
    { object_kind: 'artist_prompt_string', embedding_model: 'fixture-embedding', dimension: FIXTURE_VECTOR_DIMENSION },
    { object_kind: 'generation_lora', embedding_model: 'fixture-embedding', dimension: FIXTURE_VECTOR_DIMENSION }
  ],
  entries: [
    { object_kind: 'artist_prompt_string', object_id: 805, bytes: FIXTURE_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT, vector: FIXTURE_VECTOR },
    { object_kind: 'generation_lora', object_id: 803, bytes: FIXTURE_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT, vector: FIXTURE_VECTOR }
  ]
});

test('Issue #275 start-test-app generation resource fixture converges before reopen and reset', { concurrency: false }, async () => {
  const fixture = await startTestApp({
    testMode: true,
    generationResourceFixture: true,
    applicationStarter: async () => Object.freeze({ close: async () => {} })
  });
  try {
    assert.deepEqual(readGenerationResourceVectorState(fixture.paths.database, fixture.paths.media), EXPECTED_STATE);

    const resetResult = await fixture.reset();
    assert.deepEqual(resetResult, { status: 200, body: { reset: true } });
    assert.deepEqual(readGenerationResourceVectorState(fixture.paths.database, fixture.paths.media), EXPECTED_STATE);
  } finally {
    await fixture.close();
  }
});

test('Issue #275 start-test-app leaves empty generation resource spaces unconfigured', { concurrency: false }, async () => {
  const fixture = await startTestApp({
    semanticFixtures: true,
    applicationStarter: async () => Object.freeze({ close: async () => {} })
  });
  try {
    assert.deepEqual(readGenerationResourceVectorState(fixture.paths.database, fixture.paths.media), {
      spaces: [
        { object_kind: 'artist_prompt_string', embedding_model: '__unconfigured__', dimension: 1 },
        { object_kind: 'generation_lora', embedding_model: '__unconfigured__', dimension: 1 }
      ],
      entries: []
    });
  } finally {
    await fixture.close();
  }
});
