# Application boundaries

`app/config/` loads structured configuration. `app/server/` assembles HTTP services. `app/catalog/` owns catalog access and database connections; `app/vector/` owns semantic projections, model clients and vector maintenance. `app/data-package/` handles portable resource records, validation and import transactions.

The public listener exposes management pages, management APIs and media. Internal Catalog/Source interfaces use the loopback listener. Host and port defaults come from `config/defaults.json`.

Platform scripts own installation, environment checks, Git operations and process management. Application data modules own database operations. External clients access the documented HTTP/CLI interfaces. See [architecture](../docs/en/development/architecture.md) and [contracts](../docs/en/development/contracts.md).
