-- v0.60.1：把 Krea2 LoRA 调研资料导入现有 generation_loras。
-- description 只保存 LoRA 特点；usage 只保存触发词、权重和直接调用方法。
BEGIN IMMEDIATE;

INSERT OR IGNORE INTO generation_base_models(name, created_at, updated_at)
VALUES ('krea2', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z');

INSERT INTO generation_models(
  base_model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, published_at, description, usage,
  skill_name, cover_media_path, created_at, updated_at
)
SELECT base.id, 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none',
       NULL, NULL, NULL, NULL,
       'ComfyUI 内置模板登记的 krea2 主模型。',
       '用于对应的内置 ComfyUI Workflow。',
       NULL, NULL, '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_models existing
    WHERE existing.base_model_id = base.id
      AND existing.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
  );

-- 01: Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 高质量动漫截图风格。',
    usage = '触发词：A high-quality anime screencap
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 高质量动漫截图风格。', '触发词：A high-quality anime screencap
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors'
  );

-- 02: Krea2-25D动漫Semi_Real_Anime_V2_NSW.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 2.5D 半写实动漫风格。',
    usage = '触发词：semireal
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-25D动漫Semi_Real_Anime_V2_NSW.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-25D动漫Semi_Real_Anime_V2_NSW.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 2.5D 半写实动漫风格。', '触发词：semireal
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-25D动漫Semi_Real_Anime_V2_NSW.safetensors'
  );

-- 03: Krea2-奇幻现实FantasyRealism.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 奇幻写实风格。',
    usage = '触发词：f4nt4sy
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-奇幻现实FantasyRealism.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-奇幻现实FantasyRealism.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 奇幻写实风格。', '触发词：f4nt4sy
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-奇幻现实FantasyRealism.safetensors'
  );

-- 04: Krea2-MISSILE228风格_c1-st5000.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- MISSILE228 风格。',
    usage = '触发词：MISSILE228 风格；MISSILE228 style
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-MISSILE228风格_c1-st5000.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-MISSILE228风格_c1-st5000.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- MISSILE228 风格。', '触发词：MISSILE228 风格；MISSILE228 style
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-MISSILE228风格_c1-st5000.safetensors'
  );

-- 05: krea2_雨雾玻璃朦胧质感rainywindow.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 湿玻璃、雨滴、凝结水汽和雨窗氛围。',
    usage = '触发词：rainy window style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_雨雾玻璃朦胧质感rainywindow.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_雨雾玻璃朦胧质感rainywindow.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 湿玻璃、雨滴、凝结水汽和雨窗氛围。', '触发词：rainy window style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_雨雾玻璃朦胧质感rainywindow.safetensors'
  );

-- 06: Krea2-动漫umina_krea2_v1.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 动漫风格。',
    usage = '触发词：未记录
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-动漫umina_krea2_v1.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-动漫umina_krea2_v1.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 动漫风格。', '触发词：未记录
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-动漫umina_krea2_v1.safetensors'
  );

-- 07: Krea2-炭笔素描.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 炭笔素描风格。',
    usage = '触发词：炭笔素描
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-炭笔素描.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-炭笔素描.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 炭笔素描风格。', '触发词：炭笔素描
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-炭笔素描.safetensors'
  );

-- 08: Krea2-2D动漫Anime_Flat_V20_nnegret.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 2D 线条动漫和平涂风格。',
    usage = '触发词：线条动漫，平涂
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
- 模型权重：工作流实测 1；推荐权重：未确认；资料状态：工作流实测；权重变化：本地工作流实际使用值；该点值不构成作者推荐。
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-2D动漫Anime_Flat_V20_nnegret.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-2D动漫Anime_Flat_V20_nnegret.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 2D 线条动漫和平涂风格。', '触发词：线条动漫，平涂
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
- 模型权重：工作流实测 1；推荐权重：未确认；资料状态：工作流实测；权重变化：本地工作流实际使用值；该点值不构成作者推荐。
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-2D动漫Anime_Flat_V20_nnegret.safetensors'
  );

-- 09: Krea2-动漫角色融合Anime Character Fusion.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 动漫角色融合效果。',
    usage = '触发词：未记录
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-动漫角色融合Anime Character Fusion.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-动漫角色融合Anime Character Fusion.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 动漫角色融合效果。', '触发词：未记录
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-动漫角色融合Anime Character Fusion.safetensors'
  );

