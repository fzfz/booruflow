# 配置

BooruFlow 从 `config/defaults.json` 和 `config/vector/models.json` 读取默认值，从安装目录 `.env` 读取环境覆盖，并由命令参数覆盖可调整的脚本值。优先级为：命令参数、环境变量、结构化默认配置。

平台安装器已经在安装目录生成 `.env` 和独立的 `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY`；直接编辑该 `.env` 并保留现有密钥。只有从源码准备环境且 `.env` 不存在时，才复制 `.env.example` 为 `.env`。`NOOBAI_PUBLIC_PORT` 默认 `18082`，公共页面监听配置当前为 `0.0.0.0`；`NOOBAI_INTERNAL_PORT` 默认 `18083`，内部 Catalog/Source 接口只监听 `127.0.0.1`。为每个安装选择未占用端口。日志级别、目录、单文件大小和归档数由 `NOOBAI_LOG_*` 调整；日志目录相对 `data/`。

语义检索和数据包导入要求同时配置：

- `NOOBAI_EMBEDDING_BASE_URL`、`NOOBAI_EMBEDDING_API_KEY`、`NOOBAI_EMBEDDING_MODEL`
- `NOOBAI_RERANKER_BASE_URL`、`NOOBAI_RERANKER_API_KEY`、`NOOBAI_RERANKER_MODEL`

客户端会去掉 `BASE_URL` 末尾的斜杠，并分别拼接 `/embeddings` 和 `/rerank`。两类请求均为 JSON `POST`，使用 `Content-Type: application/json` 和 `Authorization: Bearer <API_KEY>`，超时读取 `config/vector/models.json` 的 `request_timeout_ms`。Embedding 请求体为 `{"model":"<EMBEDDING_MODEL>","input":["..."]}`；响应必须包含 `data` 数组，每项包含从 0 连续对应输入的整数 `index` 和数字数组 `embedding`，每条向量为 1,024 维，条目数必须与输入数一致。Reranker 请求体为 `{"model":"<RERANKER_MODEL>","query":"...","documents":["..."]}`；响应必须包含 `results` 数组，并为每个候选返回唯一且范围内的整数 `index` 与有限数值 `relevance_score`，结果数必须与候选数一致。应用只接受上述实际协议。

两类服务可以使用不同地址和凭据。真实密钥保留在其所属安装环境的 `.env` 中。修改配置后先停止应用，再启动并运行 `check.bat` 或 `bash check.sh`；检查通过且状态命令显示预期地址时配置生效。
