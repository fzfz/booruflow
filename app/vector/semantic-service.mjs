import { ApplicationError } from '../security/error-mapping.mjs';
import { assertSearchQuery, InputValidationError, validateSemanticQueryRequest } from '../security/input-validation.mjs';
import { embedProjection, readVectorSpace, searchVectorEntries, UNCONFIGURED_EMBEDDING_MODEL, VECTOR_DIMENSION } from './vector-store.mjs';

function validateRequest(request, requestValidator) {
  try { return requestValidator(request); }
  catch (error) {
    if (error instanceof InputValidationError) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', error.message);
    throw error;
  }
}

function modelFailure(error) {
  if (error instanceof ApplicationError) return error;
  if (error?.code) return new ApplicationError(error.code, error.message ?? String(error.code));
  return new ApplicationError('MODEL_PROTOCOL_ERROR', 'vector model response is invalid');
}

function catalogModelFailure(error) {
  if (error instanceof ApplicationError) {
    if (error.code === 'CATALOG_DEPENDENCY_UNAVAILABLE' || error.code === 'CATALOG_DEPENDENCY_TIMEOUT' || error.code === 'CATALOG_INDEX_NOT_READY') return error;
    if (error.code === 'EMBEDDING_TIMEOUT' || error.code === 'RERANKER_TIMEOUT') {
      return new ApplicationError('CATALOG_DEPENDENCY_TIMEOUT', 'catalog model dependency timed out');
    }
    if (error.code === 'EMBEDDING_UNAVAILABLE' || error.code === 'RERANKER_UNAVAILABLE'
      || error.code === 'MODEL_RATE_LIMITED' || error.code === 'MODEL_PROTOCOL_ERROR') {
      return new ApplicationError('CATALOG_DEPENDENCY_UNAVAILABLE', 'catalog model dependency is unavailable');
    }
    return error;
  }
  return new ApplicationError('CATALOG_DEPENDENCY_UNAVAILABLE', 'catalog model dependency is unavailable');
}

function validateRerankResults(results, candidateCount) {
  if (!Array.isArray(results) || results.length !== candidateCount) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'reranker response count differs from the candidates');
  const seen = new Set();
  for (const entry of results) {
    if (!entry || !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= candidateCount || seen.has(entry.index)
      || typeof entry.relevance_score !== 'number' || !Number.isFinite(entry.relevance_score)) {
      throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'reranker response is invalid');
    }
    seen.add(entry.index);
  }
  return results;
}

export function cosineScoreFromDistance(distance) {
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) {
    throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'vector KNN distance is invalid');
  }
  return 1 - (distance * distance) / 2;
}

function validateKnnEntries(entries, objectKind) {
  if (!Array.isArray(entries)) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector KNN reader returned an invalid result`);
  return entries.map((entry) => {
    if (!entry || !Number.isSafeInteger(entry.object_id) || entry.object_id < 1) {
      throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector KNN reader returned an invalid object ID`);
    }
    return Object.freeze({ object_id: entry.object_id, vector_score: cosineScoreFromDistance(entry.distance) });
  });
}

