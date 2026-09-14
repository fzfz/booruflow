# 本地测试入口

执行 `npm run test:step-04` 可运行步骤 04 的零依赖测试。测试只读取仓库内固定样本，不启动监听器、不运行 Skill，也不访问网络。

`unit/` 验证配置、监听边界和样本；`contract/` 验证目录归属与 Skill 存储边界；`integration/`、`e2e/` 与 `reports/` 为后续步骤预留。
