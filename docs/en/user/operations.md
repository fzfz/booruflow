# Operations

Installed scripts locate the application from their own path. Run `.bat` files on Windows and `bash name.sh` on macOS.

- `start` checks Node/npm, dependencies, configuration, and ports; starts in a visible terminal; and displays the public URL and log location.
- `status` displays this installation's process, listening ports, and access URL.
- `stop` identifies this installation, requests graceful shutdown, and waits for HTTP and SQLite to close.
- `check` validates tool versions, permissions, configuration, ports, archive support, the SQLite extension, and database state.
- `backup` and `restore` operate on the matching database, media, cleanup queue, and configuration while the application is stopped.

Examples are `start.bat`, `status.bat`, and `stop.bat`, or `bash start.sh`, `bash status.sh`, and `bash stop.sh`. After Ctrl+C, wait for the shutdown message. Duplicate starts, occupied ports, and shutdown timeouts return nonzero status with the affected object.

`NOOBAI_LOG_DIRECTORY` defaults to the value `diagnostics`. Because the value is resolved relative to `data/`, the resulting default log path is `data/diagnostics/`. After changing `.env`, stop and restart, then verify with status and check. Replace credentials and personal paths before attaching logs to an issue.
