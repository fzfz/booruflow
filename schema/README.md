# Machine contracts

This directory is the authoritative source for application data structures and interfaces.

| Directory or file | Purpose |
|---|---|
| [api/openapi.yaml](api/openapi.yaml) | Management, Catalog and Source HTTP operations and payloads |
| [api/error-catalog.json](api/error-catalog.json) | HTTP error codes and messages |
| [database/](database/) | Ordered SQL migrations, constraints, indexes and triggers |
| [data-package/](data-package/) | Portable package manifest, batch journal and table definitions |
| [release/](release/) | Release configuration structure |
| [docs/](docs/) | Documentation locale structure |
| [crawler/](crawler/) | Explicit maintenance crawler input and output structures |
| [file-cleanup.schema.json](file-cleanup.schema.json) | Deferred media cleanup records |

Read [database notes](database/SCHEMA_NOTES.md) for migration entry points and [developer contracts](../docs/en/development/contracts.md) for the change workflow.
