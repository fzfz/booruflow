# Catalog 与 Source 集成

应用运行后，内部接口只在 `NOOBAI_INTERNAL_PORT` 的回环地址提供服务。Catalog 用于搜索或读取底模、模型、LoRA、作品、角色、画风、Prompt Tag、画师串、ComfyUI 实例与模板；Source 用稳定 ID 读取完整的 ComfyUI 实例连接信息或模板包。调用前读取发现文档，不要硬编码未发现的操作。

Catalog CLI 例子：

```bash
node scripts/imagegen-semantic-query.mjs --port 18083 --discovery-json
node scripts/imagegen-semantic-query.mjs --port 18083 --path /internal/semantic/characters --mode search --query frieren --page 1 --page_size 20
node scripts/imagegen-semantic-query.mjs --port 18083 --path /internal/semantic/characters --mode lookup --id 12
```

Source CLI 例子：

```bash
node scripts/imagegen-comfyui-source-read.mjs --port 18083 --discovery-json
node scripts/imagegen-comfyui-source-read.mjs --port 18083 instance --id 31
node scripts/imagegen-comfyui-source-read.mjs --port 18083 template-bundle --id 7
```

搜索请求可按发现合同使用 `query`、`page`、`page_size` 及资源特定筛选；lookup 使用稳定 `id`。成功时 CLI 原样输出 JSON。参数错误、连接失败、超时、HTTP 错误或合同响应错误返回非零退出码；记录错误码和 stderr，确认应用状态、内部端口与发现响应后再重试。完整字段以 `schema/api/openapi.yaml` 和实时发现结果为准。
