# Configuration

BooruFlow reads defaults from `config/defaults.json` and `config/vector/models.json`, environment overrides from the installation `.env`, and adjustable script values from command arguments. Precedence is command arguments, environment variables, then structured defaults.

The platform installer creates `.env` in the installation directory with a unique `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY`. Edit that file and preserve the existing key. Copy `.env.example` to `.env` only for a source checkout where `.env` does not exist. `NOOBAI_PUBLIC_PORT` defaults to `18082`; the public listener is currently configured on `0.0.0.0`. `NOOBAI_INTERNAL_PORT` defaults to `18083`; internal Catalog and Source endpoints bind only to `127.0.0.1`. Select unused ports for each installation. `NOOBAI_LOG_*` controls level, directory, file size, and archive count; the log directory is relative to `data/`.

Semantic search and data-package import require all of these values:

- `NOOBAI_EMBEDDING_BASE_URL`, `NOOBAI_EMBEDDING_API_KEY`, `NOOBAI_EMBEDDING_MODEL`
- `NOOBAI_RERANKER_BASE_URL`, `NOOBAI_RERANKER_API_KEY`, `NOOBAI_RERANKER_MODEL`

The client removes trailing slashes from each `BASE_URL` and appends `/embeddings` or `/rerank`. Both calls are JSON `POST` requests with `Content-Type: application/json`, `Authorization: Bearer <API_KEY>`, and the `request_timeout_ms` from `config/vector/models.json`. The Embedding body is `{"model":"<EMBEDDING_MODEL>","input":["..."]}`. Its response must contain a `data` array with one item per input; every item has a continuous integer `index` starting at 0 and a numeric `embedding` array of 1,024 dimensions. The Reranker body is `{"model":"<RERANKER_MODEL>","query":"...","documents":["..."]}`. Its response must contain a `results` array with one item per candidate; every item has a unique in-range integer `index` and a finite numeric `relevance_score`. The application accepts this implemented protocol.

The services may use separate URLs and credentials. Keep real credentials in the `.env` of the installation they belong to. After an edit, stop and start the application, then run `check.bat` or `bash check.sh`. A passing check and the expected addresses in status output confirm the configuration.
