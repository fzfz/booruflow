#!/bin/bash

set -u

BF_PLATFORM_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
BF_ROOT=$(CDPATH= cd -- "$BF_PLATFORM_DIRECTORY/../../.." && pwd -P)
BF_CALLER_CWD=$(pwd -P)
BF_RELEASE_CONFIG=$BF_ROOT/config/release/release.json

bf_fail() {
  printf '%s failed: %s\n' "$BF_OPERATION" "$1" >&2
  printf 'Application root: %s\n' "$BF_ROOT" >&2
  printf 'Application logs: %s\n' "$BF_ROOT/${BF_LOG_DIRECTORY:-data/diagnostics}" >&2
  return 1
}

bf_json_value() {
  bf_json_key=$1
  sed -n "s/^[[:space:]]*\"${bf_json_key}\":[[:space:]]*\"\{0,1\}\([^\",}]*\).*/\1/p" "$BF_RELEASE_CONFIG" | head -n 1
}

bf_load_release_config() {
  [ -f "$BF_RELEASE_CONFIG" ] || { BF_LOG_DIRECTORY='data/diagnostics'; bf_fail "release configuration is missing: $BF_RELEASE_CONFIG"; return 1; }
  BF_PROJECT_NAME=$(bf_json_value project_name)
  BF_REPOSITORY_HTTPS=$(bf_json_value repository_https)
  BF_DEFAULT_TAG=$(bf_json_value default_tag)
  BF_NODE_MINIMUM=$(bf_json_value node_minimum)
  BF_NPM_MINIMUM=$(bf_json_value npm_minimum)
  BF_GIT_MINIMUM=$(bf_json_value git_minimum)
  BF_STARTUP_TIMEOUT_DEFAULT=$(bf_json_value startup_timeout_seconds)
  BF_STOP_TIMEOUT_DEFAULT=$(bf_json_value stop_timeout_seconds)
  BF_POLL_INTERVAL_DEFAULT=$(bf_json_value poll_interval_seconds)
  BF_PID_RELATIVE=$(bf_json_value pid_file)
  BF_SHUTDOWN_RELATIVE=$(bf_json_value shutdown_file)
  BF_BACKUP_VERSION_RELATIVE=$(bf_json_value backup_version_directory)
  BF_LOG_DIRECTORY=$(bf_json_value log_directory)
  BF_ARCHIVE_MAX_BYTES=$(bf_json_value data_archive_max_bytes)
  BF_ARCHIVE_MAX_ENTRIES=$(bf_json_value data_archive_max_entries)
  for bf_required in BF_PROJECT_NAME BF_REPOSITORY_HTTPS BF_DEFAULT_TAG BF_NODE_MINIMUM BF_NPM_MINIMUM BF_GIT_MINIMUM BF_STARTUP_TIMEOUT_DEFAULT BF_STOP_TIMEOUT_DEFAULT BF_POLL_INTERVAL_DEFAULT BF_PID_RELATIVE BF_SHUTDOWN_RELATIVE BF_BACKUP_VERSION_RELATIVE BF_LOG_DIRECTORY BF_ARCHIVE_MAX_BYTES BF_ARCHIVE_MAX_ENTRIES; do
    eval "bf_required_value=\${$bf_required}"
    [ -n "$bf_required_value" ] || { bf_fail "release configuration value is missing: $bf_required"; return 1; }
  done
  BF_STARTUP_TIMEOUT=${BOORUFLOW_STARTUP_TIMEOUT_SECONDS:-$BF_STARTUP_TIMEOUT_DEFAULT}
  BF_STOP_TIMEOUT=${BOORUFLOW_STOP_TIMEOUT_SECONDS:-$BF_STOP_TIMEOUT_DEFAULT}
  BF_POLL_INTERVAL=${BOORUFLOW_POLL_INTERVAL_SECONDS:-$BF_POLL_INTERVAL_DEFAULT}
  BF_PID_FILE=$BF_ROOT/$BF_PID_RELATIVE
  BF_SHUTDOWN_FILE=$BF_ROOT/$BF_SHUTDOWN_RELATIVE
  BF_BACKUP_VERSION_DIRECTORY=$BF_ROOT/$BF_BACKUP_VERSION_RELATIVE
}

bf_version_at_least() {
  awk -v actual="$1" -v required="$2" 'BEGIN {
    sub(/^v/, "", actual); sub(/[^0-9.].*$/, "", actual)
    split(actual, a, "."); split(required, r, ".")
    for (i = 1; i <= 3; i++) {
      av = (a[i] == "" ? 0 : a[i]) + 0; rv = (r[i] == "" ? 0 : r[i]) + 0
      if (av > rv) exit 0; if (av < rv) exit 1
    }
    exit 0
  }'
}