-- 10: Krea2-漫画书Comic Book V2T2.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 电影感漫画书插画风格。',
    usage = '触发词：A cinematic illustration
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-漫画书Comic Book V2T2.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-漫画书Comic Book V2T2.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 电影感漫画书插画风格。', '触发词：A cinematic illustration
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-漫画书Comic Book V2T2.safetensors'
  );

-- 11: krea2_单色水墨画风darkbrush.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 单色水墨风格。',
    usage = '触发词：monochrome ink wash style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_单色水墨画风darkbrush.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_单色水墨画风darkbrush.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 单色水墨风格。', '触发词：monochrome ink wash style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_单色水墨画风darkbrush.safetensors'
  );

-- 12: Krea2-25D动漫Semi_Real_Anime_V1_nnegret.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 2.5D 半写实动漫风格。',
    usage = '触发词：semireal
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-25D动漫Semi_Real_Anime_V1_nnegret.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-25D动漫Semi_Real_Anime_V1_nnegret.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 2.5D 半写实动漫风格。', '触发词：semireal
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-25D动漫Semi_Real_Anime_V1_nnegret.safetensors'
  );

-- 13: krea2_肌理质感抽象流体neondrip.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 纹理化抽象流体和霓虹流动效果。',
    usage = '触发词：textured abstract style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_肌理质感抽象流体neondrip.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_肌理质感抽象流体neondrip.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 纹理化抽象流体和霓虹流动效果。', '触发词：textured abstract style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_肌理质感抽象流体neondrip.safetensors'
  );

-- 14: krea2_童趣写意手绘速写kidsdrawing.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 童趣、写意和手绘速写风格。',
    usage = '触发词：naive expressive sketch style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_童趣写意手绘速写kidsdrawing.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_童趣写意手绘速写kidsdrawing.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 童趣、写意和手绘速写风格。', '触发词：naive expressive sketch style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_童趣写意手绘速写kidsdrawing.safetensors'
  );

-- 15: krea2_单色点刻版画dotmatrix.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 单色点刻和版画风格。',
    usage = '触发词：monochrome stippling style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_单色点刻版画dotmatrix.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_单色点刻版画dotmatrix.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 单色点刻和版画风格。', '触发词：monochrome stippling style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_单色点刻版画dotmatrix.safetensors'
  );

-- 16: krea2_梦幻柔光动态模糊sunsetblur.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 梦幻柔光和动态模糊风格。',
    usage = '触发词：ethereal motion blur style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_梦幻柔光动态模糊sunsetblur.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_梦幻柔光动态模糊sunsetblur.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 梦幻柔光和动态模糊风格。', '触发词：ethereal motion blur style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_梦幻柔光动态模糊sunsetblur.safetensors'
  );

-- 17: Krea2-asia_cosplay_krea_2.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 亚洲角色扮演摄影和电影剧照方向。',
    usage = '触发词：realistic, photography, cosplay photo, movie stills
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-asia_cosplay_krea_2.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-asia_cosplay_krea_2.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 亚洲角色扮演摄影和电影剧照方向。', '触发词：realistic, photography, cosplay photo, movie stills
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-asia_cosplay_krea_2.safetensors'
  );

-- 18: Krea2-2D动漫Anime_Flat_V10_nnegret.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 2D 线条动漫和平涂风格。',
    usage = '触发词：线条动漫，平涂
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-2D动漫Anime_Flat_V10_nnegret.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-2D动漫Anime_Flat_V10_nnegret.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 2D 线条动漫和平涂风格。', '触发词：线条动漫，平涂
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-2D动漫Anime_Flat_V10_nnegret.safetensors'
  );

-- 19: krea2_复古塔罗牌插画vintagetarot.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 十九世纪欧洲神秘塔罗、古旧纹理和象征图像风格。',
    usage = '触发词：vintage tarot style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_复古塔罗牌插画vintagetarot.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_复古塔罗牌插画vintagetarot.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 十九世纪欧洲神秘塔罗、古旧纹理和象征图像风格。', '触发词：vintage tarot style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_复古塔罗牌插画vintagetarot.safetensors'
  );

