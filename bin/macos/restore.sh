#!/bin/bash

BF_SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
BF_ROOT=$(CDPATH= cd -- "$BF_SCRIPT_DIRECTORY/../.." && pwd -P) || exit 1
. "$BF_ROOT/scripts/platform/macos/operations.sh" || exit 1
bf_main 'restore' "$@"
exit $?