bf_tool_version() {
  bf_command=$1
  bf_minimum=$2
  command -v "$bf_command" >/dev/null 2>&1 || { bf_fail "$bf_command is missing from PATH; install version $bf_minimum or later"; return 1; }
  bf_version_output=$($bf_command --version 2>/dev/null)
  bf_command_status=$?
  [ "$bf_command_status" -eq 0 ] && [ -n "$bf_version_output" ] || { bf_fail "$bf_command is present but its version command failed"; return 1; }
  bf_numeric_version=$(printf '%s\n' "$bf_version_output" | sed -n 's/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$bf_numeric_version" ] && bf_version_at_least "$bf_numeric_version" "$bf_minimum" || { bf_fail "$bf_command $bf_minimum or later is required; found $bf_version_output"; return 1; }
  printf '%s: %s\n' "$bf_command" "$bf_version_output"
}

bf_require_application_files() {
  [ -f "$BF_ROOT/package.json" ] || { bf_fail 'package.json is missing'; return 1; }
  [ -f "$BF_ROOT/package-lock.json" ] || { bf_fail 'package-lock.json is missing'; return 1; }
  [ -f "$BF_ROOT/.env" ] || { bf_fail 'configuration file .env is missing; copy .env.example and fill every required value'; return 1; }
  [ -d "$BF_ROOT/node_modules" ] || { bf_fail 'node_modules is missing; run npm ci in the application root'; return 1; }
  [ -f "$BF_ROOT/scripts/runtime-data.mjs" ] || { bf_fail 'scripts/runtime-data.mjs is missing'; return 1; }
  [ -f "$BF_ROOT/scripts/start-local-app.mjs" ] || { bf_fail 'scripts/start-local-app.mjs is missing'; return 1; }
}

bf_read_env() {
  bf_env_name=$1
  sed -n "s/^${bf_env_name}=//p" "$BF_ENV_PATH" | tail -n 1
}

bf_load_ports_from_file() {
  BF_ENV_PATH=$1
  [ -f "$BF_ENV_PATH" ] && [ ! -L "$BF_ENV_PATH" ] || { bf_fail "environment file is missing: $BF_ENV_PATH"; return 1; }
  BF_PUBLIC_PORT=$(bf_read_env NOOBAI_PUBLIC_PORT)
  BF_INTERNAL_PORT=$(bf_read_env NOOBAI_INTERNAL_PORT)
  case "$BF_PUBLIC_PORT" in ''|*[!0-9]*) bf_fail 'NOOBAI_PUBLIC_PORT must be an integer in .env'; return 1 ;; esac
  case "$BF_INTERNAL_PORT" in ''|*[!0-9]*) bf_fail 'NOOBAI_INTERNAL_PORT must be an integer in .env'; return 1 ;; esac
  [ "$BF_PUBLIC_PORT" -ge 1 ] && [ "$BF_PUBLIC_PORT" -le 65535 ] || { bf_fail 'NOOBAI_PUBLIC_PORT must be from 1 through 65535'; return 1; }
  [ "$BF_INTERNAL_PORT" -ge 1 ] && [ "$BF_INTERNAL_PORT" -le 65535 ] || { bf_fail 'NOOBAI_INTERNAL_PORT must be from 1 through 65535'; return 1; }
  [ "$BF_PUBLIC_PORT" -ne "$BF_INTERNAL_PORT" ] || { bf_fail 'public and internal ports must be different'; return 1; }
}

bf_load_ports() {
  bf_load_ports_from_file "$BF_ROOT/.env"
}

bf_absolute_caller_path() {
  case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$BF_CALLER_CWD" "$1" ;; esac
}

bf_port_pids() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u
}

bf_port_is_free() {
  [ -z "$(bf_port_pids "$1")" ]
}

bf_read_pid() {
  BF_RECORDED_PID=''
  [ -e "$BF_PID_FILE" ] || return 0
  [ -f "$BF_PID_FILE" ] && [ ! -L "$BF_PID_FILE" ] || { bf_fail "PID record is not a regular file: $BF_PID_FILE"; return 1; }
  BF_RECORDED_PID=$(sed -n '1p' "$BF_PID_FILE")
  case "$BF_RECORDED_PID" in ''|*[!0-9]*) bf_fail "PID record must contain one numeric PID: $BF_PID_FILE"; return 1 ;; esac
  [ "$BF_RECORDED_PID" -ge 2 ] || { bf_fail 'the recorded PID is invalid'; return 1; }
}

bf_pid_is_alive() {
  kill -0 "$1" 2>/dev/null
}

bf_assert_application_pid() {
  bf_assert_pid=$1
  bf_assert_command=$(ps -p "$bf_assert_pid" -o command= 2>/dev/null) || { bf_fail "cannot inspect recorded PID $bf_assert_pid"; return 1; }
  case "$bf_assert_command" in
    *scripts/start-local-app.mjs*) ;;
    *) bf_fail "recorded PID $bf_assert_pid is not the BooruFlow application command"; return 1 ;;
  esac
  bf_cwd_line=$(LC_ALL=en_US.UTF-8 lsof -a -p "$bf_assert_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  [ -n "$bf_cwd_line" ] || { bf_fail "cannot inspect the working directory for recorded PID $bf_assert_pid"; return 1; }
  bf_process_root=$(CDPATH= cd -- "$bf_cwd_line" 2>/dev/null && pwd -P) || { bf_fail "cannot resolve the working directory for recorded PID $bf_assert_pid"; return 1; }
  [ "$bf_process_root" = "$BF_ROOT" ] || { bf_fail "recorded PID $bf_assert_pid belongs to another installation: $bf_process_root"; return 1; }
}

