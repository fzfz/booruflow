# 脚本目录与维护命令

## 选择对应版本的路径

当前源码把 Windows 用户入口放在 `bin/windows/`，把 macOS 用户入口放在 `bin/macos/`。从安装根目录运行 `bin\windows\start.bat` 或 `bash bin/macos/start.sh`。其他操作使用同目录下的对应文件，参数以[日常运行](../user/operations.md)、[更新与恢复](../user/update-recovery.md)和[数据迁移](../user/data-transfer.md)为准。

已发布的 v0.88.0 仍把这些入口放在根目录。安装指南及用户指南中的根目录命令适用于该 Release；使用当前源码时，把命令中的脚本路径替换为上述平台目录。Release 附件仍使用独立文件名 `install.bat` 和 `install.sh`。安装目录的选择规则见[安装](../user/installation.md)。

安装时使用目标 Release 随附的安装器。当前源码中的安装器面向 `bin/` 布局；安装 v0.88.0 时使用该版本的原始附件。

## 保留脚本的用途

| 位置 | 用途 |
| --- | --- |
| `scripts/runtime-data.mjs` | 初始化、升级、导出、打包前检查和导入数据的内部入口。 |
| `scripts/start-local-app.mjs` | 启动应用并处理正常关闭。 |
| `scripts/prod-backup.mjs`、`scripts/prod-restore.mjs` | 备份与恢复数据库、媒体和配置。 |
| `scripts/platform/` | 原生用户脚本调用的共享平台实现。 |
| `scripts/catalog/` | Catalog 查询、ComfyUI 来源读取和 CLI 安装。 |
| `scripts/maintenance/` | 六类资源的向量重建。 |
| `scripts/testing/` | 测试运行、契约检查、隔离测试应用和跨平台数据互导验证。 |
| `scripts/docs/capture-screenshots.mjs` | 使用隔离示例数据生成文档截图。 |
| `scripts/release/tag.mjs` | 维护者通过 `npm run release:tag -- vX.Y.Z` 创建并推送发布标签。 |
| `scripts/release/check-job-results.mjs`、`preflight.mjs`、`publish.mjs`、`release-context.mjs` | GitHub Actions 使用的任务结果检查、发布前检查、发布入口和共享发布验证；执行条件见 [CI/CD 门禁](ci-cd.md)。 |

贡献者运行测试的方式见[测试](testing.md)，Catalog 命令见[Catalog/Source](catalog-source.md)，发布步骤见[发布](releases.md)。

## 重建向量

维护者在需要重新生成搜索向量时，先停止应用并完成备份，核对[模型配置](../user/configuration.md)，再从安装根目录运行所需命令：

```bash
node scripts/maintenance/rebuild-work-vectors.mjs --database data/app.sqlite --media-root data/media
```

将文件名中的 `work` 替换为 `character`、`style`、`prompt-term`、`generation-lora` 或 `artist-prompt-string`，即可处理对应资源。省略 `--reset` 且模型名称未改变时，命令复用长度有效的现有向量、修复缺失或不一致的 KNN 记录，并为缺失或长度无效的向量调用模型。需要强制重新向量化资源内容时使用 `--reset`。指定 `--reset` 或模型名称改变时，命令先删除该类资源的现有向量和 KNN 记录，再逐条重建；中途失败会保留已完成的记录，执行前应确认备份可用。检查输出中的 `failures` 和退出码，处理报告的问题后再启动应用并验证搜索。数据包导入会同步建立向量，其步骤以[数据迁移](../user/data-transfer.md)为准。
