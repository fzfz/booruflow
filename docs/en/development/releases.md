# Releases

Maintainers use semantic versions and `v`-prefixed Git tags. Structured data in `config/release/` defines the release facts used by installers, update sources, README links, and attachments.

Before release, update package version and all changelogs, confirm migration and recovery boundaries, and run contract, unit, integration, e2e, documentation-link, and platform-script checks. Declare only verified Windows/macOS architectures. Tag, package, supported database range, and data-package format must agree.

Attach standalone `install.bat` and `install.sh` files to the GitHub Release. Provide release notes in four languages with installation, verified platforms, and recovery links. After publication, fresh-clone the public URL and verify downloads, installation, configuration, start, status, stop, and same-version export/import.

On update failure, retain the backup and old-version identity; recovery restores matching code, database, media, and configuration. Verify recovery before preparing a fixed release. v0.88.0 begins this public repository's history.

[CI/CD gates](ci-cd.md)