bf_assert_stopped() {
  bf_read_pid || return 1
  if [ -n "$BF_RECORDED_PID" ] && bf_pid_is_alive "$BF_RECORDED_PID"; then
    bf_assert_application_pid "$BF_RECORDED_PID" || return 1
    bf_fail "application PID $BF_RECORDED_PID is still running; run bash \"$BF_ROOT/bin/macos/stop.sh\" first"
    return 1
  fi
  if [ -n "$BF_RECORDED_PID" ]; then
    bf_fail "stale PID record remains: $BF_PID_FILE; run bash \"$BF_ROOT/bin/macos/stop.sh\" to reconcile it"
    return 1
  fi
  for bf_port in "$BF_PUBLIC_PORT" "$BF_INTERNAL_PORT"; do
    bf_port_is_free "$bf_port" || { bf_fail "configured port $bf_port is listening; stop the owning process or select another port"; return 1; }
  done
}

bf_runtime_check() {
  (cd "$BF_ROOT" && node scripts/runtime-data.mjs check --root "$BF_ROOT")
}

bf_check() {
  [ "$(uname -s 2>/dev/null)" = 'Darwin' ] || { bf_fail 'this script supports macOS'; return 1; }
  case "$(uname -m 2>/dev/null)" in arm64|x86_64) ;; *) bf_fail 'supported CPU architectures are arm64 and x86_64'; return 1 ;; esac
  bf_tool_version node "$BF_NODE_MINIMUM" || return 1
  bf_tool_version npm "$BF_NPM_MINIMUM" || return 1
  bf_tool_version git "$BF_GIT_MINIMUM" || return 1
  command -v lsof >/dev/null 2>&1 || { bf_fail 'macOS lsof is required for process and port checks'; return 1; }
  command -v curl >/dev/null 2>&1 || { bf_fail 'macOS curl is required for health checks'; return 1; }
  command -v tar >/dev/null 2>&1 || { bf_fail 'macOS tar is required for data packages'; return 1; }
  bf_require_application_files || return 1
  [ -w "$BF_ROOT" ] || { bf_fail 'the application directory is not writable'; return 1; }
  bf_load_ports || return 1
  bf_runtime_check || { bf_fail 'database, SQLite extension, or runtime configuration check reported an error'; return 1; }
  printf '%s check completed for %s. Public URL: http://127.0.0.1:%s/\n' "$BF_PROJECT_NAME" "$BF_ROOT" "$BF_PUBLIC_PORT"
}

bf_status() {
  bf_require_application_files || return 1
  bf_load_ports || return 1
  bf_read_pid || return 1
  if [ -z "$BF_RECORDED_PID" ]; then
    for bf_port in "$BF_PUBLIC_PORT" "$BF_INTERNAL_PORT"; do
      bf_port_is_free "$bf_port" || { bf_fail "PID record is absent but configured port $bf_port is listening"; return 1; }
    done
    printf '%s is stopped. Public URL when started: http://127.0.0.1:%s/\n' "$BF_PROJECT_NAME" "$BF_PUBLIC_PORT"
    return 3
  fi
  if ! bf_pid_is_alive "$BF_RECORDED_PID"; then
    bf_fail "recorded PID $BF_RECORDED_PID has exited; run bash \"$BF_ROOT/bin/macos/stop.sh\" to remove the stale record"
    return 1
  fi
  bf_assert_application_pid "$BF_RECORDED_PID" || return 1
  for bf_port in "$BF_PUBLIC_PORT" "$BF_INTERNAL_PORT"; do
    bf_owners=$(bf_port_pids "$bf_port")
    [ "$bf_owners" = "$BF_RECORDED_PID" ] || { bf_fail "configured port $bf_port is not owned only by PID $BF_RECORDED_PID"; return 1; }
  done
  printf '%s PID %s is running. Public URL: http://127.0.0.1:%s/. Logs: %s/%s\n' "$BF_PROJECT_NAME" "$BF_RECORDED_PID" "$BF_PUBLIC_PORT" "$BF_ROOT" "$BF_LOG_DIRECTORY"
}

bf_start_cleanup() {
  bf_cleanup_pid=$1
  if [ -f "$BF_PID_FILE" ] && [ "$(sed -n '1p' "$BF_PID_FILE")" = "$bf_cleanup_pid" ]; then rm -f "$BF_PID_FILE"; fi
}

bf_start_forward() {
  bf_forward_signal=$1
  [ -n "${BF_CHILD_PID:-}" ] && kill -s "$bf_forward_signal" "$BF_CHILD_PID" 2>/dev/null
}

