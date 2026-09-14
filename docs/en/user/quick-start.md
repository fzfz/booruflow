# Quick start

Finish [installation](installation.md) and [configuration](configuration.md), then choose how to begin.

For manual entry, run `start.bat` or `bash start.sh` and open the public address shown by the script. From the management home, create a base model first, then works, characters, and styles. Connect models to a base model and LoRAs to both a base model and a model. Search each page to confirm the record, open its details, and add images.

For a sample package or data from another v0.88.0 installation, keep the application stopped and run the commands below. A v0.87.0 source must first follow [Updates and recovery](update-recovery.md#moving-data-into-a-new-v0880-installation) to upgrade an isolated copy through migration 040 and export it with v0.88.0 scripts.

```bash
bash data-import.sh --input /path/to/package.tar.gz --check
bash data-import.sh --input /path/to/package.tar.gz --apply
bash start.sh
```

Use the matching `.bat` files on Windows. Import accepts only an initialized database with no business data and synchronously creates 1,024-dimensional vectors for six resource types. After a successful import, start the application, search for an imported name, open details, and verify images, covers, and relationships. A zero command exit, running status, and readable management pages complete the first run.
