# Machine contracts

`schema/database/` is the source for database structure and migrations; `schema/data-package/` for packages; `schema/api/openapi.yaml` for HTTP methods, paths, request/response shapes, and operation IDs; `schema/api/error-catalog.json` for errors; structured `config/` files for defaults; and `docs/locales.json` with `schema/docs/locales.schema.json` for language mapping.

Modify the Schema or configuration first, then validators and implementation, add normal/error/boundary tests, and update all four documentation languages. Published migration files remain unchanged; a structural change adds the next migration number and updates clean-build, upgrade, and rollback tests. Compare runtime routes and OpenAPI both ways. Define errors in the catalog and let the UI read its shared mapping.

[Configuration](../user/configuration.md) is the single definition for runtime-adjustable values and their precedence. Shared fields, constants, and templates belong in a structured source. Markdown explains use; programs read structured input from the corresponding Schema or structured configuration.
