# Troubleshooting

Each entry follows symptom, check, action, success test, and issue evidence.

## Installation tools and network

- **Node/npm/Git missing or PATH error:** the installer reports missing, unsupported, or failed commands. Run `node --version`, `npm --version`, and `git --version`; install the required version from the official page printed by the script, open a new terminal, and rerun. All three commands and `check` passing confirms success. Otherwise attach OS/CPU, command output, and installation method.
- **Clone or network failure:** installation stops while reading the repository or tag. Run `git ls-remote https://github.com/fzfz/booruflow.git`; fix network, proxy, or tag input, remove only the incomplete directory identified by the script, and retry. Successful tag checkout confirms the fix. Otherwise attach URL, tag, Git output, and directory state.
- **Installation-directory conflict:** the script reports a nonempty directory. Choose an empty directory, or use update for an existing BooruFlow copy. The installation summary confirming the directory is success. Otherwise attach the input path and a sanitized file listing.
- **`npm ci` failure:** record npm output and check Node version and write access. Repair Node/npm or network access and rerun the installer. Installed dependencies and a passing check confirm success. Otherwise attach Node/npm versions and the complete error.

## Startup and content

- **Port occupied:** start identifies the public or internal port. Run status, stop the matching instance or choose unused `.env` ports, then restart. Status showing both expected ports confirms success. Otherwise attach ports, status, and start output.
- **Incomplete configuration:** check lists Embedding or Reranker variables. Fill all six values from [Configuration](configuration.md) and restart. A passing check confirms success. Otherwise attach variable names with example secrets.
- **Vector-service failure:** search or import reports timeout, service error, wrong count, or dimension. Check URL, model, authentication, and service logs; the Embedding response must contain one 1,024-dimensional vector per input. A successful retry confirms the fix. Otherwise attach stage, resource type, source ID, and a redacted response summary.
- **Missing image:** open resource details, compare the image record with the media file, and check `data/` permissions. Re-add the image or restore from a matching backup. Both thumbnail and original loading confirms success. Otherwise attach resource ID, page, request error, and relative path.

## Update and package

- **Update failure:** keep the application stopped and the reported backup. Follow the specific local-change, version, dependency, migration, or health-check remedy, or run restore. Passing check, start, and version display confirms recovery. Otherwise attach source/target versions, stage, and backup ID.
- **Target database is not empty:** import lists tables and counts. Use a newly initialized empty database; do not delete individual rows to bypass the check. Passing `--check` confirms success. Otherwise attach table names, counts, and database version.
- **Package validation failure:** recreate export and archive from a stopped source application after checking the named missing file, format, version, reference, media, or path problem. A zero `--check` exit confirms success. Otherwise attach package format, failed object, relative path, and output.

If the problem remains, follow [Support](../community/support.md) and choose the support or bug template.
