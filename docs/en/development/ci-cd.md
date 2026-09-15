# CI/CD gates

## Merge code

Contributors merge changes into `main` through pull requests. The GitHub `main CI gate` rule requires an up-to-date branch, resolved review threads, and a successful `CI Gate` check from GitHub Actions. That check aggregates Windows, macOS Apple Silicon, macOS Intel, and cross-platform data exchange results. Any failed, cancelled, or skipped prerequisite fails the gate.

The rule requires zero approvals from other people so a sole maintainer can merge their own PR. Maintainers still follow the [PR guidelines](../community/pull-requests.md). The rule applies to administrators and requires linear history. Use squash or rebase merging, retain the main branch, and correct mistakes through new commits.

## Publish a version

Maintainers prepare a version using [Releases](releases.md), merge its changes through a PR, and then create a version tag. `Release checks` verifies the tag format, that its commit belongs to `main`, agreement between the package version, installer default tag, and data-package application version, and the presence of `docs/releases/vX.Y.Z.md`. Maintainers write that file according to the release-note requirements in [Releases](releases.md). The publishing script sends the complete file to GitHub as the release description.

`Release Gate` requires successful preflight checks, three-platform tests, actual tagged installation tests, and data exchange. The publishing job then enters the `github-release` environment and waits for `fzfz` to inspect the tag, commit, and check results in GitHub Actions and approve it. After approval, the job creates a draft, uploads `install.bat` and `install.sh`, and publishes the draft. Manual runs on ordinary branches execute checks only.

Existing public releases remain unchanged. If an upload failure leaves a draft, inspect and delete that incomplete draft before rerunning the failed job; the script rejects existing releases. The `immutable release tags` rule preserves every `v*` tag and its target. Use a new tag for a corrected version. Environment approval governs Actions publishing jobs; repository administrators can still change settings or operate releases manually.

## Inspect a failure

The PR page shows `CI Gate`; `Platform checks` in Actions provides detailed platform results. For a failed release, inspect the failed `Release checks` step, resolve the reported problem, and rerun the checks. See [Testing](testing.md) for test scope and coverage acceptance requirements.
