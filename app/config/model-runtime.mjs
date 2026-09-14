function requiredEnvironmentString(environment, name) {
  const value = environment?.[name];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty environment variable`);
  return value.trim();
}

function resolveEnvironmentReference(value, environment, label) {
  if (typeof value !== 'string' || !/^\$[A-Z][A-Z0-9_]*$/u.test(value)) throw new Error(`${label} must be one environment-variable reference`);
  return requiredEnvironmentString(environment, value.slice(1));
}

function resolveVectorServiceTemplate(value, environment, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== 3 || ['base_url', 'api_key', 'model'].some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`config/vector/models.json ${label} must contain exactly base_url, api_key, and model`);
  }
  const baseUrl = resolveEnvironmentReference(value.base_url, environment, `config/vector/models.json ${label}.base_url`);
  try { new URL(baseUrl); } catch { throw new Error(`config/vector/models.json ${label}.base_url must resolve to an HTTP or HTTPS URL`); }
  if (!/^https?:\/\//u.test(baseUrl)) throw new Error(`config/vector/models.json ${label}.base_url must resolve to an HTTP or HTTPS URL`);
  return Object.freeze({
    base_url: baseUrl.replace(/\/+$/u, ''),
    api_key: resolveEnvironmentReference(value.api_key, environment, `config/vector/models.json ${label}.api_key`),
    model: resolveEnvironmentReference(value.model, environment, `config/vector/models.json ${label}.model`)
  });
}

export function resolveVectorModelsConfiguration(modelsTemplate, environment = process.env) {
  if (!modelsTemplate || Array.isArray(modelsTemplate) || typeof modelsTemplate !== 'object') throw new Error('config/vector/models.json must be an object');
  return Object.freeze({
    embedding: resolveVectorServiceTemplate(modelsTemplate.embedding, environment, 'embedding'),
    reranker: resolveVectorServiceTemplate(modelsTemplate.reranker, environment, 'reranker')
  });
}
