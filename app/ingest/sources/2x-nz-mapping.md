# 2x.nz API 映射

分类接口为每个模式提供角色分类和画风分类。适配器把每个 `mode + character.category` 建成一个作品：作品名称与分类名称相同，来源标识由模式和分类组成。该作品只承担来源归属，角色随后以 API 的 `id` 挂在它下面。

理由：现有角色契约要求有结构化的作品归属；API 为角色提供的唯一显式归属字段是 `category`。适配器在分类缺失、空值或与请求分类不一致时停止，并写入结构错误。画风保留 API 的 `category` 作为画风分类，不生成作品。

条目 `tags` 映射为角色或画风的 `prompt_text`。缩略图仅来自 API 返回的相对路径，解析后必须仍位于 `https://api-ai.acofork.com` 的 `/api/library/tag_thumb` 或 `/api/style_thumbnail`。

批量接口按分类返回 `characters` 与 `styles` 两个数组；采集器按当前分页分支只处理目标数组，同时校验另一数组的安全结构。条目 `kind` 允许为 `builtin` 或 `external`，两者都属于来源可用对象。请求顶层 `mode` 作为归属版本；条目自身 `mode` 原样写入隔离扩展字段，避免来源返回的模式标记差异造成静默丢失。内置角色缩略图使用 `/api/library/tag_thumb`，外部对象缩略图使用 `/api/library/thumb`，画风缩略图使用 `/api/style_thumbnail`；条目 `url` 只保存为元数据，不跟随访问。
