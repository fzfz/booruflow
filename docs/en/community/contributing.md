# Contributing

Use [Installation](../user/installation.md) as the single user-facing source for development tools, versions, and platform preparation. Fork `fzfz/booruflow`, clone your fork, enter the repository, then run `npm ci` and `node scripts/runtime-data.mjs init --root "$PWD"`. If `.env` does not exist, copy `.env.example`; select separate development ports and fill all six Embedding/Reranker variables from [Configuration](../user/configuration.md), preserving any existing `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY`. Run `bash check.sh` and `bash start.sh` on macOS or `check.bat` and `start.bat` on Windows. After check passes and the management home opens, stop the application and create a short branch named for the goal. On Windows replace `"$PWD"` with the absolute checkout path, for example `node scripts\runtime-data.mjs init --root "C:\path\to\booruflow"`.

Keep one problem per pull request and preserve unrelated files. Small fixes may go directly to a PR. Open an issue first for HTTP, database, configuration-contract, or product-behavior changes. Change the machine source first, then implementation, tests, and docs. Cover normal, error, and boundary behavior.

Run affected tests and `npm test`; see [Testing](../development/testing.md). Four-language topics are mapped by `docs/locales.json`. When user behavior changes, update all four files with identical commands, parameters, fields, and defaults, and read each translation before marking it complete.

Push and use the [PR guide](pull-requests.md) to describe the problem, final behavior, scope, issue, and results. Use [Support](support.md) for environment or contribution help. Contributions are licensed under the repository [MIT License](../../../LICENSE).