function validateCandidateEntries(entries, objectKind, limit) {
  if (!Array.isArray(entries)) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} candidate augmenter returned an invalid result`);
  if (entries.length > limit) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} candidate augmenter exceeded the candidate limit`);
  const seen = new Set();
  const candidates = [];
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.object_id) || entry.object_id < 1 || typeof entry.vector_score !== 'number'
      || !Number.isFinite(entry.vector_score)) {
      throw new ApplicationError('INTERNAL_ERROR', `${objectKind} candidate augmenter returned an invalid candidate`);
    }
    if (seen.has(entry.object_id)) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} candidate augmenter returned a duplicate candidate`);
    seen.add(entry.object_id);
    candidates.push(Object.freeze({ object_id: entry.object_id, vector_score: entry.vector_score }));
  }
  return candidates.slice(0, limit);
}

export function createSemanticService({
  database,
  objectKind,
  modelClient,
  configuration,
  loadRows,
  projectText,
  projectPublic,
  projectAgent = null,
  projectCatalog = null,
  compareCatalog = null,
  beforeLoad = null,
  candidatePriority = null,
  ensureCandidate = null,
  searchVectors = searchVectorEntries,
  requestValidator = validateSemanticQueryRequest,
  unconfiguredErrorCode = 'VECTOR_INDEX_NOT_READY'
}) {
  if (!modelClient || typeof modelClient.embed !== 'function' || typeof modelClient.rerank !== 'function') throw new TypeError('modelClient must expose embed and rerank');
  if (typeof configuration?.embedding_model !== 'string' || configuration.embedding_model.length === 0) throw new TypeError('configuration.embedding_model is required');
  if (!Number.isSafeInteger(configuration?.reranker_candidate_limit) || configuration.reranker_candidate_limit < 1) throw new TypeError('configuration.reranker_candidate_limit is required');
  if (typeof configuration.reranker_min_relevance_score !== 'number' || !Number.isFinite(configuration.reranker_min_relevance_score)) throw new TypeError('configuration.reranker_min_relevance_score is required');
  if (candidatePriority !== null && typeof candidatePriority !== 'function') throw new TypeError('candidatePriority must be a function');
  if (ensureCandidate !== null && typeof ensureCandidate !== 'function') throw new TypeError('ensureCandidate must be a function');
  if (typeof searchVectors !== 'function') throw new TypeError('searchVectors must be a function');
  if (projectCatalog !== null && typeof projectCatalog !== 'function') throw new TypeError('projectCatalog must be a function');
  if (compareCatalog !== null && typeof compareCatalog !== 'function') throw new TypeError('compareCatalog must be a function');

  async function query(rawQuery, limit, options = {}) {
    let query;
    try { query = assertSearchQuery(rawQuery); }
    catch (error) {
      if (error instanceof InputValidationError) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', error.message);
      throw error;
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', 'limit must be an integer from 1 to 20');
    let queryOptions = options;
    try { queryOptions = typeof beforeLoad === 'function' ? (beforeLoad(options) ?? options) : options; }
    catch (error) {
      if (error instanceof InputValidationError) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', error.message);
      throw error;
    }
    const space = readVectorSpace(database, objectKind);
    if (space.embedding_model === UNCONFIGURED_EMBEDDING_MODEL) throw new ApplicationError(unconfiguredErrorCode, `${objectKind} vector index is not ready`);
    if (space.embedding_model !== configuration.embedding_model) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector space uses a different embedding model`);
    if (space.dimension !== VECTOR_DIMENSION) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector space dimension must be exactly 1024`);
    let queryVector;
    try {
      queryVector = await embedProjection(modelClient, query);
    } catch (error) { throw modelFailure(error); }

    const vectorCandidates = validateKnnEntries(
      searchVectors(database, objectKind, queryVector, configuration.reranker_candidate_limit, queryOptions),
      objectKind
    ).filter(({ vector_score: vectorScore }) => vectorScore > 0);
    const candidatesWithExact = ensureCandidate === null ? vectorCandidates : validateCandidateEntries(
      ensureCandidate({
        object_kind: objectKind,
        query,
        query_vector: queryVector,
        entries: vectorCandidates,
        options: queryOptions,
        candidate_limit: configuration.reranker_candidate_limit
      }),
      objectKind,
      configuration.reranker_candidate_limit
    );
    if (candidatesWithExact.length === 0) return Object.freeze([]);
    const rows = loadRows(candidatesWithExact.map(({ object_id: objectId }) => objectId), queryOptions);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const candidates = candidatesWithExact.map((candidate) => {
      const row = byId.get(candidate.object_id);
      return row === undefined ? null : {
        ...row,
        vector_score: candidate.vector_score,
        candidate_priority: candidatePriority?.(row, query) ? 1 : 0
      };
    }).filter((row) => row !== null);
    if (candidates.length === 0) return Object.freeze([]);
    candidates.sort((left, right) => right.candidate_priority - left.candidate_priority || right.vector_score - left.vector_score || left.id - right.id);
    let reranked;
    try { reranked = validateRerankResults(await modelClient.rerank(query, candidates.map(projectText)), candidates.length); }
    catch (error) { throw modelFailure(error); }
    return Object.freeze([...reranked]
      .sort((left, right) => right.relevance_score - left.relevance_score || left.index - right.index)
      .filter((entry) => entry.relevance_score >= configuration.reranker_min_relevance_score)
      .slice(0, limit)
      .map((entry, index) => {
        const row = candidates[entry.index];
        if (queryOptions.agent && typeof projectAgent === 'function') return projectAgent(row);
        return projectPublic(row, { rank: index + 1, vector_score: row.vector_score, reranker_score: entry.relevance_score });
      }));
  }

  async function searchCatalog({ query: rawQuery, page = 1, page_size: pageSize = 20, ...searchOptions } = {}) {
    if (projectCatalog === null) throw new ApplicationError('CATALOG_INDEX_NOT_READY', `${objectKind} Catalog projection is not ready`);
    let query = rawQuery;
    if (typeof query !== 'string' || query.length === 0) throw new ApplicationError('CATALOG_REQUEST_INVALID', 'catalog query must be non-empty');
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', 'catalog pagination is invalid');
    }

    let queryOptions = searchOptions;
    try {
      queryOptions = typeof beforeLoad === 'function'
        ? (beforeLoad({ ...searchOptions, catalog: true }) ?? searchOptions)
        : searchOptions;
    }
    catch (error) {
      if (error instanceof InputValidationError) throw new ApplicationError('CATALOG_REQUEST_INVALID', error.message);
      throw error;
    }

    let space;
    try { space = readVectorSpace(database, objectKind); }
    catch (error) {
      if (error instanceof ApplicationError && error.code === 'INTERNAL_ERROR') {
        throw new ApplicationError('CATALOG_INDEX_NOT_READY', 'catalog semantic index is not ready');
      }
      throw error;
    }
    if (space.embedding_model === UNCONFIGURED_EMBEDDING_MODEL) {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', 'catalog semantic index is not ready');
    }
    if (space.embedding_model !== configuration.embedding_model) {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', 'catalog semantic index is not ready');
    }
    if (space.dimension !== VECTOR_DIMENSION) {
      throw new ApplicationError('CATALOG_INDEX_NOT_READY', 'catalog semantic index is not ready');
    }

    let queryVector;
    try {
      queryVector = await embedProjection(modelClient, query);
    } catch (error) {
      throw catalogModelFailure(error);
    }

    const entries = validateKnnEntries(
      searchVectors(database, objectKind, queryVector, configuration.reranker_candidate_limit, queryOptions),
      objectKind
    ).filter(({ vector_score: vectorScore }) => vectorScore > 0);
    const candidatesWithExact = ensureCandidate === null ? entries : validateCandidateEntries(
      ensureCandidate({
        object_kind: objectKind,
        query,
        query_vector: queryVector,
        entries,
        options: queryOptions,
        candidate_limit: configuration.reranker_candidate_limit
      }),
      objectKind,
      configuration.reranker_candidate_limit
    );
    const rows = candidatesWithExact.length === 0 ? [] : loadRows(candidatesWithExact.map(({ object_id: objectId }) => objectId), queryOptions);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const scoredEntries = candidatesWithExact
      .filter(({ object_id: objectId }) => byId.has(objectId))
      .map((entry) => ({ ...entry, candidate_priority: candidatePriority?.(byId.get(entry.object_id), query) ? 1 : 0 }))
      .sort((left, right) => right.candidate_priority - left.candidate_priority || right.vector_score - left.vector_score || left.object_id - right.object_id);
    if (scoredEntries.length === 0) return Object.freeze({ rows: Object.freeze([]), total_count: 0 });

    const candidates = scoredEntries
      .map(({ object_id, vector_score }) => {
        const row = byId.get(object_id);
        return row === undefined ? null : { row, vector_score };
      })
      .filter((candidate) => candidate !== null)
      .slice(0, configuration.reranker_candidate_limit);
    if (candidates.length === 0) return Object.freeze({ rows: Object.freeze([]), total_count: 0 });

    let reranked;
    try {
      reranked = validateRerankResults(await modelClient.rerank(query, candidates.map(({ row }) => projectText(row))), candidates.length);
    } catch (error) {
      throw catalogModelFailure(error);
    }
    const ranked = [...reranked]
      .filter((entry) => entry.relevance_score >= configuration.reranker_min_relevance_score)
      .sort((left, right) => {
        const relevance = right.relevance_score - left.relevance_score;
        if (relevance !== 0) return relevance;
        const leftRow = candidates[left.index].row;
        const rightRow = candidates[right.index].row;
        const tie = compareCatalog === null ? 0 : compareCatalog(leftRow, rightRow);
        return tie || leftRow.id - rightRow.id;
      });
    const offset = (page - 1) * pageSize;
    const projected = ranked.slice(offset, offset + pageSize).map(({ index }) => projectCatalog(candidates[index].row));
    return Object.freeze({ rows: Object.freeze(projected), total_count: ranked.length });
  }

  return Object.freeze({
    async searchPublic({ q, limit = 20, ...options }) { return Object.freeze({ items: await query(q, limit, options) }); },
    searchCatalog,
    async searchSkill(request) {
      const { limit, queries, ...requestOptions } = validateRequest(request, requestValidator);
      const groups = [];
      for (const requestedQuery of queries) groups.push(Object.freeze({ query: requestedQuery, items: await query(requestedQuery, limit, requestOptions) }));
      return Object.freeze({ groups: Object.freeze(groups) });
    },
    async searchSkillForAgent(request) {
      const { limit, queries, ...requestOptions } = validateRequest(request, requestValidator);
      const groups = [];
      for (const requestedQuery of queries) groups.push(Object.freeze({ query: requestedQuery, items: await query(requestedQuery, limit, { ...requestOptions, agent: true }) }));
      return Object.freeze({ groups: Object.freeze(groups) });
    }
  });
}
