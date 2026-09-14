# 贡献指南

开发工具、版本和平台准备以[安装指南](../user/installation.md)为唯一用户说明。Fork `fzfz/booruflow` 并 clone 自己的 fork 后进入仓库，依次运行 `npm ci` 和 `node scripts/runtime-data.mjs init --root "$PWD"`。`.env` 不存在时复制 `.env.example`，为开发实例选择独立端口，并填写[配置指南](../user/configuration.md)中的六个 Embedding/Reranker 变量；保留已有的 `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY`。macOS 运行 `bash check.sh` 和 `bash start.sh`，Windows 运行 `check.bat` 和 `start.bat`。检查通过且管理首页能打开后停止应用，再创建描述目标的短分支。Windows 初始化命令把 `"$PWD"` 换为仓库绝对路径，例如 `node scripts\runtime-data.mjs init --root "C:\path\to\booruflow"`。

把每个 PR 限定为一个问题，保留无关文件。小修复可直接提交；接口、数据库、配置合同或产品行为变化先开 Issue 明确目标。修改机器契约时先改唯一来源，再同步实现、测试和文档。新增行为必须测试正常、异常与边界分支。

提交前运行受影响测试以及 `npm test`；开发命令与测试层见[测试指南](../development/testing.md)。四语文档共享 `docs/locales.json` 的主题对应关系。修改用户行为时同步四个语言文件；保留命令、参数、字段和默认值一致，并把翻译状态设为 `complete` 前逐篇阅读。

推送分支并按[PR 规范](pull-requests.md)填写问题、最终行为、范围、关联 Issue 和验证结果。遇到环境或贡献流程问题，按[求助指南](support.md)提交材料。本项目代码与文档按根目录 [MIT License](../../../LICENSE) 授权。
