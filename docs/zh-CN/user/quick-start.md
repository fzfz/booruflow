# 快速开始

本文的根目录命令适用于已发布的 v0.88.0；当前源码使用 `bin/`，对应路径见 [脚本目录与维护命令](../development/scripts.md).

完成[安装](installation.md)和[配置](configuration.md)后，选择一种起点。

手动建立目录时，运行 `start.bat` 或 `bash start.sh`，打开状态输出中的公共地址。进入管理首页，先创建底模，再创建作品、角色和画风；模型关联底模，LoRA 关联底模与模型。使用各页搜索框确认记录，打开卡片详情并添加图片。

导入示例包或另一个 v0.88.0 安装的数据时，保持应用停止，先运行数据包检查，再执行导入。v0.87.0 来源必须先按[更新与恢复](update-recovery.md#把数据迁入新的-v0880-安装)在隔离副本升级到迁移 040，并用 v0.88.0 脚本导出：

```bash
bash data-import.sh --input /path/to/package.tar.gz --check
bash data-import.sh --input /path/to/package.tar.gz --apply
bash start.sh
```

Windows 使用同名 `.bat`。导入仅接受已初始化但没有业务数据的空数据库，并同步生成六类资源的 1,024 维向量。成功后启动应用，搜索已导入名称，打开详情并确认图片、封面和资源关系。命令返回零、状态显示应用运行、浏览器能显示管理首页和资源详情即完成首次使用。