-- 20: Krea2-Nikki_Style_Anime_NSW.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- Nikke 动漫风格。',
    usage = '触发词：Nikke style
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-Nikki_Style_Anime_NSW.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-Nikki_Style_Anime_NSW.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- Nikke 动漫风格。', '触发词：Nikke style
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-Nikki_Style_Anime_NSW.safetensors'
  );

-- 21: krea2_紫调复古旧动漫retroanime.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 紫调、复古和旧动漫风格。',
    usage = '触发词：purple retro anime style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_紫调复古旧动漫retroanime.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_紫调复古旧动漫retroanime.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 紫调、复古和旧动漫风格。', '触发词：purple retro anime style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_紫调复古旧动漫retroanime.safetensors'
  );

-- 22: Krea2-动漫yukan-style.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- yukan 动漫风格。',
    usage = '触发词：yukan style
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-动漫yukan-style.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-动漫yukan-style.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- yukan 动漫风格。', '触发词：yukan style
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-动漫yukan-style.safetensors'
  );

-- 23: Krea2-朋克现实CYPERPUNK_KREA_2.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 赛博朋克写实风格。',
    usage = '触发词：未记录
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-朋克现实CYPERPUNK_KREA_2.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-朋克现实CYPERPUNK_KREA_2.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 赛博朋克写实风格。', '触发词：未记录
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-朋克现实CYPERPUNK_KREA_2.safetensors'
  );

-- 24: Krea2-漫画风格ogipote-ep63.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- Ogipote 漫画风格。',
    usage = '触发词：Ogipote style
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：建议把触发词放在提示词开头或结尾。',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-漫画风格ogipote-ep63.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-漫画风格ogipote-ep63.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- Ogipote 漫画风格。', '触发词：Ogipote style
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：建议把触发词放在提示词开头或结尾。', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-漫画风格ogipote-ep63.safetensors'
  );

-- 25: krea2_装饰艺术柔和水彩softwatercolor.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 柔和水彩和 Art Deco 风格。',
    usage = '触发词：art deco watercolor style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_装饰艺术柔和水彩softwatercolor.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_装饰艺术柔和水彩softwatercolor.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 柔和水彩和 Art Deco 风格。', '触发词：art deco watercolor style
权重资料：
- 模型权重：1；推荐类型：用户资料默认权重；资料状态：用户资料默认权重；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_装饰艺术柔和水彩softwatercolor.safetensors'
  );

-- 26: Krea2-绘画美学风格painterly render style.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 绘画美学和 painterly render 风格。',
    usage = '触发词：Painterly render style
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-绘画美学风格painterly render style.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-绘画美学风格painterly render style.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 绘画美学和 painterly render 风格。', '触发词：Painterly render style
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-绘画美学风格painterly render style.safetensors'
  );

-- 27: Krea2-漫画白鲸记风格_NSW.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 白鲸记题材漫画风格。',
    usage = '触发词：moby_d1ck
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-漫画白鲸记风格_NSW.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-漫画白鲸记风格_NSW.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 白鲸记题材漫画风格。', '触发词：moby_d1ck
权重资料：
- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-漫画白鲸记风格_NSW.safetensors'
  );

-- 28: Krea2-gpt anime render.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- GPT 动漫渲染风格。',
    usage = '触发词：gpt anime render style
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-gpt anime render.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-gpt anime render.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- GPT 动漫渲染风格。', '触发词：gpt anime render style
权重资料：
- 模型权重范围：0.8～1；推荐权重：未记录；资料状态：用户推荐；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-gpt anime render.safetensors'
  );

-- 29: krea2_darkbrush.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：未记录',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_darkbrush.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_darkbrush.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：未记录', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_darkbrush.safetensors'
  );

-- 30: Krea2-realism_engine_v2_轻量.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 偶尔出现 M 形态。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-realism_engine_v2_轻量.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-realism_engine_v2_轻量.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 偶尔出现 M 形态。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-realism_engine_v2_轻量.safetensors'
  );

-- 31: Krea2-KREA2turboNSW.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- unstableDissolution 风格。',
    usage = '触发词：未记录
