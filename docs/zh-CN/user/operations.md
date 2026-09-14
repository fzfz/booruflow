# 日常运行

脚本根据自身位置找到安装目录。Windows 运行 `.bat`，macOS 使用 `bash 文件名.sh`。

- `start` 检查 Node/npm、依赖、配置和端口，在可见终端启动应用，并显示公共地址与日志位置。
- `status` 显示当前安装实例的进程、监听端口和访问地址。
- `stop` 只识别当前安装实例，请求正常关闭并等待 HTTP 与数据库关闭。
- `check` 检查命令版本、目录权限、配置、端口、归档工具、SQLite 扩展和数据库状态。
- `backup` 与 `restore` 在应用停止时处理匹配的数据库、媒体、清理队列和配置。

运行例子：`start.bat`、`status.bat`、`stop.bat`；macOS 对应 `bash start.sh`、`bash status.sh`、`bash stop.sh`。按 Ctrl+C 时等待正常关闭提示。重复启动、端口被占用或停止超时会返回非零状态并指出对象。

结构化日志位于 `data/` 下 `NOOBAI_LOG_DIRECTORY` 指定的目录，默认 `data/diagnostics/`。调整 `.env` 后停止并重新启动，再用状态和检查脚本验证新值。日志包含本机请求诊断信息；提交 Issue 前替换凭据和个人路径。
