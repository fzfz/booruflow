# 人工采集与导入

这里保存人工启动的来源采集说明和显式命令。站点服务不会导入本模块，也不会自动启动采集。

采集交换契约位于 `schema/crawler/`。真实来源、采集脚本和运行权限需要单独批准。

人工命令：

```sh
node ingest/manual/run-2x-nz-crawlee.mjs
node ingest/manual/run-2x-nz-crawlee.mjs --resume
node ingest/manual/run-2x-nz-crawlee.mjs --compensate-skipped
node ingest/manual/run-downloadmost.mjs --data-root <controlled-data-root>
```

2x.nz 采集器的普通运行和断点续传只使用前两个命令；`--resume` 会直接接管任何未完成失败断点并继续处理断点队列，续跑过程仍按当前采集逻辑处理新的错误；补偿明确跳过项时才使用第三个命令。`downloadmost` 入口单独使用 `--data-root`。命令会写入对应数据目录下的 `app.sqlite`、`crawl_state.json`、`reports/` 和 `raw/`，文件路径经过受控根目录检查。运行器按发现、详情、图片、持久化、报告五阶段执行，保存断点与报告；来源白名单和配置边界在人工入口校验。验证码、受限访问、认证过期、5xx、超时、页面指令、隐藏内容、控制字符、脚本内容、编码内容、结构变化和致命持久化错误立即停止。本轮未返回的旧对象保持原样。

程序入口为 `app/ingest/manual-ingest.mjs` 的 `createManualIngestRunner`。创建运行器只准备人工任务，必须显式调用 `run()` 或 `resume()` 才会执行。