权重资料：
- 模型权重范围：1.7～2；推荐权重：未记录；资料状态：用户实测范围；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-KREA2turboNSW.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-KREA2turboNSW.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- unstableDissolution 风格。', '触发词：未记录
权重资料：
- 模型权重范围：1.7～2；推荐权重：未记录；资料状态：用户实测范围；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-KREA2turboNSW.safetensors'
  );

-- 32: Krea2-snofs_v1.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 半写实风格。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-snofs_v1.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-snofs_v1.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 半写实风格。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-snofs_v1.safetensors'
  );

-- 33: Krea2-snofs_v1_轻量.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 写实表现和标准部位表现。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-snofs_v1_轻量.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-snofs_v1_轻量.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 写实表现和标准部位表现。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-snofs_v1_轻量.safetensors'
  );

-- 34: Krea2-NSW+.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 画面精细干净，并呈现 BAI 方向。',
    usage = '触发词：未记录
权重资料：
- 模型权重范围：0.7～1；推荐权重：未记录；资料状态：用户实测范围；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-NSW+.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-NSW+.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 画面精细干净，并呈现 BAI 方向。', '触发词：未记录
权重资料：
- 模型权重范围：0.7～1；推荐权重：未记录；资料状态：用户实测范围；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-NSW+.safetensors'
  );

-- 35: Krea2-MysticXXX_v2.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 部位表现和 MAO 方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-MysticXXX_v2.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-MysticXXX_v2.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 部位表现和 MAO 方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-MysticXXX_v2.safetensors'
  );

-- 36: Krea2-MysticXXX_v2_轻量.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 写实表现和标准部位表现。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-MysticXXX_v2_轻量.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-MysticXXX_v2_轻量.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 写实表现和标准部位表现。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-MysticXXX_v2_轻量.safetensors'
  );

-- 37: Krea2-realism-V2.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 表情优化。
- 真实纹理、自然光、构图和面部表现方向。',
    usage = '触发词：未记录
权重资料：
- 模型权重范围：0.7～0.8；推荐权重：未记录；资料状态：待验证；权重变化：未记录
其他用法：建议搭配轻量 LoRA 或相关节点。',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-realism-V2.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-realism-V2.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 表情优化。
- 真实纹理、自然光、构图和面部表现方向。', '触发词：未记录
权重资料：
- 模型权重范围：0.7～0.8；推荐权重：未记录；资料状态：待验证；权重变化：未记录
其他用法：建议搭配轻量 LoRA 或相关节点。', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-realism-V2.safetensors'
  );

-- 38: Krea2-realism_engine_v2.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 部位表现和 BAI 方向。
- 写实风格。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-realism_engine_v2.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-realism_engine_v2.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 部位表现和 BAI 方向。
- 写实风格。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-realism_engine_v2.safetensors'
  );

-- 39: Krea2-nud3.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 身材优化。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：建议搭配轻量 LoRA 或相关节点。',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-nud3.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-nud3.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 身材优化。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：建议搭配轻量 LoRA 或相关节点。', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-nud3.safetensors'
  );

-- 40: Krea2-BBW型thickness.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 体型厚度方向调整。',
    usage = '触发词：thicc
权重资料：
- 模型权重范围：0.5～1；推荐权重：未记录；资料状态：作者资料；权重变化：用于体型厚度方向调整；作者样例常用 0.9，但该样例点不构成作者推荐值；资料未逐点描述区间内部变化。
其他用法：建议使用 Euler 或 Euler a 采样器，并使用至少 8 步。',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-BBW型thickness.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-BBW型thickness.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 体型厚度方向调整。', '触发词：thicc
权重资料：
- 模型权重范围：0.5～1；推荐权重：未记录；资料状态：作者资料；权重变化：用于体型厚度方向调整；作者样例常用 0.9，但该样例点不构成作者推荐值；资料未逐点描述区间内部变化。
其他用法：建议使用 Euler 或 Euler a 采样器，并使用至少 8 步。', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-BBW型thickness.safetensors'
  );

-- 41: Krea2-滑块-湿度wetness_krea2_loraholic.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 湿度滑块方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-滑块-湿度wetness_krea2_loraholic.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-滑块-湿度wetness_krea2_loraholic.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 湿度滑块方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-滑块-湿度wetness_krea2_loraholic.safetensors'
  );

-- 42: Krea2-腰T比pawg_krea2.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 腰臀比例方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-腰T比pawg_krea2.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-腰T比pawg_krea2.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 腰臀比例方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-腰T比pawg_krea2.safetensors'
  );

