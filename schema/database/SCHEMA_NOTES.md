# Database notes

The SQL files in this directory define the database structure. Follow [the migration change rules](../../docs/en/development/contracts.md) when changing the structure.

New installations initialize an empty database through `scripts/runtime-data.mjs init`, called by the native installer. The initializer executes the structural migration chain in memory, records skipped historical seed migrations and writes the resulting database. Existing v0.87.0 databases upgrade through `scripts/runtime-data.mjs migrate`, called by the update script. The normal startup entry opens only the current schema.

`schema_migrations` records applied migrations. `vector_spaces` holds initialization metadata. `schema/data-package/definition.json` lists the tables checked before import. `data_import_batches` records successful package commits in the same transaction as business records and vectors.

Resource constraints and ownership are enforced by the SQL tables and triggers. `item_images.media_path` is relative to the installation media root. Covers reference owned images; importing records restores covers after images exist. Vector writes maintain `vector_entries` and `vector_knn_index` together using `app/vector/vector-store.mjs`.

Read [data transfer](../../docs/en/user/data-transfer.md) for package operations and [update and recovery](../../docs/en/user/update-recovery.md) for full local backups. The crawler's separate structured input mapping is documented in [crawler/import-mapping.md](../crawler/import-mapping.md).
