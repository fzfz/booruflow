# 数据迁移

应用必须停止。导出到全新目录并打包：

```bash
bash data-export.sh --output /path/to/export-dir
bash data-pack.sh --input /path/to/export-dir --output /path/to/booruflow-data.tar.gz
```

可选 `--include-instances` 仅导出 ComfyUI 实例名称和地址；目标实例会保持禁用、待配置。包包含作品、角色、画风、Prompt Tag、底模、模型、LoRA、画师串、关系、模板、Workflow JSON 和媒体。模型权重、会话、运行历史、日志、绝对路径与凭据不进入包。

目标必须是安装脚本已建好当前结构且所有业务、关系、图片、向量和 KNN 表均为空的数据库；迁移账本与 `vector_spaces` 初始化元数据可以存在。先配置 Embedding 与 Reranker 地址、模型名和认证，再运行：

```bash
bash data-import.sh --input /path/to/booruflow-data.tar.gz --check
bash data-import.sh --input /path/to/booruflow-data.tar.gz --apply
```

`--check` 校验空库、配置、格式、版本、路径、媒体和引用，不写入数据。`--apply` 再次检查空库，并沿用现有检索规则同步生成 1,024 维向量：停用的作品、停用的角色以及所属作品已停用的角色保留业务记录，但不进入可检索向量集合；作品、角色、画风、Prompt Tag、LoRA 和画师串中的其余正常可检索记录生成向量。随后，命令在一个批次中提交记录、媒体、向量和 KNN 索引。提交前失败时，命令回滚本批次数据库写入并清理本批次文件。检查、向量准备失败，或提交前失败且自动回滚与清理已完成时，修正报告的问题后重新运行检查和完整导入。只有在输出了批次 ID 后执行中断或清理失败时，才使用该 ID 执行 `bash data-import.sh --recover --batch ID`。恢复命令清理未提交批次；对于已经提交的批次，保留导入数据并清理临时文件。Windows 使用同名 `.bat`。

任一受检表有记录时命令列出表名和数量并退出。成功导入后再次导入也会按非空库拒绝。支持 v0.88.0 同版本包及 Windows/macOS 互导；未知格式或超出支持范围的版本需使用匹配的 BooruFlow 版本。
