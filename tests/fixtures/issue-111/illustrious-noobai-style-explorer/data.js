const galleryData = [
  {
    id: 'style-exact-001',
    name: 'Exact Source Name',
    p: ['exact-preview-a', 'exact-preview-b'],
    post_count: 101,
    uniqueness_score: 0.11,
    category_name: 'source-only-category',
    style_description: 'DO NOT SEND style_description: exact record'
  },
  {
    id: 'style-alias-002',
    name: 'Alias Source Name (Source Alias)',
    p: ['alias-preview-a'],
    post_count: 202,
    uniqueness_score: 0.22,
    category_name: 'source-only-category',
    style_description: 'DO NOT SEND style_description: alias record'
  },
  {
    id: 'style-normalized-003',
    name: 'Normalized Name Source',
    p: ['normalized-name-preview'],
    post_count: 303,
    uniqueness_score: 0.33,
    category_name: 'source-only-category',
    style_description: 'DO NOT SEND style_description: normalized name record'
  },
  {
    id: 'style-normalized-alias-004',
    name: 'Normalized Alias Source (Normalized Alias Only) (Fresh Normalized Alias)',
    p: ['normalized-alias-preview'],
    post_count: 404,
    uniqueness_score: 0.44,
    category_name: 'source-only-category',
    style_description: 'DO NOT SEND style_description: normalized alias record'
  }
];

const promptLines = [
  'Exact Source Name\tfull original prompt line 0: preserve commas, weights:1.25, and trailing source text.',
  'Alias Source Name (Source Alias) (New Alias)\tfull original prompt line 1: preserve every token, punctuation, and spacing.',
  'Normalized Name Source\tfull original prompt line 2: preserve normalized name source exactly as provided.',
  'Normalized Alias Source (Normalized Alias Only) (Fresh Normalized Alias)\tfull original prompt line 3: preserve normalized alias source exactly as provided.'
];
