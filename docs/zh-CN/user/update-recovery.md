# 更新与恢复

先运行状态脚本并停止应用，再运行 `update.bat --tag vX.Y.Z` 或 `bash update.sh --tag vX.Y.Z` 指定目标发布标签。更新脚本会检查 Git 安装、本地修改、版本方向、数据库版本和停机状态；通过后依次备份、获取标签、检出代码、运行 `npm ci`、升级数据库并执行临时健康检查。成功后由你运行启动脚本。

本地修改、降级请求、未知数据库版本或非 Git 安装会在写入前停止，并显示处理方法。更新失败时保留备份和可识别的旧版本状态。把更新输出中的直接备份目录传给 `restore.bat --backup data/recovery/<backup-directory>` 或 `bash restore.sh --backup data/recovery/<backup-directory>`；参数必须是 `data/recovery/` 下的一层目录名。恢复会还原匹配的代码、数据库、媒体和配置。恢复完成后运行检查，再启动并确认版本与资源。

## 把数据迁入新的 v0.88.0 安装

数据包只支持相同版本导出和导入。一个 v0.88.0 安装迁往另一个 v0.88.0 安装时，停止来源应用，在来源目录运行 `data-export` 和 `data-pack`；保持目标应用停止，在已经完成模型配置的空数据库运行 `data-import --check` 和 `--apply`，再启动目标并核对资源。完整参数见[数据迁移](data-transfer.md)。

v0.87.0 没有新仓库的运维脚本和 `v0.88.0` 标签。先按旧部署原有的停止方法关闭应用，并确认其进程和监听端口已经退出。以下示例把原部署完整备份到 `/path/to/booruflow-v087-backup`，从新公开仓库克隆 v0.88.0 到隔离导出目录 `/path/to/booruflow-v088-export-copy`，再把备份中的 `data/` 和 `.env` 复制进去。完整备份目录和隔离导出目录在复制前必须不存在或为空。`/path/to/booruflow-v088-target` 表示已经安装好 v0.88.0、业务数据库为空的新目标，不属于这两个复制目的地。

```bash
ditto "/path/to/booruflow-v087" "/path/to/booruflow-v087-backup"
git clone --branch v0.88.0 --depth 1 https://github.com/fzfz/booruflow.git "/path/to/booruflow-v088-export-copy"
ditto "/path/to/booruflow-v087-backup/data" "/path/to/booruflow-v088-export-copy/data"
cp "/path/to/booruflow-v087-backup/.env" "/path/to/booruflow-v088-export-copy/.env"
```

保留隔离目录中复制来的数据库，对照其 `.env.example` 编辑 `.env`：把旧配置中的用户设置填写到新示例对应变量，补齐 Embedding 与 Reranker 六项，并保留复制来的 `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY` 和其他凭据值。运行 `npm ci` 后直接执行 `runtime-data.mjs migrate`，由迁移命令升级这份数据库。

另按[安装](installation.md)使用 v0.88.0 安装器建立 `/path/to/booruflow-v088-target`，再按[配置](configuration.md)填写目标环境的 Embedding 与 Reranker 六项。保持目标应用停止，并确认其业务、关系、图片、向量和 KNN 表为空，然后按以下顺序完成迁移、导出、打包和导入：

```bash
npm --prefix "/path/to/booruflow-v088-export-copy" ci
node "/path/to/booruflow-v088-export-copy/scripts/runtime-data.mjs" migrate --root "/path/to/booruflow-v088-export-copy"
bash "/path/to/booruflow-v088-export-copy/data-export.sh" --output "/path/to/v088-export"
bash "/path/to/booruflow-v088-export-copy/data-pack.sh" --input "/path/to/v088-export" --output "/path/to/v088-data.tar.gz"
bash "/path/to/booruflow-v088-target/data-import.sh" --input "/path/to/v088-data.tar.gz" --check
bash "/path/to/booruflow-v088-target/data-import.sh" --input "/path/to/v088-data.tar.gz" --apply
```

迁移命令把隔离副本从迁移 039 升级到 040。Windows 先按旧部署原有方法停机并确认退出，再在命令提示符运行以下命令；完整备份目录和隔离导出目录开始时必须不存在或为空：

```bat
robocopy "C:\path\to\booruflow-v087" "C:\path\to\booruflow-v087-backup" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
git clone --branch v0.88.0 --depth 1 https://github.com/fzfz/booruflow.git "C:\path\to\booruflow-v088-export-copy"
robocopy "C:\path\to\booruflow-v087-backup\data" "C:\path\to\booruflow-v088-export-copy\data" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
copy /Y "C:\path\to\booruflow-v087-backup\.env" "C:\path\to\booruflow-v088-export-copy\.env"
```

确认每个 `robocopy` 的退出码为 0–7；8 或更高表示复制失败，必须停止。保留隔离目录中复制来的数据库，按新 `.env.example` 把旧用户设置写入隔离目录 `.env`，补齐六个模型服务变量，并保留原加密密钥与凭据。运行 `npm ci` 后直接执行 `runtime-data.mjs migrate`，然后继续执行以下命令：

```bat
call npm --prefix "C:\path\to\booruflow-v088-export-copy" ci
node "C:\path\to\booruflow-v088-export-copy\scripts\runtime-data.mjs" migrate --root "C:\path\to\booruflow-v088-export-copy"
call "C:\path\to\booruflow-v088-export-copy\data-export.bat" --output "C:\path\to\v088-export"
call "C:\path\to\booruflow-v088-export-copy\data-pack.bat" --input "C:\path\to\v088-export" --output "C:\path\to\v088-data.tar.gz"
call "C:\path\to\booruflow-v088-target\data-import.bat" --input "C:\path\to\v088-data.tar.gz" --check
call "C:\path\to\booruflow-v088-target\data-import.bat" --input "C:\path\to\v088-data.tar.gz" --apply
```

目标安装已有业务数据时重新创建空安装，不执行合并。任何复制、依赖安装、升级或导出失败都停止后续步骤；保留完整备份，重新创建隔离目录再开始。原部署目录始终保持原样。