bf_start() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --startup-timeout) [ "$#" -ge 2 ] || { bf_fail '--startup-timeout requires seconds'; return 1; }; BF_STARTUP_TIMEOUT=$2; shift 2 ;;
      *) bf_fail "unknown start argument: $1"; return 1 ;;
    esac
  done
  case "$BF_STARTUP_TIMEOUT" in ''|*[!0-9]*) bf_fail '--startup-timeout must be a positive integer'; return 1 ;; esac
  [ "$BF_STARTUP_TIMEOUT" -ge 1 ] || { bf_fail '--startup-timeout must be a positive integer'; return 1; }
  bf_check || return 1
  bf_assert_stopped || return 1
  mkdir -p "$(dirname "$BF_PID_FILE")" || { bf_fail 'runtime/run could not be created'; return 1; }
  rm -f "$BF_SHUTDOWN_FILE" || { bf_fail 'a stale shutdown request could not be removed'; return 1; }
  printf 'Starting %s in this terminal. Press Ctrl+C to stop it.\n' "$BF_PROJECT_NAME"
  (cd "$BF_ROOT" && exec node --env-file=.env scripts/start-local-app.mjs) &
  BF_CHILD_PID=$!
  printf '%s\n' "$BF_CHILD_PID" > "$BF_PID_FILE" || { kill -TERM "$BF_CHILD_PID" 2>/dev/null; bf_fail 'the application PID could not be recorded'; return 1; }
  trap 'bf_start_forward INT' INT
  trap 'bf_start_forward TERM' TERM
  bf_elapsed=0
  bf_healthy=0
  while [ "$bf_elapsed" -lt "$BF_STARTUP_TIMEOUT" ]; do
    if ! bf_pid_is_alive "$BF_CHILD_PID"; then
      wait "$BF_CHILD_PID" 2>/dev/null
      bf_start_cleanup "$BF_CHILD_PID"
      bf_fail 'the application exited before becoming healthy'
      return 1
    fi
    if curl -fsS --max-time 2 "http://127.0.0.1:$BF_PUBLIC_PORT/" >/dev/null 2>&1 && [ "$(bf_port_pids "$BF_INTERNAL_PORT")" = "$BF_CHILD_PID" ]; then
      bf_healthy=1
      break
    fi
    sleep "$BF_POLL_INTERVAL"
    bf_elapsed=$((bf_elapsed + BF_POLL_INTERVAL))
  done
  if [ "$bf_healthy" -ne 1 ]; then
    : > "$BF_SHUTDOWN_FILE" || { bf_fail "health check timed out and the normal shutdown request could not be written for PID $BF_CHILD_PID"; return 1; }
    bf_stop_elapsed=0
    while bf_pid_is_alive "$BF_CHILD_PID" && [ "$bf_stop_elapsed" -lt "$BF_STOP_TIMEOUT" ]; do
      sleep "$BF_POLL_INTERVAL"
      bf_stop_elapsed=$((bf_stop_elapsed + BF_POLL_INTERVAL))
    done
    if bf_pid_is_alive "$BF_CHILD_PID"; then
      bf_fail "health check timed out after $BF_STARTUP_TIMEOUT seconds; PID $BF_CHILD_PID may still own ports $BF_PUBLIC_PORT and $BF_INTERNAL_PORT; inspect the application log and retry bash \"$BF_ROOT/bin/macos/stop.sh\" --stop-timeout $BF_STOP_TIMEOUT"
      return 1
    fi
    wait "$BF_CHILD_PID" 2>/dev/null
    bf_start_cleanup "$BF_CHILD_PID"
    rm -f "$BF_SHUTDOWN_FILE"
    bf_fail "health check timed out after $BF_STARTUP_TIMEOUT seconds; the application then closed normally"
    return 1
  fi
  printf '%s is ready at http://127.0.0.1:%s/. Application logs: %s/%s\n' "$BF_PROJECT_NAME" "$BF_PUBLIC_PORT" "$BF_ROOT" "$BF_LOG_DIRECTORY"
  wait "$BF_CHILD_PID"
  bf_child_status=$?
  bf_start_cleanup "$BF_CHILD_PID"
  trap - INT TERM
  printf '%s process exited with status %s.\n' "$BF_PROJECT_NAME" "$bf_child_status"
  return "$bf_child_status"
}

bf_stop() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stop-timeout) [ "$#" -ge 2 ] || { bf_fail '--stop-timeout requires seconds'; return 1; }; BF_STOP_TIMEOUT=$2; shift 2 ;;
      *) bf_fail "unknown stop argument: $1"; return 1 ;;
    esac
  done
  case "$BF_STOP_TIMEOUT" in ''|*[!0-9]*) bf_fail '--stop-timeout must be a positive integer'; return 1 ;; esac
  bf_require_application_files || return 1
  bf_load_ports || return 1
  bf_read_pid || return 1
  if [ -z "$BF_RECORDED_PID" ]; then
    for bf_port in "$BF_PUBLIC_PORT" "$BF_INTERNAL_PORT"; do
      bf_port_is_free "$bf_port" || { bf_fail "PID record is absent but configured port $bf_port is listening"; return 1; }
    done
    printf '%s is already stopped.\n' "$BF_PROJECT_NAME"
    return 0
  fi
  if ! bf_pid_is_alive "$BF_RECORDED_PID"; then
    for bf_port in "$BF_PUBLIC_PORT" "$BF_INTERNAL_PORT"; do
      bf_port_is_free "$bf_port" || { bf_fail "recorded PID exited but configured port $bf_port is still listening"; return 1; }
    done
    rm -f "$BF_PID_FILE"
    printf 'Removed stale PID record for process %s.\n' "$BF_RECORDED_PID"
    return 0
  fi
  bf_assert_application_pid "$BF_RECORDED_PID" || return 1
  : > "$BF_SHUTDOWN_FILE" || { bf_fail "normal shutdown request could not be written for PID $BF_RECORDED_PID"; return 1; }
  bf_elapsed=0
  while bf_pid_is_alive "$BF_RECORDED_PID" && [ "$bf_elapsed" -lt "$BF_STOP_TIMEOUT" ]; do
    sleep "$BF_POLL_INTERVAL"
    bf_elapsed=$((bf_elapsed + BF_POLL_INTERVAL))
  done
  bf_pid_is_alive "$BF_RECORDED_PID" && { bf_fail "PID $BF_RECORDED_PID did not exit; inspect ports $BF_PUBLIC_PORT and $BF_INTERNAL_PORT plus the application log, then retry bash \"$BF_ROOT/bin/macos/stop.sh\" --stop-timeout $BF_STOP_TIMEOUT"; return 1; }
  for bf_port in "$BF_PUBLIC_PORT" "$BF_INTERNAL_PORT"; do
    bf_port_is_free "$bf_port" || { bf_fail "application exited but configured port $bf_port is still listening"; return 1; }
  done
  rm -f "$BF_PID_FILE"
  rm -f "$BF_SHUTDOWN_FILE"
  printf '%s PID %s stopped normally.\n' "$BF_PROJECT_NAME" "$BF_RECORDED_PID"
}

