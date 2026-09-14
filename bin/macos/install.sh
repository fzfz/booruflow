#!/bin/bash

set -u

# These release defaults are generated from config/release/release.json so this
# file can be downloaded and run before the repository exists.
BF_PROJECT_NAME='BooruFlow'
BF_REPOSITORY_HTTPS='https://github.com/fzfz/booruflow.git'
BF_DEFAULT_TAG='v0.88.0'
BF_NODE_MINIMUM='24.21.0'
BF_NPM_MINIMUM='10.9.3'
BF_GIT_MINIMUM='2.55.0'
BF_NODE_DOWNLOAD_URL='https://nodejs.org/en/download'
BF_GIT_DOWNLOAD_URL='https://git-scm.com/downloads'
BF_INSTALLER_PATH=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")

bf_install_fail() {
  printf 'Installation failed: %s\n' "$1" >&2
  printf 'Resolve the reported problem, then run this installer again.\n' >&2
  exit 1
}

bf_install_usage() {
  printf 'Usage: bash install.sh [--directory PATH] [--tag vX.Y.Z]\n'
}

bf_version_at_least() {
  awk -v actual="$1" -v required="$2" 'BEGIN {
    sub(/^v/, "", actual); sub(/[^0-9.].*$/, "", actual)
    split(actual, a, "."); split(required, r, ".")
    for (i = 1; i <= 3; i++) {
      av = (a[i] == "" ? 0 : a[i]) + 0
      rv = (r[i] == "" ? 0 : r[i]) + 0
      if (av > rv) exit 0
      if (av < rv) exit 1
    }
    exit 0
  }'
}

bf_require_tool() {
  bf_tool_name=$1
  bf_tool_minimum=$2
  bf_tool_url=$3
  if ! command -v "$bf_tool_name" >/dev/null 2>&1; then
    printf '%s is missing or PATH does not contain its executable.\n' "$bf_tool_name" >&2
    printf 'Required version: %s or later. Official installer: %s\n' "$bf_tool_minimum" "$bf_tool_url" >&2
    bf_install_fail "$bf_tool_name is required"
  fi
  bf_tool_version=$($bf_tool_name --version 2>/dev/null)
  bf_tool_status=$?
  if [ "$bf_tool_status" -ne 0 ] || [ -z "$bf_tool_version" ]; then
    printf '%s exists on PATH but its version command failed.\n' "$bf_tool_name" >&2
    printf 'Repair the installation from %s and open a new terminal.\n' "$bf_tool_url" >&2
    bf_install_fail "$bf_tool_name could not run"
  fi
  bf_numeric_version=$(printf '%s\n' "$bf_tool_version" | sed -n 's/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
  if [ -z "$bf_numeric_version" ] || ! bf_version_at_least "$bf_numeric_version" "$bf_tool_minimum"; then
    printf '%s version is unsupported: %s\n' "$bf_tool_name" "$bf_tool_version" >&2
    printf 'Required version: %s or later. Official installer: %s\n' "$bf_tool_minimum" "$bf_tool_url" >&2
    bf_install_fail "$bf_tool_name must be upgraded"
  fi
  printf '%s: %s\n' "$bf_tool_name" "$bf_tool_version"
}

bf_nearest_existing_directory() {
  bf_probe=$1
  while [ ! -d "$bf_probe" ]; do
    bf_next=$(dirname "$bf_probe")
    [ "$bf_next" = "$bf_probe" ] && return 1
    bf_probe=$bf_next
  done
  printf '%s\n' "$bf_probe"
}

BF_STARTUP_CWD=$(pwd -P) || bf_install_fail 'the startup working directory cannot be resolved'
BF_DIRECTORY=''
BF_TAG=$BF_DEFAULT_TAG
BF_REPOSITORY=$BF_REPOSITORY_HTTPS

while [ "$#" -gt 0 ]; do
  case "$1" in
    --directory)
      [ "$#" -ge 2 ] || bf_install_fail '--directory requires a path'
      BF_DIRECTORY=$2
      shift 2
      ;;
    --tag)
      [ "$#" -ge 2 ] || bf_install_fail '--tag requires vX.Y.Z'
      BF_TAG=$2
      shift 2
      ;;
    --help|-h)
      bf_install_usage
      exit 0
      ;;
    *) bf_install_fail "unknown argument: $1" ;;
  esac
done

printf '%s installer\n' "$BF_PROJECT_NAME"
printf 'Startup working directory and default installation directory: %s\n' "$BF_STARTUP_CWD"
if [ -z "$BF_DIRECTORY" ]; then
  printf 'Press Enter to use the default directory, or enter another installation directory: '
  IFS= read -r BF_DIRECTORY || BF_DIRECTORY=''
