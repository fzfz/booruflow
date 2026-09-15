# 测试

先运行 `npm ci` 并为测试使用独立端口、临时数据库和固定样本。自动测试不得访问生产数据库、真实凭据、真实源站或真实模型服务。

主要命令为 `npm run test:unit`、`npm run test:contract`、`npm run test:integration`、`npm run test:migration`、`npm run test:native`、`npm run test:e2e:files` 和 `npm test`。`npm run check:test-boundaries` 检查静态测试边界，`npm run check:test-markdown` 检查测试没有把 Markdown 当作结构化数据。先运行受影响层，修改稳定后运行全量。

合同测试核对 Schema、OpenAPI、错误目录、迁移和启动路由；单元测试覆盖业务分支；集成测试验证模块组合与数据库事务；e2e 通过浏览器验证实际页面。平台脚本需在 Windows x64、macOS arm64/x64 对应环境测试安装、启停、更新、恢复和数据互导。新增行为覆盖正常、异常与边界分支。

开发验收要求行覆盖率至少 85%、分支至少 80%，事务、媒体恢复和查询客户端关键分支达到 100%。失败时保存命令、退出码、首个相关错误、测试层和产物路径；先修复确定原因，再重跑受影响检查。CI 保存每次运行结果。

上述覆盖率比例是开发验收要求。当前 CI 根据工作流中各测试任务的退出结果执行门禁，尚未自动计算这些覆盖率比例；维护者在 PR 中提供相应覆盖率证据。具体合并和发布门禁见 [CI/CD 门禁](ci-cd.md)。