bf_backup() {
  [ "$#" -eq 0 ] || { bf_fail 'backup accepts no arguments'; return 1; }
  bf_require_application_files || return 1
  bf_load_ports || return 1
  bf_assert_stopped || return 1
  bf_create_backup_with_release || return 1
  printf '%s\n' "$BF_BACKUP_OUTPUT"
}

bf_create_backup_with_release() {
  [ -d "$BF_ROOT/.git" ] || { bf_fail 'backup requires a Git installation so its release can be restored'; return 1; }
  BF_BACKUP_TAG=$(cd "$BF_ROOT" && git describe --tags --exact-match 2>/dev/null) || { bf_fail 'backup requires the installed commit to be an exact release tag'; return 1; }
  BF_BACKUP_REPOSITORY=$(cd "$BF_ROOT" && git remote get-url origin 2>/dev/null) || { bf_fail 'backup could not read the origin repository'; return 1; }
  [ "$BF_BACKUP_REPOSITORY" = "$BF_REPOSITORY_HTTPS" ] || { bf_fail "backup origin must match the release repository: $BF_REPOSITORY_HTTPS"; return 1; }
  BF_BACKUP_OUTPUT=$(cd "$BF_ROOT" && node scripts/prod-backup.mjs) || { bf_fail 'runtime backup did not complete'; return 1; }
  BF_BACKUP_NAME=$(printf '%s\n' "$BF_BACKUP_OUTPUT" | sed -n 's/^Production backup \([^ ]*\) created.*/\1/p' | head -n 1)
  [ -n "$BF_BACKUP_NAME" ] || { bf_fail 'runtime backup did not report a backup identifier'; return 1; }
  printf '%s\n' "$BF_BACKUP_NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$' || { bf_fail 'runtime backup reported an invalid backup identifier'; return 1; }
  mkdir -p "$BF_BACKUP_VERSION_DIRECTORY" || { bf_fail 'backup version metadata directory could not be created'; return 1; }
  BF_BACKUP_METADATA=$BF_BACKUP_VERSION_DIRECTORY/$BF_BACKUP_NAME.json
  printf '{\n  "metadata_version": 1,\n  "backup": "%s",\n  "tag": "%s",\n  "repository_https": "%s"\n}\n' "$BF_BACKUP_NAME" "$BF_BACKUP_TAG" "$BF_BACKUP_REPOSITORY" > "$BF_BACKUP_METADATA" || { bf_fail 'backup release metadata could not be written'; return 1; }
}