-- 43: Krea2-亚洲Turbo_asianMix_v0.7_Lora.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 亚洲女性面部特征、亚洲人像和摄影方向。',
    usage = '触发词：asian woman
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-亚洲Turbo_asianMix_v0.7_Lora.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-亚洲Turbo_asianMix_v0.7_Lora.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 亚洲女性面部特征、亚洲人像和摄影方向。', '触发词：asian woman
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-亚洲Turbo_asianMix_v0.7_Lora.safetensors'
  );

-- 44: Krea2-滑块-细节Detailer-KREA2.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- Krea 2 细节增强滑块。',
    usage = '触发词：未记录
权重资料：
- 滑块权重：推荐 3；资料状态：作者资料；权重变化：用于增强细节；资料未记录不同权重的逐点变化。
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-滑块-细节Detailer-KREA2.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-滑块-细节Detailer-KREA2.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- Krea 2 细节增强滑块。', '触发词：未记录
权重资料：
- 滑块权重：推荐 3；资料状态：作者资料；权重变化：用于增强细节；资料未记录不同权重的逐点变化。
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-滑块-细节Detailer-KREA2.safetensors'
  );

-- 45: Krea2-滑块-胸尺寸breast_size_krea2_loraholic.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 胸部尺寸滑块方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-滑块-胸尺寸breast_size_krea2_loraholic.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-滑块-胸尺寸breast_size_krea2_loraholic.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 胸部尺寸滑块方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-滑块-胸尺寸breast_size_krea2_loraholic.safetensors'
  );

-- 46: Krea2-滑块-肤色skintone_krea2_loraholic.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 肤色方向滑块。',
    usage = '触发词：未记录
权重资料：
- 滑块权重范围：-4～4；推荐权重：未记录；资料状态：作者资料；权重变化：-4 对应极浅肤色，4 对应深肤色；约 0.5 对应混合肤色或晒黑肤色，不构成统一推荐值。
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-滑块-肤色skintone_krea2_loraholic.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-滑块-肤色skintone_krea2_loraholic.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 肤色方向滑块。', '触发词：未记录
权重资料：
- 滑块权重范围：-4～4；推荐权重：未记录；资料状态：作者资料；权重变化：-4 对应极浅肤色，4 对应深肤色；约 0.5 对应混合肤色或晒黑肤色，不构成统一推荐值。
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-滑块-肤色skintone_krea2_loraholic.safetensors'
  );

-- 47: krea2_identity_edit_v1_2_编辑模型.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 支持 likeness、换脸、重绘、扩图、试穿和人物移除。',
    usage = '触发词：未记录
权重资料：
- 模型权重：推荐 1；资料状态：作者资料；权重变化：未记录
其他用法：使用 Turbo 模型时建议 8–12 步、CFG 1.0。',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'krea2_identity_edit_v1_2_编辑模型.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'krea2_identity_edit_v1_2_编辑模型.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 支持 likeness、换脸、重绘、扩图、试穿和人物移除。', '触发词：未记录
权重资料：
- 模型权重：推荐 1；资料状态：作者资料；权重变化：未记录
其他用法：使用 Turbo 模型时建议 8–12 步、CFG 1.0。', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'krea2_identity_edit_v1_2_编辑模型.safetensors'
  );

-- 48: Krea2-亚洲asianMix_v1-bf16.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 亚洲人像、脸部调整、写实脸部和摄影方向。',
    usage = '触发词：未记录
权重资料：
- 模型权重：工作流实测 0.8；推荐权重：未确认；资料状态：工作流实测；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-亚洲asianMix_v1-bf16.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-亚洲asianMix_v1-bf16.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 亚洲人像、脸部调整、写实脸部和摄影方向。', '触发词：未记录
权重资料：
- 模型权重：工作流实测 0.8；推荐权重：未确认；资料状态：工作流实测；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-亚洲asianMix_v1-bf16.safetensors'
  );

-- 49: Krea2-足美学Barphot_K2_V1.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 足部美学方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-足美学Barphot_K2_V1.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-足美学Barphot_K2_V1.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 足部美学方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-足美学Barphot_K2_V1.safetensors'
  );

