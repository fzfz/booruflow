import { characterTextProjection } from '../vector/character-semantic.mjs';
import { styleTextProjection } from '../vector/style-semantic.mjs';
import { embedProjection } from '../vector/vector-store.mjs';
import { workTextProjection } from '../vector/work-semantic.mjs';

const PROJECTIONS = Object.freeze({
  work: workTextProjection,
  character: characterTextProjection,
  style: styleTextProjection
});

export function createCatalogManagementVectorPreparation({ modelClient, configuration }) {
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (typeof configuration?.embedding_model !== 'string' || configuration.embedding_model.length === 0) throw new TypeError('configuration.embedding_model is required');
  return Object.freeze({
    async prepare(kind, row) {
      const project = PROJECTIONS[kind];
      if (!project) throw new TypeError(`unsupported catalog management kind: ${kind}`);
      return Object.freeze({
        vector: await embedProjection(modelClient, project(row)),
        embedding_model: configuration.embedding_model
      });
    }
  });
}
