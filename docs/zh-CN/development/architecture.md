# 架构

BooruFlow 是本机 Node.js 应用。`app/server` 建立公共与内部监听；`app/http` 路由页面、媒体、Catalog 和 Source 请求；`app/catalog` 与各资源模块负责业务规则和 SQLite 访问；`app/vector` 生成六类语义文本、调用 Embedding/Reranker 并维护向量；`app/data-package` 处理资源包；`app/maintenance` 处理备份与恢复；`app/web` 保存当前中文界面。

`schema/` 是数据库、HTTP、错误和数据包结构的机器来源，`config/` 保存运行默认值和发布事实，平台根脚本组织安装与运维，`scripts/` 保存应用级确定性入口，`tests/` 按 unit、contract、integration 和 e2e 分层。

作品拥有角色；画风和 Prompt Tag 是可搜索描述资源；底模为模型、LoRA、画风和模板提供分类；LoRA 关联模型；画师串可关联画风；实例提供 ComfyUI 连接，模板保存 Workflow。媒体记录与资源分离，封面引用有序图片。业务表、关系、媒体、六类向量和 KNN 索引由资源包事务一起提交。

新增字段或接口先改[机器契约](contracts.md)。新增资源行为放入对应服务和仓储；跨资源规则放在拥有该不变量的服务；HTTP 层只做协议映射。共享结构从 Schema 或结构化配置读取。
