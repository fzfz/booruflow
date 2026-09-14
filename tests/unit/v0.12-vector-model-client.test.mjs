import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createConfiguredVectorModelClient, loadVectorModelConfiguration } from '../../app/vector/model-client.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

function temporaryRepository() {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'noobai-vector-model-client-'));
  mkdirSync(join(repositoryRoot, 'config/vector'), { recursive: true });
  writeFileSync(join(repositoryRoot, 'config/vector/models.json'), JSON.stringify({
    embedding: {
      base_url: '$NOOBAI_EMBEDDING_BASE_URL', api_key: '$NOOBAI_EMBEDDING_API_KEY', model: '$NOOBAI_EMBEDDING_MODEL'
    },
    reranker: {
      base_url: '$NOOBAI_RERANKER_BASE_URL', api_key: '$NOOBAI_RERANKER_API_KEY', model: '$NOOBAI_RERANKER_MODEL'
    },
    request_timeout_ms: 20000,
    embedding_batch_size: 64,
    embedding_batch_concurrency: 2,
    reranker_candidate_limit: 20,
    reranker_min_relevance_score: 0.01
  }));
  return repositoryRoot;
}

const modelEnvironment = Object.freeze({
  NOOBAI_EMBEDDING_BASE_URL: 'http://embedding.invalid/v1/',
  NOOBAI_EMBEDDING_API_KEY: 'embedding-test-key',
  NOOBAI_EMBEDDING_MODEL: 'fake-embedding',
  NOOBAI_RERANKER_BASE_URL: 'http://reranker.invalid/v1',
  NOOBAI_RERANKER_API_KEY: 'reranker-test-key',
  NOOBAI_RERANKER_MODEL: 'fake-reranker'
});

test('vector model configuration requires the published batching field and each model HTTP request uses its own endpoint, credential, and timeout', async () => {
  const repositoryRoot = temporaryRepository();
  const originalTimeout = AbortSignal.timeout;
  const timeoutCalls = [];
  try {
    const configuration = loadVectorModelConfiguration(repositoryRoot, { environment: modelEnvironment });
    assert.deepEqual(
      { embedding_batch_size: configuration.embedding_batch_size, embedding_batch_concurrency: configuration.embedding_batch_concurrency },
      { embedding_batch_size: 64, embedding_batch_concurrency: 2 }
    );
    assert.equal(configuration.embedding_model, 'fake-embedding');
    assert.equal(configuration.reranker_model, 'fake-reranker');
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      writable: true,
      value(milliseconds) { timeoutCalls.push(milliseconds); return originalTimeout(milliseconds); }
    });
    const requests = [];
    const client = createConfiguredVectorModelClient({
      repositoryRoot,
      configuration,
      fetchImplementation: async (url, request) => {
        requests.push({ url, request });
        return ({
        ok: true,
        status: 200,
        async json() {
          return url.includes('/embeddings')
            ? { data: [{ index: 0, embedding: createFixtureVector() }] }
            : { results: [] };
        }
      });
      }
    });
    await client.embed(['first batch']);
    await client.rerank('query', ['candidate']);
    assert.deepEqual(timeoutCalls, [20000, 20000]);
    assert.deepEqual(
      requests.map(({ url, request }) => ({ url, authorization: request.headers.authorization, model: JSON.parse(request.body).model })),
      [
        { url: 'http://embedding.invalid/v1/embeddings', authorization: 'Bearer embedding-test-key', model: 'fake-embedding' },
        { url: 'http://reranker.invalid/v1/rerank', authorization: 'Bearer reranker-test-key', model: 'fake-reranker' }
      ]
    );
    writeFileSync(join(repositoryRoot, 'config/vector/models.json'), JSON.stringify({
      embedding: {}, reranker: {}, request_timeout_ms: 20000, embedding_batch_size: 64, reranker_candidate_limit: 20, reranker_min_relevance_score: 0.01
    }));
    assert.throws(() => loadVectorModelConfiguration(repositoryRoot, { environment: modelEnvironment }), /exactly the published vector model fields/u);
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, writable: true, value: originalTimeout });
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
