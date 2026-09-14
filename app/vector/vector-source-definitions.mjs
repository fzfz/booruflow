const VECTOR_SOURCE_DEFINITIONS = Object.freeze({
  work: Object.freeze({ table: 'works', availableWhere: 'is_available = 1' }),
  character: Object.freeze({ table: 'characters', availableWhere: 'is_available = 1' }),
  style: Object.freeze({ table: 'styles', availableWhere: '1 = 1' }),
  prompt_term: Object.freeze({ table: 'prompt_terms', availableWhere: '1 = 1' }),
  generation_lora: Object.freeze({ table: 'generation_loras', availableWhere: '1 = 1' }),
  artist_prompt_string: Object.freeze({ table: 'artist_prompt_strings', availableWhere: '1 = 1' })
});

const OBJECT_KINDS = Object.freeze(Object.keys(VECTOR_SOURCE_DEFINITIONS));
const VECTOR_SOURCE_TABLES = Object.freeze(
  Object.fromEntries(Object.entries(VECTOR_SOURCE_DEFINITIONS).map(([objectKind, { table }]) => [objectKind, table]))
);

export { OBJECT_KINDS, VECTOR_SOURCE_DEFINITIONS, VECTOR_SOURCE_TABLES };