-- 50: Krea2-滑块-细节PornMaster_Detail_Slider_Krea2_V1.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 细节滑块方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-滑块-细节PornMaster_Detail_Slider_Krea2_V1.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-滑块-细节PornMaster_Detail_Slider_Krea2_V1.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 细节滑块方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-滑块-细节PornMaster_Detail_Slider_Krea2_V1.safetensors'
  );

-- 51: Krea2-nice_body.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 身材调整方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-nice_body.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-nice_body.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 身材调整方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-nice_body.safetensors'
  );

-- 52: Krea2-滑块-锐化图像PornMaster_Sharpen_portrait_slider_Krea2_V1.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 人像锐化滑块方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-滑块-锐化图像PornMaster_Sharpen_portrait_slider_Krea2_V1.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-滑块-锐化图像PornMaster_Sharpen_portrait_slider_Krea2_V1.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 人像锐化滑块方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-滑块-锐化图像PornMaster_Sharpen_portrait_slider_Krea2_V1.safetensors'
  );

-- 53: Krea2-单双眼皮monolid_krea2_loraholic.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 单双眼皮方向。',
    usage = '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-单双眼皮monolid_krea2_loraholic.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-单双眼皮monolid_krea2_loraholic.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 单双眼皮方向。', '触发词：未记录
权重资料：未记录；推荐权重：未记录；权重变化：未记录
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-单双眼皮monolid_krea2_loraholic.safetensors'
  );

-- 54: Krea2-滑块-年龄age_krea2_loraholic.safetensors
UPDATE generation_loras
SET description = 'LoRA 特点：
- 年龄方向滑块，并尽量保持画面细节。',
    usage = '触发词：未记录
权重资料：
- 滑块权重范围：-3～8；推荐权重：未记录；资料状态：作者资料；冲突组：age-slider-range；适用模型线：Krea-2；权重变化：沿年龄方向调整；资料没有明确说明正值和负值分别对应的年龄方向。
- 滑块权重范围：-3～10；推荐权重：未记录；资料状态：来源冲突；冲突组：age-slider-range；适用模型线：未确认；权重变化：同一轮资料另列该范围，但来源没有明确它适用于 Krea-2 还是 ZIT。
其他用法：未记录',
    updated_at = '2026-08-11T00:00:00Z'
WHERE id = (
  SELECT MIN(existing.id)
  FROM generation_loras existing
  JOIN generation_base_models base ON base.id = existing.base_model_id
  WHERE base.name = 'krea2'
    AND existing.model_id = (
      SELECT MIN(candidate.id)
      FROM generation_models candidate
      WHERE candidate.base_model_id = base.id
        AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
    )
    AND existing.file_name = 'Krea2-滑块-年龄age_krea2_loraholic.safetensors'
);

INSERT INTO generation_loras(
  base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at
)
SELECT base.id, model.id, 'Krea2-滑块-年龄age_krea2_loraholic.safetensors', 'safetensors', 'none',
       NULL, NULL, NULL, 'LoRA 特点：
- 年龄方向滑块，并尽量保持画面细节。', '触发词：未记录
权重资料：
- 滑块权重范围：-3～8；推荐权重：未记录；资料状态：作者资料；冲突组：age-slider-range；适用模型线：Krea-2；权重变化：沿年龄方向调整；资料没有明确说明正值和负值分别对应的年龄方向。
- 滑块权重范围：-3～10；推荐权重：未记录；资料状态：来源冲突；冲突组：age-slider-range；适用模型线：未确认；权重变化：同一轮资料另列该范围，但来源没有明确它适用于 Krea-2 还是 ZIT。
其他用法：未记录', NULL,
       '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
FROM generation_base_models base
JOIN generation_models model ON model.id = (
  SELECT MIN(candidate.id)
  FROM generation_models candidate
  WHERE candidate.base_model_id = base.id
    AND candidate.file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
)
WHERE base.name = 'krea2'
  AND NOT EXISTS (
    SELECT 1
    FROM generation_loras existing
    WHERE existing.base_model_id = base.id
      AND existing.model_id = model.id
      AND existing.file_name = 'Krea2-滑块-年龄age_krea2_loraholic.safetensors'
  );

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (23, '023-krea2-lora-catalog', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 23;
COMMIT;