bf_restore() {
  [ "$#" -eq 2 ] && [ "$1" = '--backup' ] || { bf_fail "usage: bash \"$BF_ROOT/bin/macos/restore.sh\" --backup data/recovery/<backup-directory>"; return 1; }
  printf '%s\n' "$2" | grep -Eq '^data/recovery/[A-Za-z0-9][A-Za-z0-9._-]*$' || { bf_fail '--backup must name one direct data/recovery backup directory'; return 1; }
  bf_restore_name=${2##*/}
  [ -d "$BF_ROOT/$2" ] && [ ! -L "$BF_ROOT/$2" ] || { bf_fail "backup directory is missing: $BF_ROOT/$2"; return 1; }
  bf_restore_metadata=$BF_BACKUP_VERSION_DIRECTORY/$bf_restore_name.json
  [ -f "$bf_restore_metadata" ] && [ ! -L "$bf_restore_metadata" ] || { bf_fail "matching release metadata is missing: $bf_restore_metadata"; return 1; }
  bf_recovery_backup=$(sed -n 's/^[[:space:]]*"backup":[[:space:]]*"\([^"]*\)",*[[:space:]]*$/\1/p' "$bf_restore_metadata")
  bf_recovery_tag=$(sed -n 's/^[[:space:]]*"tag":[[:space:]]*"\([^"]*\)",*[[:space:]]*$/\1/p' "$bf_restore_metadata")
  bf_recovery_repository=$(sed -n 's/^[[:space:]]*"repository_https":[[:space:]]*"\([^"]*\)",*[[:space:]]*$/\1/p' "$bf_restore_metadata")
  [ "$bf_recovery_backup" = "$bf_restore_name" ] || { bf_fail 'backup release metadata names another backup'; return 1; }
  printf '%s\n' "$bf_recovery_tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { bf_fail 'backup release metadata contains an invalid tag'; return 1; }
  [ -n "$bf_recovery_repository" ] || { bf_fail 'backup release metadata is missing its repository'; return 1; }
  [ "$bf_recovery_repository" = "$BF_REPOSITORY_HTTPS" ] || { bf_fail 'backup release metadata repository does not match this release configuration'; return 1; }
  [ -d "$BF_ROOT/.git" ] || { bf_fail 'restore requires the installation Git directory'; return 1; }
  command -v git >/dev/null 2>&1 || { bf_fail 'restore requires Git on PATH'; return 1; }
  command -v npm >/dev/null 2>&1 || { bf_fail 'restore requires npm on PATH'; return 1; }
  command -v node >/dev/null 2>&1 || { bf_fail 'restore requires Node.js on PATH'; return 1; }
  bf_load_ports_from_file "$BF_ROOT/$2/.installation/.env" || return 1
  bf_assert_stopped || return 1
  (cd "$BF_ROOT" && git remote set-url origin "$bf_recovery_repository" && git fetch --tags origin && git checkout --detach "$bf_recovery_tag" && npm ci) || { bf_fail "code restoration to $bf_recovery_tag failed before runtime data was changed"; return 1; }
  (cd "$BF_ROOT" && node scripts/prod-restore.mjs --backup "$2") || { bf_fail "code and locked dependencies were restored to $bf_recovery_tag, but configuration, database, or media restoration failed"; return 1; }
  printf 'Code, locked dependencies, configuration, database, and media were restored to %s.\n' "$bf_recovery_tag"
}

bf_temporary_health_check() {
  bf_temp_stdout=$BF_ROOT/runtime/update-health.stdout.log
  bf_temp_stderr=$BF_ROOT/runtime/update-health.stderr.log
  mkdir -p "$(dirname "$BF_SHUTDOWN_FILE")" || { bf_fail 'temporary application shutdown directory could not be created'; return 1; }
  rm -f "$BF_SHUTDOWN_FILE" || { bf_fail 'a stale shutdown request could not be removed before the temporary health check'; return 1; }
  (cd "$BF_ROOT" && exec node --env-file=.env scripts/start-local-app.mjs) >"$bf_temp_stdout" 2>"$bf_temp_stderr" &
  bf_temp_pid=$!
  bf_elapsed=0
  bf_ok=0
  while [ "$bf_elapsed" -lt "$BF_STARTUP_TIMEOUT" ]; do
    bf_pid_is_alive "$bf_temp_pid" || break
    if curl -fsS --max-time 2 "http://127.0.0.1:$BF_PUBLIC_PORT/" >/dev/null 2>&1 && [ "$(bf_port_pids "$BF_INTERNAL_PORT")" = "$bf_temp_pid" ]; then bf_ok=1; break; fi
    sleep "$BF_POLL_INTERVAL"; bf_elapsed=$((bf_elapsed + BF_POLL_INTERVAL))
  done
  : > "$BF_SHUTDOWN_FILE" || { bf_fail 'temporary application shutdown request could not be written'; return 1; }
  bf_stop_elapsed=0
  while bf_pid_is_alive "$bf_temp_pid" && [ "$bf_stop_elapsed" -lt "$BF_STOP_TIMEOUT" ]; do
    sleep "$BF_POLL_INTERVAL"; bf_stop_elapsed=$((bf_stop_elapsed + BF_POLL_INTERVAL))
  done
  if bf_pid_is_alive "$bf_temp_pid"; then bf_fail "temporary application did not stop within $BF_STOP_TIMEOUT seconds; inspect $bf_temp_stdout and $bf_temp_stderr"; return 1; fi
  wait "$bf_temp_pid" 2>/dev/null
  rm -f "$BF_SHUTDOWN_FILE"
  [ "$bf_ok" -eq 1 ] || { bf_fail "temporary health check failed; inspect $bf_temp_stdout and $bf_temp_stderr"; return 1; }
}

bf_update() {
  bf_target=$BF_DEFAULT_TAG
  while [ "$#" -gt 0 ]; do
    case "$1" in --tag) [ "$#" -ge 2 ] || { bf_fail '--tag requires vX.Y.Z'; return 1; }; bf_target=$2; shift 2 ;; *) bf_fail "unknown update argument: $1"; return 1 ;; esac
  done
  printf '%s\n' "$bf_target" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { bf_fail 'target tag must use vX.Y.Z form'; return 1; }
  bf_require_application_files || return 1
  bf_load_ports || return 1
  bf_assert_stopped || return 1
  [ -d "$BF_ROOT/.git" ] || { bf_fail 'the application directory is not a Git installation'; return 1; }
  [ -z "$(cd "$BF_ROOT" && git status --porcelain)" ] || { bf_fail 'the Git worktree contains local changes; save or remove them before updating'; return 1; }
  bf_current=$(cd "$BF_ROOT" && git describe --tags --exact-match 2>/dev/null) || { bf_fail 'the installed commit is not an exact release tag'; return 1; }
  bf_version_at_least "${bf_target#v}" "${bf_current#v}" || { bf_fail "downgrade from $bf_current to $bf_target is not supported"; return 1; }
  [ "$bf_target" != "$bf_current" ] || { printf '%s is already installed.\n' "$bf_target"; return 0; }
  bf_create_backup_with_release || { bf_fail 'pre-update backup failed'; return 1; }
  printf '%s\n' "$BF_BACKUP_OUTPUT"
  bf_backup_name=$BF_BACKUP_NAME
  (cd "$BF_ROOT" && git fetch --tags origin && git rev-parse -q --verify "refs/tags/$bf_target" >/dev/null && git checkout --detach "$bf_target") || { bf_fail "target release $bf_target could not be fetched and checked out; restore with bash \"$BF_ROOT/bin/macos/restore.sh\" --backup data/recovery/$bf_backup_name"; return 1; }
  (cd "$BF_ROOT" && npm ci) || { bf_fail "npm ci failed; restore with bash \"$BF_ROOT/bin/macos/restore.sh\" --backup data/recovery/$bf_backup_name"; return 1; }
  (cd "$BF_ROOT" && node scripts/runtime-data.mjs migrate --root "$BF_ROOT") || { bf_fail "database upgrade failed; restore with bash \"$BF_ROOT/bin/macos/restore.sh\" --backup data/recovery/$bf_backup_name"; return 1; }
  bf_runtime_check || { bf_fail "updated database check failed; restore with bash \"$BF_ROOT/bin/macos/restore.sh\" --backup data/recovery/$bf_backup_name"; return 1; }
  bf_temporary_health_check || { printf 'Restore with: bash "%s/bin/macos/restore.sh" --backup data/recovery/%s\n' "$BF_ROOT" "$bf_backup_name" >&2; return 1; }
  printf 'Update to %s completed. Start with: bash "%s/bin/macos/start.sh"\n' "$bf_target" "$BF_ROOT"
}

