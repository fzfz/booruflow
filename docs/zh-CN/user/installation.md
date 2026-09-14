# 安装

## 要求

BooruFlow v0.88.0 的原生脚本面向 Windows x64 与 macOS arm64/x64。安装需要 Node.js 24.21.0 或更高版本、npm 10.9.3 或更高版本、Git 2.55.0 或更高版本。安装脚本还会检查 `tar` 和 SQLite 向量扩展；准确版本要求以 `config/release/release.json` 为唯一来源。Release 页面列出该版本已经实际验证的平台。

## 平台安装脚本

从 [v0.88.0 Release](https://github.com/fzfz/booruflow/releases/tag/v0.88.0) 下载 `install.bat` 或 `install.sh`。Windows 可双击 `install.bat` 或在终端运行它；macOS 在下载目录运行：

```bash
bash install.sh
```

脚本把启动时的当前目录显示为默认安装目录。直接回车使用该目录，也可以输入绝对路径或相对该目录的路径。确认版本后，脚本检查系统、CPU、写入权限、Node、npm 和 Git，随后从 `fzfz/booruflow` 克隆对应标签、运行 `npm ci`、创建 `.env`、生成本机 ComfyUI 凭据加密密钥并建立空数据库。

缺少 Node 或 Git 时，脚本会显示所需版本、官方安装入口和重新运行步骤并退出。安装软件并确认 PATH 生效后，重新运行同一个脚本。目标目录已有 BooruFlow 时使用更新脚本；目录含其他文件时换用空目录。

安装完成后，在 `.env` 填写 [配置指南](configuration.md)要求的 Embedding 和 Reranker 值。看到“安装完成”以及安装目录、版本和启动脚本路径即表示文件安装成功；“配置待填写”表示必须先完成模型服务配置。
