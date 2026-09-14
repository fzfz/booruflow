import {
  assertErrorMatrix,
  assertJsonSchemaReferences,
  loadAuthoritativeContracts,
  parseOpenApiStructure
} from './authoritative-contracts.mjs';

export function verifyAuthoritativeContracts(repositoryRoot) {
  const contracts = loadAuthoritativeContracts(repositoryRoot);
  const schema = assertJsonSchemaReferences(contracts.schemas);
  const openapi = parseOpenApiStructure(contracts.openapiText);
  const matrix = assertErrorMatrix(openapi, contracts.errorCatalog);
  return { schema, openapi: { operationCount: openapi.operations.length, pathCount: openapi.pathCount }, matrix };
}
