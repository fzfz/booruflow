-- v0.71.0：为 generation_loras 增加结构化触发词和默认模型权重，并迁移已审核目录数据。
-- source_id 只保存审核追踪编号；目标记录始终通过完整底模、模型和 LoRA 身份解析。
BEGIN IMMEDIATE;

ALTER TABLE generation_loras ADD COLUMN trigger_words_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(trigger_words_json) AND json_type(trigger_words_json) = 'array');
ALTER TABLE generation_loras ADD COLUMN weight REAL NOT NULL DEFAULT 1.0
  CHECK (typeof(weight) IN ('integer', 'real'));

CREATE TEMP TABLE migration_024_lora_map (
  source_id INTEGER PRIMARY KEY,
  base_model_name TEXT NOT NULL,
  model_file_name TEXT NOT NULL,
  model_file_format TEXT NOT NULL,
  model_precision_or_quantization TEXT NOT NULL,
  model_version TEXT,
  lora_file_name TEXT NOT NULL,
  lora_file_format TEXT NOT NULL,
  lora_precision_or_quantization TEXT NOT NULL,
  lora_version TEXT,
  trigger_words_json TEXT NOT NULL CHECK (json_valid(trigger_words_json) AND json_type(trigger_words_json) = 'array'),
  weight REAL NOT NULL CHECK (typeof(weight) IN ('integer', 'real')),
  description_update TEXT,
  usage_update TEXT
);

