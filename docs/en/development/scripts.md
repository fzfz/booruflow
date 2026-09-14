# Script directories and maintenance commands

## Choose paths for your version

The current source tree places Windows user commands in `bin/windows/` and macOS commands in `bin/macos/`. From the installation root, run `bin\windows\start.bat` or `bash bin/macos/start.sh`. Use the corresponding file in that directory for other operations. Arguments are defined in [Operations](../user/operations.md), [Updates and recovery](../user/update-recovery.md), and [Data transfer](../user/data-transfer.md).

The published v0.88.0 release keeps these commands at the repository root. Root-level commands in installation and user guides apply to that release. For the current source tree, replace each script path with its platform directory above. Release attachments keep the standalone filenames `install.bat` and `install.sh`. See [Installation](../user/installation.md) for installation-directory selection.

Use the installer attached to the target release. The installer in the current source targets the `bin/` layout; use the original v0.88.0 attachment to install that version.

## Purpose of retained scripts

| Location | Purpose |
| --- | --- |
| `scripts/runtime-data.mjs` | Internal entry point for initialization, upgrades, export, package validation, and import. |
| `scripts/start-local-app.mjs` | Application startup and graceful shutdown. |
| `scripts/prod-backup.mjs`, `scripts/prod-restore.mjs` | Database, media, and configuration backup and recovery. |
| `scripts/platform/` | Shared platform implementations called by native user scripts. |
| `scripts/catalog/` | Catalog queries, ComfyUI source reads, and CLI installation. |
| `scripts/maintenance/` | Vector rebuilding for six resource types. |
| `scripts/testing/` | Test runners, contract checks, isolated test applications, and cross-platform data exchange verification. |
| `scripts/docs/capture-screenshots.mjs` | Documentation screenshots generated from isolated sample data. |
| `scripts/release/tag.mjs` | Maintainer tag creation and push through `npm run release:tag -- vX.Y.Z`. |

See [Testing](testing.md) for contributor checks, [Catalog/Source](catalog-source.md) for query commands, and [Releases](releases.md) for publication steps.

## Rebuild vectors

When search vectors need regeneration, maintainers stop the application, complete a backup, check [model configuration](../user/configuration.md), and run the required command from the installation root:

```bash
node scripts/maintenance/rebuild-work-vectors.mjs --database data/app.sqlite --media-root data/media
```

Replace `work` in the filename with `character`, `style`, `prompt-term`, `generation-lora`, or `artist-prompt-string` for the corresponding resource. When `--reset` is omitted and the model name is unchanged, the command reuses existing vectors of valid length, repairs missing or inconsistent KNN entries, and calls the model for missing or invalid-length vectors. Use `--reset` to force re-embedding of resource content. With `--reset` or a changed model name, the command first deletes that resource type's vectors and KNN entries, then rebuilds them individually. Failures retain completed records, so confirm that a backup is available before running it. Check the output's `failures` and process exit code, resolve reported problems, then start the app and verify search. Data-package import builds vectors synchronously; follow [Data transfer](../user/data-transfer.md) for that operation.
