# Catalog and Source integration

While the application runs, internal APIs bind only to loopback on `NOOBAI_INTERNAL_PORT`. Catalog searches or reads base models, models, LoRAs, works, characters, styles, Prompt Tags, artist prompt strings, ComfyUI instances, and templates. Source reads a complete ComfyUI connection or template bundle by stable ID. Read discovery before calling an operation.

Catalog examples:

```bash
node scripts/imagegen-semantic-query.mjs --port 18083 --discovery-json
node scripts/imagegen-semantic-query.mjs --port 18083 --path /internal/semantic/characters --mode search --query frieren --page 1 --page_size 20
node scripts/imagegen-semantic-query.mjs --port 18083 --path /internal/semantic/characters --mode lookup --id 12
```

Source examples:

```bash
node scripts/imagegen-comfyui-source-read.mjs --port 18083 --discovery-json
node scripts/imagegen-comfyui-source-read.mjs --port 18083 instance --id 31
node scripts/imagegen-comfyui-source-read.mjs --port 18083 template-bundle --id 7
```

Search uses discovered `query`, `page`, `page_size`, and resource filters; lookup uses stable `id`. Success writes JSON to stdout. Invalid arguments, connection failures, timeouts, HTTP errors, and contract errors return nonzero. Record the code and stderr, then check application status, internal port, and discovery. Refer to `schema/api/openapi.yaml` and live discovery for complete fields.
