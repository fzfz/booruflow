# Installation

Root-level commands here apply to published v0.88.0. The current source uses `bin/`; see [Script directories and maintenance commands](../development/scripts.md).

## Requirements

BooruFlow v0.88.0 provides native scripts targeting Windows x64 and macOS arm64/x64. Installation requires Node.js 24.21.0 or newer, npm 10.9.3 or newer, and Git 2.55.0 or newer. The installer also checks `tar` and the SQLite vector extension; `config/release/release.json` is the source for exact requirements. The Release page lists the platforms actually verified for that release.

Download `install.bat` or `install.sh` from the [v0.88.0 release](https://github.com/fzfz/booruflow/releases/tag/v0.88.0). Double-click or run `install.bat` on Windows. On macOS run:

```bash
bash install.sh
```

The script displays the directory where it was launched as the default installation directory. Press Enter to accept it, or enter an absolute path or a path relative to that launch directory. After version selection, the script checks the OS, CPU, write access, Node, npm, and Git; clones the selected tag from `fzfz/booruflow`; runs `npm ci`; creates `.env`; generates a local ComfyUI credential-encryption key; and initializes an empty database.

When Node or Git is missing, the script prints the required version, official installation page, and rerun instructions, then exits. Install the software, confirm PATH in a new terminal, and rerun the same script. Use the update script for an existing BooruFlow installation; choose an empty directory when unrelated files are present.

Finally, set the Embedding and Reranker values described in [Configuration](configuration.md). “Installation complete” with the directory, version, and start-script path confirms the files are installed. “Configuration pending” means model-service settings are still required.