INSERT INTO migration_024_lora_map(
  source_id, base_model_name, model_file_name, model_file_format, model_precision_or_quantization, model_version,
  lora_file_name, lora_file_format, lora_precision_or_quantization, lora_version,
  trigger_words_json, weight, description_update, usage_update
) VALUES
  (1, 'anima', 'anima_aesthetic-v1.1.safetensors', 'safetensors', 'none', NULL, 'your_anima_lora.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (2, 'anima', 'anima_aestheticV11.safetensors', 'safetensors', 'none', NULL, 'anima-turbo-lora-v0.2.safetensors', 'safetensors', 'none', NULL, json_array(), 1, 'LoRA 特点：
- 提高生成稳定性、人体结构和风格一致性。
- 与基础模型相比，细节表现和艺术家风格遵循可能略弱。', '触发词：未记录
权重资料：
- 默认模型权重：1；作者说明可降至约 0.7 以增加生成多样性
其他用法：
- 建议 CFG 1、8–12 步。
- Euler 采样器可产生较中性、较平涂的结果；ER-SDE 可能产生过强噪声。
- 结果质量不理想时可移除质量词，并在提示词中加入 anime coloring。'),
  (3, 'anima', 'anima_baseV10.safetensors', 'safetensors', 'other', NULL, 'anima-highres-aesthetic-boost.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (4, 'anima', 'anima_baseV10.safetensors', 'safetensors', 'other', NULL, 'anima-turbo-lora-v0.2.safetensors', 'safetensors', 'none', NULL, json_array(), 1, 'LoRA 特点：
- 提高生成稳定性、人体结构和风格一致性。
- 与基础模型相比，细节表现和艺术家风格遵循可能略弱。', '触发词：未记录
权重资料：
- 默认模型权重：1；作者说明可降至约 0.7 以增加生成多样性
其他用法：
- 建议 CFG 1、8–12 步。
- Euler 采样器可产生较中性、较平涂的结果；ER-SDE 可能产生过强噪声。
- 结果质量不理想时可移除质量词，并在提示词中加入 anime coloring。'),
  (5, 'krea2', 'krea2_turbo_bf16.safetensors', 'safetensors', 'none', NULL, 'krea2_identity_edit_v1_2_编辑模型.safetensors', 'safetensors', 'none', NULL, json_array(), 1, 'LoRA 特点：
- 用于保持人物身份的指令式图像编辑，支持人物重构、局部编辑、换脸或替换、扩图、局部重绘、试穿、人物移除和全图重绘。
- v1.2 增加角色参考表、眼睛或人物替换、更高保真度和高分辨率处理能力。', '触发词：未记录
权重资料：
- 模型权重：推荐 1；ref_boost 建议在 2–6 之间尝试
其他用法：
- 必须配合 ComfyUI-Krea2Edit 节点包使用。
- Turbo 模型建议使用 8–12 步和 CFG 1.0；Raw 模型的大范围删除任务建议使用 20 步和 CFG 3.0。
- 双图编辑时图 1 是场景，图 2 是人物。'),
  (6, 'krea2', 'Krea2-MuseByStable_v15Turbo_fp8.safetensors', 'safetensors', 'none', NULL, 'Krea2-亚洲asianMix_v1-bf16.safetensors', 'safetensors', 'none', NULL, json_array('asian woman'), 1, NULL, '触发词：asian woman
权重资料：
- 默认模型权重：1；推荐权重：未记录
其他用法：
- 作者推荐 er_sde 采样器、simple/sgm_uniform/beta 调度器和 8–12 步。'),
  (7, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-亚洲asianMix_v1-bf16.safetensors', 'safetensors', 'none', NULL, json_array('asian woman'), 0.8, NULL, '触发词：asian woman
权重资料：
- 模型权重：工作流实测 0.8；推荐权重：未记录
其他用法：
- 作者推荐 er_sde 采样器、simple/sgm_uniform/beta 调度器和 8–12 步。'),
  (8, 'krea2', 'Krea2-红redcraft2KREA2RedMix_2Krea2Edition_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-亚洲asianMix_v1-bf16.safetensors', 'safetensors', 'none', NULL, json_array('asian woman'), 1, NULL, '触发词：asian woman
权重资料：
- 默认模型权重：1；推荐权重：未记录
其他用法：
- 作者推荐 er_sde 采样器、simple/sgm_uniform/beta 调度器和 8–12 步。'),
  (9, 'wai', 'waiIllustriousSDXL_v170.safetensors', 'safetensors', 'other', NULL, 'ILXL_Realism_Slider_V.1.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (10, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors', 'safetensors', 'none', NULL, json_array('A high-quality anime screencap'), 1, NULL, NULL),
  (11, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-25D动漫Semi_Real_Anime_V2_NSW.safetensors', 'safetensors', 'none', NULL, json_array('semireal'), 1, NULL, NULL),
  (12, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-奇幻现实FantasyRealism.safetensors', 'safetensors', 'none', NULL, json_array('f4nt4sy'), 1, NULL, NULL),
  (13, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-MISSILE228风格_c1-st5000.safetensors', 'safetensors', 'none', NULL, json_array('MISSILE228 style'), 1, NULL, '触发词：MISSILE228 style
权重资料：
- 模型权重范围：0.8～1；默认模型权重：1；推荐权重：未记录
其他用法：采样器、步数和 CFG 未记录。'),
  (14, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_雨雾玻璃朦胧质感rainywindow.safetensors', 'safetensors', 'none', NULL, json_array('rainy window style'), 1, NULL, NULL),
  (15, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-动漫umina_krea2_v1.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (16, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-炭笔素描.safetensors', 'safetensors', 'none', NULL, json_array('炭笔素描'), 1, NULL, NULL),
  (17, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-2D动漫Anime_Flat_V20_nnegret.safetensors', 'safetensors', 'none', NULL, json_array('线条动漫，平涂'), 1, NULL, NULL),
  (18, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-动漫角色融合Anime Character Fusion.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (19, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-漫画书Comic Book V2T2.safetensors', 'safetensors', 'none', NULL, json_array('A cinematic illustration'), 1, NULL, NULL),
  (20, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_单色水墨画风darkbrush.safetensors', 'safetensors', 'none', NULL, json_array('monochrome ink wash style'), 1, NULL, NULL),
  (21, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-25D动漫Semi_Real_Anime_V1_nnegret.safetensors', 'safetensors', 'none', NULL, json_array('semireal'), 1, NULL, NULL),
  (22, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_肌理质感抽象流体neondrip.safetensors', 'safetensors', 'none', NULL, json_array('textured abstract style'), 1, NULL, NULL),
  (23, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_童趣写意手绘速写kidsdrawing.safetensors', 'safetensors', 'none', NULL, json_array('naive expressive sketch style'), 1, NULL, NULL),
  (24, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_单色点刻版画dotmatrix.safetensors', 'safetensors', 'none', NULL, json_array('monochrome stippling style'), 1, NULL, NULL),
  (25, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_梦幻柔光动态模糊sunsetblur.safetensors', 'safetensors', 'none', NULL, json_array('ethereal motion blur style'), 1, NULL, NULL),
  (26, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-asia_cosplay_krea_2.safetensors', 'safetensors', 'none', NULL, json_array('realistic', 'photography', 'cosplay photo', 'movie stills'), 1, NULL, NULL),
  (27, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-2D动漫Anime_Flat_V10_nnegret.safetensors', 'safetensors', 'none', NULL, json_array('线条动漫，平涂'), 1, NULL, NULL),
  (28, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_复古塔罗牌插画vintagetarot.safetensors', 'safetensors', 'none', NULL, json_array('vintage tarot style'), 1, NULL, NULL),
  (29, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-Nikki_Style_Anime_NSW.safetensors', 'safetensors', 'none', NULL, json_array('Nikke style'), 1, NULL, NULL),
  (30, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_紫调复古旧动漫retroanime.safetensors', 'safetensors', 'none', NULL, json_array('purple retro anime style'), 1, NULL, NULL),
  (31, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-动漫yukan-style.safetensors', 'safetensors', 'none', NULL, json_array('yukan style'), 1, NULL, NULL),
  (32, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-朋克现实CYPERPUNK_KREA_2.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (33, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-漫画风格ogipote-ep63.safetensors', 'safetensors', 'none', NULL, json_array('Ogipote style'), 1, NULL, NULL),
  (34, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_装饰艺术柔和水彩softwatercolor.safetensors', 'safetensors', 'none', NULL, json_array('art deco watercolor style'), 1, NULL, NULL),
  (35, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-绘画美学风格painterly render style.safetensors', 'safetensors', 'none', NULL, json_array('Painterly render style'), 1, NULL, NULL),
  (36, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-漫画白鲸记风格_NSW.safetensors', 'safetensors', 'none', NULL, json_array('moby_d1ck'), 1, NULL, NULL),
  (37, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-gpt anime render.safetensors', 'safetensors', 'none', NULL, json_array('gpt anime render style'), 1, NULL, NULL),
  (38, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_darkbrush.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (39, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-realism_engine_v2_轻量.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (40, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-KREA2turboNSW.safetensors', 'safetensors', 'none', NULL, json_array(), 1.7, NULL, NULL),
  (41, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-snofs_v1.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (42, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-snofs_v1_轻量.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (43, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-NSW+.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (44, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-MysticXXX_v2.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (45, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-MysticXXX_v2_轻量.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (46, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-realism-V2.safetensors', 'safetensors', 'none', NULL, json_array(), 0.8, NULL, NULL),
  (47, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-realism_engine_v2.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (48, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-nud3.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (49, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-BBW型thickness.safetensors', 'safetensors', 'none', NULL, json_array('thicc'), 0.9, NULL, NULL),
  (50, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-滑块-湿度wetness_krea2_loraholic.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (51, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-腰T比pawg_krea2.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (52, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-亚洲Turbo_asianMix_v0.7_Lora.safetensors', 'safetensors', 'none', NULL, json_array('asian woman'), 1, NULL, '触发词：asian woman
权重资料：
- 默认模型权重：1；推荐权重：未记录
其他用法：
- 作者推荐 er_sde 采样器、simple/sgm_uniform/beta 调度器和 8–12 步。'),
  (53, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-滑块-细节Detailer-KREA2.safetensors', 'safetensors', 'none', NULL, json_array(), 3, NULL, NULL),
  (54, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-滑块-胸尺寸breast_size_krea2_loraholic.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (55, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-滑块-肤色skintone_krea2_loraholic.safetensors', 'safetensors', 'none', NULL, json_array(), 0.5, NULL, NULL),
  (56, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'krea2_identity_edit_v1_2_编辑模型.safetensors', 'safetensors', 'none', NULL, json_array(), 1, 'LoRA 特点：
- 支持 likeness、换脸、重绘、扩图、试穿和人物移除。
- v1.2 增加角色参考表、眼睛或人物替换、更高保真度和高分辨率处理能力。', '触发词：未记录
权重资料：
- 模型权重：推荐 1；ref_boost 建议在 2–6 之间尝试
其他用法：
- 必须配合 ComfyUI-Krea2Edit 节点包使用。
- Turbo 模型建议使用 8–12 步和 CFG 1.0；Raw 模型的大范围删除任务建议使用 20 步和 CFG 3.0。
- 双图编辑时图 1 是场景，图 2 是人物。'),
  (57, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-足美学Barphot_K2_V1.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (58, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-滑块-细节PornMaster_Detail_Slider_Krea2_V1.safetensors', 'safetensors', 'none', NULL, json_array(), 1, 'LoRA 特点：
- 对权重变化响应敏锐的细节和风格滑块。
- 正权重增大时可能趋向写实，负权重增大时可能趋向动漫。', '触发词：未记录
权重资料：
- 模型权重范围：-1.5～1；默认模型权重：1
- 负权重增大时可能趋向动漫，正权重增大时可能趋向写实
其他用法：未记录'),
  (59, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-nice_body.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (60, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-滑块-锐化图像PornMaster_Sharpen_portrait_slider_Krea2_V1.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (61, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-单双眼皮monolid_krea2_loraholic.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL),
  (62, 'krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', NULL, 'Krea2-滑块-年龄age_krea2_loraholic.safetensors', 'safetensors', 'none', NULL, json_array(), 1, NULL, NULL);

-- 迁移 001 至 023 的空库重放结果与已审计生产库在三个完整模型身份上使用不同精度值。
-- 别名保存完整模型身份，不使用 source_id 放宽目标 LoRA 的解析条件。
CREATE TEMP TABLE migration_024_model_identity_aliases (
  base_model_name TEXT NOT NULL,
  model_file_name TEXT NOT NULL,
  model_file_format TEXT NOT NULL,
  mapped_precision_or_quantization TEXT NOT NULL,
  mapped_version TEXT NOT NULL,
  replay_precision_or_quantization TEXT NOT NULL,
  PRIMARY KEY (
    base_model_name, model_file_name, model_file_format,
    mapped_precision_or_quantization, mapped_version,
    replay_precision_or_quantization
  )
);

INSERT INTO migration_024_model_identity_aliases(
  base_model_name, model_file_name, model_file_format,
  mapped_precision_or_quantization, mapped_version, replay_precision_or_quantization
) VALUES
  ('anima', 'anima_baseV10.safetensors', 'safetensors', 'other', '', 'none'),
  ('wai', 'waiIllustriousSDXL_v170.safetensors', 'safetensors', 'other', '', 'none'),
  ('krea2', 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf', 'gguf', 'none', '', 'other');

CREATE TEMP TABLE migration_024_lora_matches AS
SELECT
  mapping.source_id,
  lora.id AS lora_id,
  mapping.trigger_words_json,
  mapping.weight,
  mapping.description_update,
  mapping.usage_update
FROM migration_024_lora_map AS mapping
JOIN generation_base_models AS base
  ON base.name = mapping.base_model_name
JOIN generation_models AS model
  ON model.base_model_id = base.id
 AND model.file_name = mapping.model_file_name
 AND model.file_format = mapping.model_file_format
 AND (
      model.precision_or_quantization = mapping.model_precision_or_quantization
      OR EXISTS (
        SELECT 1
        FROM migration_024_model_identity_aliases AS identity_alias
        WHERE identity_alias.base_model_name = mapping.base_model_name
          AND identity_alias.model_file_name = mapping.model_file_name
          AND identity_alias.model_file_format = mapping.model_file_format
          AND identity_alias.mapped_precision_or_quantization = mapping.model_precision_or_quantization
          AND identity_alias.mapped_version = COALESCE(mapping.model_version, '')
          AND identity_alias.replay_precision_or_quantization = model.precision_or_quantization
      )
    )
 AND COALESCE(model.version, '') = COALESCE(mapping.model_version, '')
JOIN generation_loras AS lora
  ON lora.base_model_id = base.id
 AND lora.model_id = model.id
 AND lora.file_name = mapping.lora_file_name
 AND lora.file_format = mapping.lora_file_format
 AND lora.precision_or_quantization = mapping.lora_precision_or_quantization
 AND COALESCE(lora.version, '') = COALESCE(mapping.lora_version, '');

CREATE TEMP TABLE migration_024_guard (
  assertion_name TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO migration_024_guard(assertion_name, valid)
SELECT 'pre-update identity state',
       CASE
         WHEN (SELECT COUNT(*) FROM migration_024_lora_map) = 62
          AND (
            (
              (SELECT COUNT(*) FROM migration_024_lora_matches) = 62
              AND (SELECT COUNT(DISTINCT source_id) FROM migration_024_lora_matches) = 62
              AND (SELECT COUNT(DISTINCT lora_id) FROM migration_024_lora_matches) = 62
            )
            OR (
              (SELECT COUNT(*) FROM migration_024_lora_matches) = 0
              AND (SELECT COUNT(*) FROM generation_loras) = 0
            )
          )
         THEN 1
         ELSE 0
       END;

CREATE TEMP TABLE migration_024_state (expected_update_count INTEGER NOT NULL);
INSERT INTO migration_024_state(expected_update_count)
SELECT CASE WHEN COUNT(*) = 62 THEN 62 ELSE 0 END
FROM migration_024_lora_matches;

UPDATE generation_loras
SET trigger_words_json = (
      SELECT matched.trigger_words_json
      FROM migration_024_lora_matches AS matched
      WHERE matched.lora_id = generation_loras.id
    ),
    weight = (
      SELECT matched.weight
      FROM migration_024_lora_matches AS matched
      WHERE matched.lora_id = generation_loras.id
    ),
    description = COALESCE((
      SELECT matched.description_update
      FROM migration_024_lora_matches AS matched
      WHERE matched.lora_id = generation_loras.id
    ), description),
    usage = COALESCE((
      SELECT matched.usage_update
      FROM migration_024_lora_matches AS matched
      WHERE matched.lora_id = generation_loras.id
    ), usage)
WHERE id IN (SELECT lora_id FROM migration_024_lora_matches);

CREATE TEMP TABLE migration_024_update_count (updated_count INTEGER NOT NULL);
INSERT INTO migration_024_update_count(updated_count) VALUES (changes());

INSERT INTO migration_024_guard(assertion_name, valid)
SELECT 'updated row count',
       CASE WHEN updated_count = (SELECT expected_update_count FROM migration_024_state) THEN 1 ELSE 0 END
FROM migration_024_update_count;

INSERT INTO migration_024_guard(assertion_name, valid)
SELECT 'updated values match mapping',
       CASE WHEN NOT EXISTS (
         SELECT 1
         FROM migration_024_lora_matches AS matched
         JOIN generation_loras AS lora ON lora.id = matched.lora_id
         WHERE lora.trigger_words_json <> matched.trigger_words_json
            OR lora.weight <> matched.weight
            OR (matched.description_update IS NOT NULL AND lora.description <> matched.description_update)
            OR (matched.usage_update IS NOT NULL AND lora.usage <> matched.usage_update)
       ) THEN 1 ELSE 0 END;

DROP TABLE migration_024_update_count;
DROP TABLE migration_024_state;
DROP TABLE migration_024_guard;
DROP TABLE migration_024_lora_matches;
DROP TABLE migration_024_model_identity_aliases;
DROP TABLE migration_024_lora_map;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (24, '024-generation-lora-trigger-weight', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 24;
COMMIT;
