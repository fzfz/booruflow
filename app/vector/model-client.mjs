import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveVectorModelsConfiguration } from '../config/model-runtime.mjs';
import { ApplicationError } from '../security/error-mapping.mjs';

const REQUIRED_MODEL_KEYS = Object.freeze(['embedding', 'reranker', 'request_timeout_ms', 'embedding_batch_size', 'embedding_batch_concurrency', 'reranker_candidate_limit', 'reranker_min_relevance_score']);

function readJson(path, label) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} is unreadable or invalid JSON`); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`);
  return value;
}

export function loadVectorModelConfiguration(repositoryRoot, { environment = process.env } = {}) {
  const path = resolve(repositoryRoot, 'config/vector/models.json');
  const value = readJson(path, 'config/vector/models.json');
  if (Object.keys(value).length !== REQUIRED_MODEL_KEYS.length || REQUIRED_MODEL_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('config/vector/models.json must contain exactly the published vector model fields');
  }
  for (const key of ['request_timeout_ms', 'embedding_batch_size', 'embedding_batch_concurrency', 'reranker_candidate_limit']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new Error(`config/vector/models.json ${key} must be a positive integer`);
  }
  if (typeof value.reranker_min_relevance_score !== 'number' || !Number.isFinite(value.reranker_min_relevance_score)) {
    throw new Error('config/vector/models.json reranker_min_relevance_score must be finite');
  }
  const runtime = resolveVectorModelsConfiguration(value, environment);
  return Object.freeze({
    ...value,
    embedding_model: runtime.embedding.model,
    reranker_model: runtime.reranker.model,
    embedding: runtime.embedding,
    reranker: runtime.reranker
  });
}

function modelError(kind, error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new ApplicationError(`${kind}_TIMEOUT`, `${kind.toLowerCase()} request timed out`);
  return new ApplicationError(`${kind}_UNAVAILABLE`, `${kind.toLowerCase()} service is unavailable`);
}

function responseError(kind, status) {
  if (status === 429) return new ApplicationError('MODEL_RATE_LIMITED', 'model service rate limited the request');
  if (status >= 500) return new ApplicationError(`${kind}_UNAVAILABLE`, `${kind.toLowerCase()} service is unavailable`);
  return new ApplicationError('MODEL_PROTOCOL_ERROR', `${kind.toLowerCase()} service rejected the request`);
}

export function createConfiguredVectorModelClient({ repositoryRoot, configuration = loadVectorModelConfiguration(repositoryRoot), fetchImplementation = fetch }) {
  if (typeof fetchImplementation !== 'function') throw new TypeError('fetchImplementation must be a function');
  async function post(kind, service, path, body) {
    let response;
    try {
      response = await fetchImplementation(`${service.base_url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${service.api_key}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(configuration.request_timeout_ms)
      });
    } catch (error) { throw modelError(kind, error); }
    if (!response || !Number.isInteger(response.status)) throw new ApplicationError('MODEL_PROTOCOL_ERROR', `${kind.toLowerCase()} response is invalid`);
    if (!response.ok) throw responseError(kind, response.status);
    try { return await response.json(); }
    catch { throw new ApplicationError('MODEL_PROTOCOL_ERROR', `${kind.toLowerCase()} response is not JSON`); }
  }
  return Object.freeze({
    async embed(inputs) {
      const response = await post('EMBEDDING', configuration.embedding, '/embeddings', { model: configuration.embedding_model, input: inputs });
      if (!Array.isArray(response?.data)) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'embedding response data is invalid');
      const entries = [...response.data].sort((left, right) => left.index - right.index);
      if (entries.length !== inputs.length || entries.some((entry, index) => entry?.index !== index || !Array.isArray(entry.embedding))) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'embedding response indexes are invalid');
      return entries.map((entry) => entry.embedding);
    },
    async rerank(query, documents) {
      const response = await post('RERANKER', configuration.reranker, '/rerank', { model: configuration.reranker_model, query, documents });
      if (!Array.isArray(response?.results)) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'reranker response results are invalid');
      return response.results;
    }
  });
}
