# 机器契约

当前数据库结构和递增迁移以 `schema/database/` 为唯一来源；数据包以 `schema/data-package/` 为来源；HTTP 方法、路径、请求响应与 operationId 以 `schema/api/openapi.yaml` 为来源；错误码以 `schema/api/error-catalog.json` 为来源；运行默认值以 `config/` 的结构化文件为来源；文档语言对应关系以 `docs/locales.json` 及 `schema/docs/locales.schema.json` 为来源。

修改顺序为：先修改对应 Schema 或结构化配置，再修改验证器与业务实现，然后补正常、异常和边界测试，最后同步四语用户/开发文档。已发布迁移文件保持原文，结构变化新增下一个迁移编号，并更新建库、升级和回滚测试。HTTP 变化必须双向核对实际路由与 OpenAPI；新错误由错误目录定义，前端从统一映射读取提示。

运行时可调整值及其覆盖顺序由[配置指南](../user/configuration.md)统一定义。跨模块共享字段、常量和模板保存在结构化来源。Markdown 用于解释用法；程序从对应的 Schema 或结构化配置读取结构化输入。