fi
[ -n "$BF_DIRECTORY" ] || BF_DIRECTORY=$BF_STARTUP_CWD
case "$BF_DIRECTORY" in
  /*) BF_DESTINATION=$BF_DIRECTORY ;;
  *) BF_DESTINATION=$BF_STARTUP_CWD/$BF_DIRECTORY ;;
esac
printf 'Final installation directory: %s\n' "$BF_DESTINATION"

BF_OS=$(uname -s 2>/dev/null) || bf_install_fail 'the operating system could not be detected'
BF_ARCH=$(uname -m 2>/dev/null) || bf_install_fail 'the CPU architecture could not be detected'
[ "$BF_OS" = 'Darwin' ] || bf_install_fail "this installer supports macOS; detected $BF_OS"
case "$BF_ARCH" in
  arm64|x86_64) ;;
  *) bf_install_fail "this installer supports macOS arm64 and x86_64; detected $BF_ARCH" ;;
esac
printf 'Platform: %s %s\n' "$BF_OS" "$BF_ARCH"

BF_WRITABLE_PARENT=$(bf_nearest_existing_directory "$BF_DESTINATION") || bf_install_fail 'no existing parent directory was found'
[ -w "$BF_WRITABLE_PARENT" ] || bf_install_fail "installation parent is not writable: $BF_WRITABLE_PARENT"

bf_require_tool node "$BF_NODE_MINIMUM" "$BF_NODE_DOWNLOAD_URL"
bf_require_tool npm "$BF_NPM_MINIMUM" "$BF_NODE_DOWNLOAD_URL"
bf_require_tool git "$BF_GIT_MINIMUM" "$BF_GIT_DOWNLOAD_URL"
command -v tar >/dev/null 2>&1 || bf_install_fail 'macOS system tar is missing from PATH'
BF_TAR_VERSION=$(tar --version 2>/dev/null)
[ -n "$BF_TAR_VERSION" ] || bf_install_fail 'macOS system tar exists but cannot run its version check'
printf 'tar: %s\n' "$BF_TAR_VERSION"

case "$BF_REPOSITORY" in
  https://*) ;;
  *) bf_install_fail 'the repository must use an HTTPS URL' ;;
esac
printf '%s\n' "$BF_TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || bf_install_fail 'the release tag must use vX.Y.Z form'
printf 'Repository: %s\nRelease tag: %s\n' "$BF_REPOSITORY" "$BF_TAG"
git ls-remote --exit-code --tags "$BF_REPOSITORY" "refs/tags/$BF_TAG" >/dev/null 2>&1 || bf_install_fail "repository or release tag is unavailable: $BF_TAG"

BF_INSTALL_IN_PLACE=0
if [ -e "$BF_DESTINATION" ]; then
  [ -d "$BF_DESTINATION" ] || bf_install_fail 'the installation path exists and is not a directory'
  if [ -d "$BF_DESTINATION/.git" ] && [ -f "$BF_DESTINATION/package.json" ]; then
    bf_install_fail "an existing installation was found; run bash \"$BF_DESTINATION/bin/macos/update.sh\""
  fi
  if [ -n "$(ls -A "$BF_DESTINATION" 2>/dev/null)" ]; then
    BF_ENTRY_COUNT=$(find "$BF_DESTINATION" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')
    if [ "$BF_ENTRY_COUNT" -eq 1 ] && [ -f "$BF_DESTINATION/install.sh" ] && [ ! -L "$BF_DESTINATION/install.sh" ] && [ "$BF_INSTALLER_PATH" = "$BF_DESTINATION/install.sh" ]; then
      BF_INSTALL_IN_PLACE=1
    else
      bf_install_fail 'the installation directory contains files other than this installer'
    fi
  fi
fi

printf 'Cloning %s at %s...\n' "$BF_REPOSITORY" "$BF_TAG"
BF_CLONE_DESTINATION=$BF_DESTINATION
if [ "$BF_INSTALL_IN_PLACE" -eq 1 ]; then
  BF_CLONE_DESTINATION=$BF_DESTINATION.clone.$$
  [ ! -e "$BF_CLONE_DESTINATION" ] || bf_install_fail 'the temporary clone directory already exists'
fi
if ! git clone --branch "$BF_TAG" --depth 1 "$BF_REPOSITORY" "$BF_CLONE_DESTINATION"; then
  printf 'Clone stopped while writing: %s\n' "$BF_CLONE_DESTINATION" >&2
  bf_install_fail 'git clone failed; inspect or remove the remaining target directory before retrying'
fi
BF_CLONED_INSTALLER_RELATIVE='bin/macos/install.sh'
BF_START_RELATIVE='bin/macos/start.sh'
[ -f "$BF_CLONE_DESTINATION/$BF_CLONED_INSTALLER_RELATIVE" ] || bf_install_fail "the selected release does not use the current macOS bin layout; remove \"$BF_CLONE_DESTINATION\", then download $BF_TAG's published install.sh attachment and run it with another empty installation directory"
[ -f "$BF_CLONE_DESTINATION/$BF_START_RELATIVE" ] || bf_install_fail "the selected release is missing its macOS start script: $BF_START_RELATIVE"
if [ "$BF_INSTALL_IN_PLACE" -eq 1 ]; then
  cmp -s "$BF_INSTALLER_PATH" "$BF_CLONE_DESTINATION/$BF_CLONED_INSTALLER_RELATIVE" || bf_install_fail "the installer differs from $BF_TAG; download that tag's install.sh or choose another empty installation directory"
  for BF_CLONED_ENTRY in "$BF_CLONE_DESTINATION"/.[!.]* "$BF_CLONE_DESTINATION"/..?* "$BF_CLONE_DESTINATION"/*; do
    [ -e "$BF_CLONED_ENTRY" ] || continue
    mv "$BF_CLONED_ENTRY" "$BF_DESTINATION/" || bf_install_fail 'the temporary clone could not be moved into the installation directory'
  done
  rm -f "$BF_INSTALLER_PATH" || bf_install_fail 'the downloaded root installer could not be removed after installing the nested entrypoint'
  rmdir "$BF_CLONE_DESTINATION" || bf_install_fail 'the empty temporary clone directory could not be removed'
fi

[ -f "$BF_DESTINATION/package.json" ] || bf_install_fail 'the cloned release is missing package.json'
[ -f "$BF_DESTINATION/package-lock.json" ] || bf_install_fail 'the cloned release is missing package-lock.json'
printf 'Installing the dependencies locked by package-lock.json with npm ci...\n'
(cd "$BF_DESTINATION" && npm ci)
BF_NPM_STATUS=$?
if [ "$BF_NPM_STATUS" -ne 0 ]; then
  printf 'Repair Node.js and npm from %s. The cloned directory remains at %s. Inspect it, remove that new failed directory, then rerun this installer.\n' "$BF_NODE_DOWNLOAD_URL" "$BF_DESTINATION" >&2
  bf_install_fail "npm ci failed in $BF_DESTINATION"
fi

if [ ! -f "$BF_DESTINATION/.env" ]; then
  [ -f "$BF_DESTINATION/.env.example" ] || bf_install_fail 'the cloned release is missing .env.example'
  cp "$BF_DESTINATION/.env.example" "$BF_DESTINATION/.env" || bf_install_fail 'the environment template could not be copied'
  command -v openssl >/dev/null 2>&1 || bf_install_fail 'macOS openssl is required to create the ComfyUI credential encryption key'
  BF_COMFYUI_KEY=$(openssl rand -hex 32 2>/dev/null)
  [ ${#BF_COMFYUI_KEY} -eq 64 ] || bf_install_fail 'the ComfyUI credential encryption key could not be generated'
  printf '\nNOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY=%s\n' "$BF_COMFYUI_KEY" >> "$BF_DESTINATION/.env" || bf_install_fail 'the ComfyUI credential encryption key could not be saved'
  printf 'Created .env with a new ComfyUI credential encryption key.\n'
else
  printf 'Existing .env and ComfyUI credential encryption key were preserved.\n'
fi

[ -f "$BF_DESTINATION/scripts/runtime-data.mjs" ] || bf_install_fail 'the release is missing scripts/runtime-data.mjs'
(cd "$BF_DESTINATION" && node scripts/runtime-data.mjs init --root "$BF_DESTINATION")
BF_INIT_STATUS=$?
[ "$BF_INIT_STATUS" -eq 0 ] || bf_install_fail 'empty database or media initialization failed'

BF_CONFIGURATION_STATUS='ready'
for BF_NAME in NOOBAI_EMBEDDING_BASE_URL NOOBAI_EMBEDDING_API_KEY NOOBAI_EMBEDDING_MODEL NOOBAI_RERANKER_BASE_URL NOOBAI_RERANKER_API_KEY NOOBAI_RERANKER_MODEL; do
  BF_VALUE=$(sed -n "s/^${BF_NAME}=//p" "$BF_DESTINATION/.env" | tail -n 1)
  if [ -z "$BF_VALUE" ]; then
    printf 'Configuration required in %s: %s\n' "$BF_DESTINATION/.env" "$BF_NAME"
    BF_CONFIGURATION_STATUS='configuration pending'
  fi
done

printf 'Installation directory: %s\n' "$BF_DESTINATION"
printf 'Installed release: %s\n' "$BF_TAG"
if [ "$BF_CONFIGURATION_STATUS" = 'ready' ]; then
  printf 'Installation complete. Configuration is ready.\n'
else
  printf 'Installation complete, configuration pending. Fill the listed values before starting.\n'
fi
printf 'Start with: bash "%s/%s"\n' "$BF_DESTINATION" "$BF_START_RELATIVE"
