-- SDXL/Danbooru 词汇导入表；向量化任务从 canonical_tag 与 aliases_json 读取语义文本。

CREATE TABLE prompt_terms (
  id INTEGER PRIMARY KEY,
  canonical_tag TEXT NOT NULL UNIQUE
    CHECK (length(trim(canonical_tag)) > 0),
  category INTEGER NOT NULL
    CHECK (category IN (0, 1, 3, 4, 5)),
  post_count INTEGER NOT NULL
    CHECK (post_count >= 0),
  aliases_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  created_at TEXT NOT NULL
    CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL
    CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

CREATE INDEX prompt_terms_category_post_count_idx
  ON prompt_terms(category, post_count DESC);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (7, '007-prompt-terms', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
