# Updates and recovery

Run status and stop the application. Use `update.bat --tag vX.Y.Z` or `bash update.sh --tag vX.Y.Z` to specify the target release tag. Before writing, the updater checks the Git installation, local changes, version direction, database version, and stopped state. It then creates a backup, fetches and checks out the tag, runs `npm ci`, upgrades the database, and performs a temporary health check. Start the application yourself after success.

Local modifications, downgrade requests, unknown database versions, and non-Git installations stop with a specific remedy. A failed update keeps the backup and identifiable old-version state. Pass the direct backup directory reported by update to `restore.bat --backup data/recovery/<backup-directory>` or `bash restore.sh --backup data/recovery/<backup-directory>`; the argument must name one direct child of `data/recovery/`. Restore replaces the matching code, database, media, and configuration. Run check, start, and verify the version and resources.

## Moving data into a new v0.88.0 installation

Packages support export and import at the same version. To move one v0.88.0 installation to another, stop the source and run `data-export` and `data-pack` there. Keep the configured target stopped, run `data-import --check` and `--apply` against its empty database, then start and verify it. See [Data transfer](data-transfer.md) for complete arguments.

A v0.87.0 deployment has neither the new repository's lifecycle scripts nor its `v0.88.0` tag. Stop it with the method used by that deployment and confirm its process and listening ports have exited. The following example makes a complete backup at `/path/to/booruflow-v087-backup`, clones v0.88.0 from the new public repository into the isolated export directory `/path/to/booruflow-v088-export-copy`, and copies `data/` and `.env` from the backup. The complete-backup and isolated-export directories must initially be absent or empty. `/path/to/booruflow-v088-target` represents a separately installed v0.88.0 target with an empty business database; it is not one of those copy destinations.

```bash
ditto "/path/to/booruflow-v087" "/path/to/booruflow-v087-backup"
git clone --branch v0.88.0 --depth 1 https://github.com/fzfz/booruflow.git "/path/to/booruflow-v088-export-copy"
ditto "/path/to/booruflow-v087-backup/data" "/path/to/booruflow-v088-export-copy/data"
cp "/path/to/booruflow-v087-backup/.env" "/path/to/booruflow-v088-export-copy/.env"
```

Preserve the copied database in the isolated directory. Compare its `.env` with the new `.env.example`, place the old deployment's user settings in the corresponding new variables, complete all six Embedding and Reranker values, and preserve `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY` and the other copied credentials. After `npm ci`, run `runtime-data.mjs migrate` directly so the migration upgrades that database.

Separately, follow [Installation](installation.md) and use the v0.88.0 installer to create `/path/to/booruflow-v088-target`. Complete all six Embedding and Reranker values for the target as described in [Configuration](configuration.md). Keep the target application stopped and confirm that its business, relationship, image, vector, and KNN tables are empty. Then run the migration, export, package, and import commands in this order:

```bash
npm --prefix "/path/to/booruflow-v088-export-copy" ci
node "/path/to/booruflow-v088-export-copy/scripts/runtime-data.mjs" migrate --root "/path/to/booruflow-v088-export-copy"
bash "/path/to/booruflow-v088-export-copy/data-export.sh" --output "/path/to/v088-export"
bash "/path/to/booruflow-v088-export-copy/data-pack.sh" --input "/path/to/v088-export" --output "/path/to/v088-data.tar.gz"
bash "/path/to/booruflow-v088-target/data-import.sh" --input "/path/to/v088-data.tar.gz" --check
bash "/path/to/booruflow-v088-target/data-import.sh" --input "/path/to/v088-data.tar.gz" --apply
```

The migration advances the isolated database from migration 039 to 040. On Windows, first stop the old deployment using its existing method and confirm it has exited. Run these commands in Command Prompt; the complete-backup and isolated-export directories must initially be absent or empty:

```bat
robocopy "C:\path\to\booruflow-v087" "C:\path\to\booruflow-v087-backup" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
git clone --branch v0.88.0 --depth 1 https://github.com/fzfz/booruflow.git "C:\path\to\booruflow-v088-export-copy"
robocopy "C:\path\to\booruflow-v087-backup\data" "C:\path\to\booruflow-v088-export-copy\data" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
copy /Y "C:\path\to\booruflow-v087-backup\.env" "C:\path\to\booruflow-v088-export-copy\.env"
```

Confirm each `robocopy` exit code is 0–7; 8 or greater is a copy failure and must stop the procedure. Preserve the copied database in the isolated directory. Update the isolated `.env` from the new `.env.example`, carry over the old user settings, complete all six model-service variables, and preserve the encryption key and credentials. After `npm ci`, run `runtime-data.mjs migrate` directly, then continue with these commands:

```bat
call npm --prefix "C:\path\to\booruflow-v088-export-copy" ci
node "C:\path\to\booruflow-v088-export-copy\scripts\runtime-data.mjs" migrate --root "C:\path\to\booruflow-v088-export-copy"
call "C:\path\to\booruflow-v088-export-copy\data-export.bat" --output "C:\path\to\v088-export"
call "C:\path\to\booruflow-v088-export-copy\data-pack.bat" --input "C:\path\to\v088-export" --output "C:\path\to\v088-data.tar.gz"
call "C:\path\to\booruflow-v088-target\data-import.bat" --input "C:\path\to\v088-data.tar.gz" --check
call "C:\path\to\booruflow-v088-target\data-import.bat" --input "C:\path\to\v088-data.tar.gz" --apply
```

Create another empty target instead of merging when the target contains business data. Stop after any copy, dependency, migration, or export failure; keep the complete backup and recreate the isolated directory before retrying. The original deployment directory remains unchanged throughout.