bf_data_export() {
  bf_output=''; bf_include=''
  while [ "$#" -gt 0 ]; do
    case "$1" in --output) [ "$#" -ge 2 ] || { bf_fail '--output requires a directory'; return 1; }; bf_output=$2; shift 2 ;; --include-instances) bf_include='--include-instances'; shift ;; *) bf_fail "unknown data-export argument: $1"; return 1 ;; esac
  done
  [ -n "$bf_output" ] || { bf_fail "usage: bash \"$BF_ROOT/bin/macos/data-export.sh\" --output DIR [--include-instances]"; return 1; }
  bf_output=$(bf_absolute_caller_path "$bf_output")
  bf_require_application_files || return 1; bf_load_ports || return 1; bf_assert_stopped || return 1
  if [ -n "$bf_include" ]; then (cd "$BF_ROOT" && node scripts/runtime-data.mjs data-export --root "$BF_ROOT" --output "$bf_output" --include-instances); else (cd "$BF_ROOT" && node scripts/runtime-data.mjs data-export --root "$BF_ROOT" --output "$bf_output"); fi
}

bf_data_pack() {
  bf_input=''; bf_output=''
  while [ "$#" -gt 0 ]; do
    case "$1" in --input) [ "$#" -ge 2 ] || { bf_fail '--input requires a directory'; return 1; }; bf_input=$2; shift 2 ;; --output) [ "$#" -ge 2 ] || { bf_fail '--output requires a .tar.gz file'; return 1; }; bf_output=$2; shift 2 ;; *) bf_fail "unknown data-pack argument: $1"; return 1 ;; esac
  done
  [ -d "$bf_input" ] && [ -n "$bf_output" ] || { bf_fail "usage: bash \"$BF_ROOT/bin/macos/data-pack.sh\" --input DIR --output FILE.tar.gz"; return 1; }
  bf_input=$(bf_absolute_caller_path "$bf_input")
  bf_output=$(bf_absolute_caller_path "$bf_output")
  [ -d "$bf_input" ] || { bf_fail "input directory does not exist: $bf_input"; return 1; }
  case "$bf_output" in *.tar.gz) ;; *) bf_fail '--output must end in .tar.gz'; return 1 ;; esac
  [ ! -e "$bf_output" ] || { bf_fail "output already exists: $bf_output"; return 1; }
  bf_require_application_files || return 1
  (cd "$BF_ROOT" && node scripts/runtime-data.mjs data-validate --root "$BF_ROOT" --input "$bf_input") || { bf_fail 'export directory validation failed'; return 1; }
  tar -czf "$bf_output" -C "$bf_input" . || { rm -f "$bf_output"; bf_fail 'tar could not create the data package'; return 1; }
  bf_size=$(stat -f '%z' "$bf_output" 2>/dev/null) || { bf_fail 'the data package size could not be read'; return 1; }
  [ "$bf_size" -le "$BF_ARCHIVE_MAX_BYTES" ] || { rm -f "$bf_output"; bf_fail "data package exceeds $BF_ARCHIVE_MAX_BYTES bytes"; return 1; }
  printf 'Data package created: %s (%s bytes)\n' "$bf_output" "$bf_size"
}

