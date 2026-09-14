#!/bin/bash

BF_SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
. "$BF_SCRIPT_DIRECTORY/scripts/platform/macos/operations.sh" || exit 1
bf_main 'check' "$@"
exit $?
