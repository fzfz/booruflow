export const PROMPT_TERM_CATEGORIES = Object.freeze([
  Object.freeze({ code: 0, key: 'general', label_zh: '通用' }),
  Object.freeze({ code: 1, key: 'artist', label_zh: '作者' }),
  Object.freeze({ code: 3, key: 'copyright', label_zh: '作品/IP' }),
  Object.freeze({ code: 4, key: 'character', label_zh: '角色' }),
  Object.freeze({ code: 5, key: 'meta', label_zh: '元数据' })
]);

export const PROMPT_TERM_CATEGORY_CODES = Object.freeze(PROMPT_TERM_CATEGORIES.map(({ code }) => code));
