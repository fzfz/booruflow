# Architecture

BooruFlow is a local Node.js application. `app/server` creates public and internal listeners; `app/http` routes pages, media, Catalog, and Source requests; `app/catalog` and resource modules own rules and SQLite access; `app/vector` builds semantic text for six resource types, calls Embedding/Reranker services, and maintains vectors; `app/data-package` handles packages; `app/maintenance` handles backup and recovery; `app/web` contains the current Chinese UI.

`schema/` is the machine source for database, HTTP, errors, and packages. `config/` stores runtime defaults and release facts. Root platform scripts organize installation and operations; `scripts/` contains deterministic application entry points; `tests/` separates unit, contract, integration, and e2e coverage.

Works contain characters. Styles and Prompt Tags are searchable description resources. Base models classify models, LoRAs, styles, and templates; LoRAs link to models; artist prompt strings may link to styles; instances provide ComfyUI connections; templates store Workflows. Media records are separate and covers reference ordered images. Package transactions commit business rows, relationships, media, six vector types, and KNN indexes together.

When adding fields or interfaces, change [contracts](contracts.md) first. Put resource behavior in its service and repository, cross-resource invariants in the owning service, and protocol mapping in HTTP. Read shared structures from Schema or structured configuration.
