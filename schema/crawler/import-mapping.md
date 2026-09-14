# 采集到数据库映射（版本 1）

本文件是采集正式导入的字段权威、空值、upsert 和重复合并规则。JSON Schema 通过后仍须执行本文件列出的跨对象校验。

| 采集字段 | 目标字段 | 规则 |
| --- | --- | --- |
| `identity.kind=work` | `works` | `source_id` 存在时以它 upsert；为空时以 NFC、空白折叠后的 `normalized_name` upsert。`category_name` 映射为 `works.category_name`，可缺并存 NULL，展示为“未分类”。 |
| `identity.kind=character` | `characters.work_id` | `parent_work_identity` 是结构化作品 identity，先按作品 identity 解析；无法解析即拒绝该对象。角色按 `source_id`，或 `work_id + normalized_name` upsert。首版角色没有正式分类字段，作品承担角色分组。 |
| `identity.kind=style` | `styles` | `styles` 的数据库唯一身份是 `(base_model_id, name)`；按 `identity.base_model_id + detail.name` 精确 upsert。`identity.normalized_name`、`source_id`、`category_name` 以及来源 URL/版本/更新时间仅保留为采集证据和报告字段，不参与 `styles` 身份，也不写入七字段表。`styles` 只接收 `base_model_id`、`name`、`aliases_json`、`prompt_text`、`style_description`、`cover_media_path`。 |
| `name`、`aliases`、`prompt_text` | 对应文本列 | 导入前 NFC、拒绝控制字符、按共享 Schema 长度；作品 `prompt_text` 为空且不入库。 |
| `source_url`、`source_version`、`source_updated_at` | `works`、`characters` 的同名来源列 | URL 必须是配置来源边界内的 HTTP/HTTPS；未知版本/更新时间存 SQL NULL。画风条目的来源字段只保留在证据和报告中，不写入 `styles`。 |
| 图片 `source_url`、`content_hash`、`local_path`、`sort_order` | `item_images` | `local_path` 只在导入前定位采集暂存字节；导入器把字节交给集中媒体存储，并只写入全库唯一的 `media_path`、哈希和排序。 |
| `image_results.status` | 图片记录 | `downloaded`/`existing` 写入或更新；`duplicate` 必须带有效 `content_hash` 或 `canonical_image_ref` 后复用既有记录并记录报告；`failed`/`skipped` 不创建可用图片记录。 |
| 图片组 | `cover_media_path` | 导入后为角色或画风写入实际媒体路径；无图片设 NULL。 |
| 对象存在性 | 发现与详情对象 | 当前抓到且通过 Schema、跨对象和导入校验的对象直接导入；本轮未返回的旧对象保持原样，不自动删除或改写。 |

## 重复、冲突与事务

相同身份且字段一致时合并别名和图片，记录 `deduplications`。关键字段（种类、角色父作品、来源身份、提示词）冲突时拒绝该对象、保留原值并记录错误。每对象在短事务中处理条目、图片记录与封面；文件需先在集中媒体存储的受控暂存区落盘。每条图片记录拥有独占 `media_path`；下载去重只复用已下载字节，通过本地复制或硬链接产生新路径，绝不共享数据库路径。图片数组在 Schema 后检查 `sort_order` 和非空 `source_url` 的唯一性，及每张 `owner_identity` 与详情 `identity` 完全一致。

## 首轮来源验证

首轮目录和详情按 kind 核验：作品、角色、画风都要求名称和详情 URL；角色、画风要求提示词；角色父作品必须可解析；画风必须提供正整数 `identity.base_model_id`。作品和角色的 `source_id` 可缺并使用身份回退；画风的 `identity.normalized_name`、来源字段、`category_name` 和 `name_normalized` 仅保留在证据和报告中，不进入 `styles`，缺失本身不会触发样本结构失败。来源出现无法映射的必填字段或种类语义变化时写结构报告并停止，更新映射后才继续。本轮未返回的旧对象保持数据库原值。
