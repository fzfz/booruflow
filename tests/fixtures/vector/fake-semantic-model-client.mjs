import { ApplicationError } from '../../../app/security/error-mapping.mjs';

export const FIXTURE_VECTOR_DIMENSION = 1024;

export function createFixtureVector(first = 1, second = 0) {
  const vector = new Array(FIXTURE_VECTOR_DIMENSION).fill(0);
  vector[0] = first;
  vector[1] = second;
  return vector;
}

export const FAKE_VECTOR_CONFIGURATION = Object.freeze({
  embedding_model: 'fixture-embedding',
  reranker_model: 'fixture-reranker',
  embedding_batch_size: 64,
  embedding_batch_concurrency: 2,
  reranker_candidate_limit: 32,
  reranker_min_relevance_score: 0.006
});

export function createFakeSemanticModelClient() {
  return Object.freeze({
    async embed(inputs) {
      if (inputs.includes('unavailable')) throw new ApplicationError('EMBEDDING_UNAVAILABLE', 'EMBEDDING_UNAVAILABLE fixture');
      if (inputs.includes('timeout')) throw new ApplicationError('EMBEDDING_TIMEOUT', 'EMBEDDING_TIMEOUT fixture');
      return inputs.map((input) => input === 'empty' ? createFixtureVector(0, 1) : createFixtureVector());
    },
    async rerank(query, documents) {
      if (query === 'empty') return documents.map((_, index) => ({ index, relevance_score: 0 }));
      return documents.map((_, index) => ({ index: documents.length - index - 1, relevance_score: documents.length - index }));
    }
  });
}
