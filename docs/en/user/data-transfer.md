# Data transfer

Stop the application. Export to a new directory and pack it:

```bash
bash data-export.sh --output /path/to/export-dir
bash data-pack.sh --input /path/to/export-dir --output /path/to/booruflow-data.tar.gz
```

Optional `--include-instances` exports only ComfyUI instance names and addresses; imported instances are disabled and require configuration. The package includes works, characters, styles, Prompt Tags, base models, models, LoRAs, artist prompt strings, relationships, templates, Workflow JSON, and media. Weight files, sessions, run history, logs, absolute paths, and credentials remain in the source environment.

The target must have the current schema and zero rows in every business, relationship, image, vector, and KNN table. Migration records and initialized `vector_spaces` metadata may exist. Configure the Embedding and Reranker service addresses, model names and authentication using [Configuration](configuration.md), then run:

```bash
bash data-import.sh --input /path/to/booruflow-data.tar.gz --check
bash data-import.sh --input /path/to/booruflow-data.tar.gz --apply
```

`--check` validates the empty database, configuration, format, version, paths, media, and references without writing. `--apply` checks emptiness again and follows the existing search rules while synchronously generating 1,024-dimensional vectors. Disabled works, disabled characters, and characters whose work is disabled retain their business records but do not enter the searchable vector set. All other normally searchable records among works, characters, styles, Prompt Tags, LoRAs, and artist prompt strings receive vectors. The command then commits records, media, vectors, and KNN indexes as one batch. A failure before commit rolls back the batch database writes and cleans its files. After a check or vector-preparation failure, or another pre-commit failure whose rollback and cleanup have completed, fix the reported problem and rerun the check and complete import. If execution is interrupted or cleanup fails after a batch ID has been printed, run `bash data-import.sh --recover --batch ID` with that ID. Recovery cleans an uncommitted batch; for a committed batch it preserves imported data and removes temporary files. Use matching `.bat` commands on Windows.

Any checked table with rows causes a nonzero exit listing its name and count. A completed import makes later imports fail the same empty-target check. v0.88.0 supports same-version packages and Windows/macOS interchange. Use a matching BooruFlow version for unknown or unsupported formats.