bf_archive_input() {
  bf_archive=$1
  [ -f "$bf_archive" ] && [ ! -L "$bf_archive" ] || { bf_fail 'archive input must be a regular file'; return 1; }
  bf_archive_size=$(stat -f '%z' "$bf_archive" 2>/dev/null) || { bf_fail 'archive size could not be read'; return 1; }
  [ "$bf_archive_size" -le "$BF_ARCHIVE_MAX_BYTES" ] || { bf_fail "archive exceeds $BF_ARCHIVE_MAX_BYTES bytes"; return 1; }
  BF_ARCHIVE_LIST=$(mktemp -t booruflow-archive-list.XXXXXX) || { bf_fail 'temporary archive list could not be created'; return 1; }
  tar -tzf "$bf_archive" > "$BF_ARCHIVE_LIST" 2>/dev/null || { rm -f "$BF_ARCHIVE_LIST"; bf_fail 'archive is truncated or invalid'; return 1; }
  bf_entry_count=$(wc -l < "$BF_ARCHIVE_LIST" | tr -d ' ')
  [ "$bf_entry_count" -le "$BF_ARCHIVE_MAX_ENTRIES" ] || { rm -f "$BF_ARCHIVE_LIST"; bf_fail "archive exceeds $BF_ARCHIVE_MAX_ENTRIES entries"; return 1; }
  awk 'BEGIN { bad=0 }
    {
      path=$0
      if (path ~ /^\// || path ~ /\\/ || path ~ /:/ || path ~ /[[:cntrl:]]/) bad=1
      while (substr(path,1,2)=="./") path=substr(path,3)
      while (substr(path,length(path),1)=="/") path=substr(path,1,length(path)-1)
      if (path=="") next
      count=split(path, parts, "/")
      for (i=1; i<=count; i++) {
        if (parts[i]=="" || parts[i]=="." || parts[i]==".." || parts[i] ~ /[. ]$/) bad=1
        name=tolower(parts[i]); sub(/\..*$/, "", name)
        if (name ~ /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/) bad=1
      }
      canonical=tolower(path)
      if (seen[canonical]++) bad=1
    }
    END { exit bad }' "$BF_ARCHIVE_LIST" || { rm -f "$BF_ARCHIVE_LIST"; bf_fail 'archive contains an unsafe or Windows-reserved path'; return 1; }
  tar -tvzf "$bf_archive" 2>/dev/null | awk -v limit="$BF_ARCHIVE_MAX_BYTES" '
    substr($0,1,1)!="-" && substr($0,1,1)!="d" { exit 2 }
    substr($0,1,1)=="-" { total += $5; if (total > limit) exit 3 }
  ' || { rm -f "$BF_ARCHIVE_LIST"; bf_fail 'archive contains an unsupported entry type or exceeds the expanded-size limit'; return 1; }
  rm -f "$BF_ARCHIVE_LIST"
  BF_IMPORT_DIRECTORY=$(mktemp -d -t booruflow-import.XXXXXX) || { bf_fail 'temporary import directory could not be created'; return 1; }
  tar -xzf "$bf_archive" -C "$BF_IMPORT_DIRECTORY" || { rm -rf "$BF_IMPORT_DIRECTORY"; bf_fail 'archive extraction failed'; return 1; }
}

bf_data_import() {
  bf_input=''; bf_mode=''; bf_batch=''
  while [ "$#" -gt 0 ]; do
    case "$1" in --input) [ "$#" -ge 2 ] || { bf_fail '--input requires a path'; return 1; }; bf_input=$2; shift 2 ;; --check) bf_mode=check; shift ;; --apply) bf_mode=apply; shift ;; --recover) bf_mode=recover; shift ;; --batch) [ "$#" -ge 2 ] || { bf_fail '--batch requires an ID'; return 1; }; bf_batch=$2; shift 2 ;; *) bf_fail "unknown data-import argument: $1"; return 1 ;; esac
  done
  bf_require_application_files || return 1; bf_load_ports || return 1; bf_assert_stopped || return 1
  if [ "$bf_mode" = recover ]; then
    [ -n "$bf_batch" ] && [ -z "$bf_input" ] || { bf_fail "usage: bash \"$BF_ROOT/bin/macos/data-import.sh\" --recover --batch ID"; return 1; }
    (cd "$BF_ROOT" && node scripts/runtime-data.mjs data-recover --root "$BF_ROOT" --batch "$bf_batch") || { bf_fail "data import batch recovery failed: $bf_batch"; return 1; }
    return 0
  fi
  [ -n "$bf_input" ] && { [ "$bf_mode" = check ] || [ "$bf_mode" = apply ]; } || { bf_fail "usage: bash \"$BF_ROOT/bin/macos/data-import.sh\" --input PATH --check|--apply"; return 1; }
  bf_input=$(bf_absolute_caller_path "$bf_input")
  BF_IMPORT_DIRECTORY=''
  if [ -d "$bf_input" ] && [ ! -L "$bf_input" ]; then BF_IMPORT_DIRECTORY=$bf_input; else bf_archive_input "$bf_input" || return 1; fi
  if [ "$bf_mode" = check ]; then
    (cd "$BF_ROOT" && node scripts/runtime-data.mjs data-check --root "$BF_ROOT" --input "$BF_IMPORT_DIRECTORY")
  else
    (cd "$BF_ROOT" && node scripts/runtime-data.mjs data-import --root "$BF_ROOT" --input "$BF_IMPORT_DIRECTORY")
  fi
  bf_import_status=$?
  if [ "$BF_IMPORT_DIRECTORY" != "$bf_input" ]; then rm -rf "$BF_IMPORT_DIRECTORY"; fi
  [ "$bf_import_status" -eq 0 ] || { bf_fail "data import $bf_mode failed"; return 1; }
}

bf_main() {
  BF_OPERATION=${1:-}
  [ -n "$BF_OPERATION" ] || { printf 'platform operation is required\n' >&2; return 1; }
  shift
  bf_load_release_config || return 1
  case "$BF_OPERATION" in
    check) bf_check "$@" ;;
    start) bf_start "$@" ;;
    stop) bf_stop "$@" ;;
    status) bf_status "$@" ;;
    update) bf_update "$@" ;;
    backup) bf_backup "$@" ;;
    restore) bf_restore "$@" ;;
    data-export) bf_data_export "$@" ;;
    data-pack) bf_data_pack "$@" ;;
    data-import) bf_data_import "$@" ;;
    *) bf_fail "unknown platform operation: $BF_OPERATION" ;;
  esac
}
