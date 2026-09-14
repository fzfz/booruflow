@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "BF_OPERATION=%~1"
set "BF_CALLER_CWD=%CD%"
set "BF_ARG1=%~2"
set "BF_ARG2=%~3"
set "BF_ARG3=%~4"
set "BF_ARG4=%~5"
set "BF_ARG5=%~6"
set "BF_ARG6=%~7"
set "BF_ARG7=%~8"
set "BF_ARG8=%~9"
for %%I in ("%~dp0\..\..\..") do set "BF_ROOT=%%~fI"
set "BF_RELEASE_CONFIG_PATH=%BF_ROOT%\config\release\release.json"
call :load_config
if errorlevel 1 exit /b 1

if /I "%BF_OPERATION%"=="check" goto dispatch_check
if /I "%BF_OPERATION%"=="start" goto dispatch_start
if /I "%BF_OPERATION%"=="stop" goto dispatch_stop
if /I "%BF_OPERATION%"=="status" goto dispatch_status
if /I "%BF_OPERATION%"=="update" goto dispatch_update
if /I "%BF_OPERATION%"=="backup" goto dispatch_backup
if /I "%BF_OPERATION%"=="restore" goto dispatch_restore
if /I "%BF_OPERATION%"=="data-export" goto dispatch_data_export
if /I "%BF_OPERATION%"=="data-pack" goto dispatch_data_pack
if /I "%BF_OPERATION%"=="data-import" goto dispatch_data_import
call :fail "an unknown platform operation was provided"
exit /b 1

:dispatch_check
call :check
exit /b %ERRORLEVEL%
:dispatch_start
call :start
exit /b %ERRORLEVEL%
:dispatch_stop
call :stop
exit /b %ERRORLEVEL%
:dispatch_status
call :status
exit /b %ERRORLEVEL%
:dispatch_update
call :update
exit /b %ERRORLEVEL%
:dispatch_backup
call :backup
exit /b %ERRORLEVEL%
:dispatch_restore
call :restore
exit /b %ERRORLEVEL%
:dispatch_data_export
call :data_export
exit /b %ERRORLEVEL%
:dispatch_data_pack
call :data_pack
exit /b %ERRORLEVEL%
:dispatch_data_import
call :data_import
exit /b %ERRORLEVEL%

:load_config
if not exist "%BF_RELEASE_CONFIG_PATH%" (set "BF_LOG_DIRECTORY=data\diagnostics" & call :fail "release configuration is missing" & exit /b 1)
where powershell.exe >nul 2>nul || (set "BF_LOG_DIRECTORY=data\diagnostics" & call :fail "Windows PowerShell is required to read release configuration" & exit /b 1)
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.project_name"`) do set "BF_PROJECT_NAME=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.repository_https"`) do set "BF_REPOSITORY=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.default_tag"`) do set "BF_DEFAULT_TAG=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.requirements.node_minimum"`) do set "BF_NODE_MINIMUM=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.requirements.npm_minimum"`) do set "BF_NPM_MINIMUM=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.requirements.git_minimum"`) do set "BF_GIT_MINIMUM=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.startup_timeout_seconds"`) do set "BF_STARTUP_TIMEOUT_DEFAULT=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.stop_timeout_seconds"`) do set "BF_STOP_TIMEOUT_DEFAULT=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.poll_interval_seconds"`) do set "BF_POLL_INTERVAL=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.pid_file"`) do set "BF_PID_RELATIVE=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.shutdown_file"`) do set "BF_SHUTDOWN_RELATIVE=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.backup_version_directory"`) do set "BF_BACKUP_VERSION_RELATIVE=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.log_directory"`) do set "BF_LOG_DIRECTORY=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.data_archive_max_bytes"`) do set "BF_ARCHIVE_MAX_BYTES=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:BF_RELEASE_CONFIG_PATH|ConvertFrom-Json; $c.runtime.data_archive_max_entries"`) do set "BF_ARCHIVE_MAX_ENTRIES=%%V"
if not defined BF_PROJECT_NAME (call :fail "release configuration is invalid" & exit /b 1)
if not defined BF_PID_RELATIVE (call :fail "release runtime configuration is invalid" & exit /b 1)
set "BF_PID_FILE=%BF_ROOT%\%BF_PID_RELATIVE:/=\%"
set "BF_SHUTDOWN_FILE=%BF_ROOT%\%BF_SHUTDOWN_RELATIVE:/=\%"
set "BF_BACKUP_VERSION_DIRECTORY=%BF_ROOT%\%BF_BACKUP_VERSION_RELATIVE:/=\%"
set "BF_START_SCRIPT=%BF_ROOT%\scripts\start-local-app.mjs"
if defined BOORUFLOW_STARTUP_TIMEOUT_SECONDS (set "BF_STARTUP_TIMEOUT=%BOORUFLOW_STARTUP_TIMEOUT_SECONDS%") else set "BF_STARTUP_TIMEOUT=%BF_STARTUP_TIMEOUT_DEFAULT%"
if defined BOORUFLOW_STOP_TIMEOUT_SECONDS (set "BF_STOP_TIMEOUT=%BOORUFLOW_STOP_TIMEOUT_SECONDS%") else set "BF_STOP_TIMEOUT=%BF_STOP_TIMEOUT_DEFAULT%"
if defined BOORUFLOW_POLL_INTERVAL_SECONDS set "BF_POLL_INTERVAL=%BOORUFLOW_POLL_INTERVAL_SECONDS%"
exit /b 0

:fail
echo %BF_OPERATION% failed: %~1 1>&2
echo Application root: "%BF_ROOT%" 1>&2
echo Application logs: "%BF_ROOT%\%BF_LOG_DIRECTORY:/=\%" 1>&2
exit /b 1

:require_files
if not exist "%BF_ROOT%\package.json" (call :fail "package.json is missing" & exit /b 1)
if not exist "%BF_ROOT%\package-lock.json" (call :fail "package-lock.json is missing" & exit /b 1)
if not exist "%BF_ROOT%\.env" (call :fail "configuration file .env is missing; copy .env.example and fill every required value" & exit /b 1)
if not exist "%BF_ROOT%\node_modules\" (call :fail "node_modules is missing; run npm ci in the application root" & exit /b 1)
if not exist "%BF_ROOT%\scripts\runtime-data.mjs" (call :fail "scripts\runtime-data.mjs is missing" & exit /b 1)
if not exist "%BF_ROOT%\scripts\start-local-app.mjs" (call :fail "scripts\start-local-app.mjs is missing" & exit /b 1)
exit /b 0

:load_ports
set "BF_ENV_PATH=%BF_ROOT%\.env"
call :load_ports_from_file
exit /b %ERRORLEVEL%

:load_ports_from_file
set "BF_PUBLIC_PORT="
set "BF_INTERNAL_PORT="
if not exist "%BF_ENV_PATH%" (call :fail "environment file for port checks is missing" & exit /b 1)
for /f "usebackq tokens=1,* delims==" %%A in ("%BF_ENV_PATH%") do (
  if /I "%%A"=="NOOBAI_PUBLIC_PORT" set "BF_PUBLIC_PORT=%%B"
  if /I "%%A"=="NOOBAI_INTERNAL_PORT" set "BF_INTERNAL_PORT=%%B"
)
if not defined BF_PUBLIC_PORT (call :fail "NOOBAI_PUBLIC_PORT is missing from .env" & exit /b 1)
if not defined BF_INTERNAL_PORT (call :fail "NOOBAI_INTERNAL_PORT is missing from .env" & exit /b 1)
set "BF_PORT_VALUE=%BF_PUBLIC_PORT%"
powershell.exe -NoProfile -Command "$v=0; if(-not [int]::TryParse($env:BF_PORT_VALUE,[ref]$v) -or $v -lt 1 -or $v -gt 65535){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "NOOBAI_PUBLIC_PORT must be an integer from 1 through 65535" & exit /b 1)
set "BF_PORT_VALUE=%BF_INTERNAL_PORT%"
powershell.exe -NoProfile -Command "$v=0; if(-not [int]::TryParse($env:BF_PORT_VALUE,[ref]$v) -or $v -lt 1 -or $v -gt 65535){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "NOOBAI_INTERNAL_PORT must be an integer from 1 through 65535" & exit /b 1)
if "%BF_PUBLIC_PORT%"=="%BF_INTERNAL_PORT%" (call :fail "public and internal ports must be different" & exit /b 1)
exit /b 0

:require_tool
where %~1 >nul 2>nul || (call :fail "%~1 %~2 or later is missing from PATH" & exit /b 1)
if /I "%~1"=="git" (for /f "tokens=3" %%V in ('git --version 2^>nul') do set "BF_TOOL_VERSION=%%V") else for /f "delims=" %%V in ('%~1 --version 2^>nul') do set "BF_TOOL_VERSION=%%V"
if not defined BF_TOOL_VERSION (call :fail "%~1 is present but its version command failed" & exit /b 1)
set "BF_TOOL_VERSION=%BF_TOOL_VERSION:v=%"
call :version_at_least "%BF_TOOL_VERSION%" "%~2"
if errorlevel 1 (call :fail "%~1 %~2 or later is required; found %BF_TOOL_VERSION%" & exit /b 1)
echo %~1: %BF_TOOL_VERSION%
set "BF_TOOL_VERSION="
exit /b 0

:version_at_least
for /f "tokens=1-3 delims=." %%A in ("%~1") do set /a BF_A1=%%A,BF_A2=%%B,BF_A3=%%C >nul 2>nul
for /f "tokens=1-3 delims=." %%A in ("%~2") do set /a BF_R1=%%A,BF_R2=%%B,BF_R3=%%C >nul 2>nul
if %BF_A1% GTR %BF_R1% exit /b 0
if %BF_A1% LSS %BF_R1% exit /b 1
if %BF_A2% GTR %BF_R2% exit /b 0
if %BF_A2% LSS %BF_R2% exit /b 1
if %BF_A3% GEQ %BF_R3% exit /b 0
exit /b 1

:read_pid
set "BF_RECORDED_PID="
if not exist "%BF_PID_FILE%" exit /b 0
for /f "usebackq delims=" %%P in ("%BF_PID_FILE%") do if not defined BF_RECORDED_PID set "BF_RECORDED_PID=%%P"
if not defined BF_RECORDED_PID (call :fail "PID record is empty" & exit /b 1)
set "BF_PID_VALUE=%BF_RECORDED_PID%"
powershell.exe -NoProfile -Command "$v=0; if(-not [int]::TryParse($env:BF_PID_VALUE,[ref]$v) -or $v -lt 2){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "PID record must contain one numeric PID" & exit /b 1)
exit /b 0

:pid_alive
tasklist /FI "PID eq %~1" /NH 2>nul | findstr /R /C:"[ ]%~1[ ]" >nul
exit /b %ERRORLEVEL%

:assert_application_pid
set "BF_INSPECT_PID=%~1"
powershell.exe -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:BF_INSPECT_PID); if($null -eq $p -or $p.Name -notmatch '^node(.exe)?$' -or ([string]$p.CommandLine).IndexOf($env:BF_START_SCRIPT,[StringComparison]::OrdinalIgnoreCase) -lt 0){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "recorded PID %~1 is not the application process for this installation root" & exit /b 1)
exit /b 0

:port_is_free
netstat -ano -p tcp 2>nul | findstr /R /C:":%~1[ ]" | findstr /I "LISTENING" >nul
if errorlevel 1 exit /b 0
exit /b 1

:port_owned_by
set "BF_PORT_CHECK=%~1"
set "BF_PID_CHECK=%~2"
powershell.exe -NoProfile -Command "$rows=Get-NetTCPConnection -State Listen -LocalPort ([int]$env:BF_PORT_CHECK) -ErrorAction SilentlyContinue; if($null -eq $rows -or @($rows).Count -eq 0){exit 1}; $owners=@($rows|Select-Object -Expand OwningProcess -Unique); if($owners.Count -ne 1 -or $owners[0] -ne [int]$env:BF_PID_CHECK){exit 1}" >nul 2>nul
exit /b %ERRORLEVEL%

:assert_stopped
call :read_pid
if errorlevel 1 exit /b 1
if defined BF_RECORDED_PID (
  call :pid_alive "%BF_RECORDED_PID%"
  if not errorlevel 1 (call :assert_application_pid "%BF_RECORDED_PID%" & call :fail "application PID %BF_RECORDED_PID% is still running; run stop.bat first" & exit /b 1)
  call :fail "stale PID record remains; run stop.bat to reconcile it"
  exit /b 1
)
call :port_is_free "%BF_PUBLIC_PORT%"
if errorlevel 1 (call :fail "configured public port %BF_PUBLIC_PORT% is listening" & exit /b 1)
call :port_is_free "%BF_INTERNAL_PORT%"
if errorlevel 1 (call :fail "configured internal port %BF_INTERNAL_PORT% is listening" & exit /b 1)
exit /b 0

:check
if defined BF_ARG1 (call :fail "check accepts no arguments" & exit /b 1)
if /I not "%OS%"=="Windows_NT" (call :fail "this script supports Windows" & exit /b 1)
if /I not "%PROCESSOR_ARCHITECTURE%"=="AMD64" if /I not "%PROCESSOR_ARCHITEW6432%"=="AMD64" (call :fail "this script supports Windows x64" & exit /b 1)
call :require_tool node "%BF_NODE_MINIMUM%" || exit /b 1
call :require_tool npm "%BF_NPM_MINIMUM%" || exit /b 1
call :require_tool git "%BF_GIT_MINIMUM%" || exit /b 1
where tar.exe >nul 2>nul || (call :fail "Windows tar is required for data packages" & exit /b 1)
where netstat.exe >nul 2>nul || (call :fail "Windows netstat is required for port checks" & exit /b 1)
call :require_files || exit /b 1
call :load_ports || exit /b 1
pushd "%BF_ROOT%" || (call :fail "application root cannot be opened" & exit /b 1)
node scripts\runtime-data.mjs check --root "%BF_ROOT%"
set "BF_RUNTIME_STATUS=%ERRORLEVEL%"
popd
if not "%BF_RUNTIME_STATUS%"=="0" (call :fail "database, SQLite extension, or runtime configuration check reported an error" & exit /b 1)
echo %BF_PROJECT_NAME% check completed. Public URL: http://127.0.0.1:%BF_PUBLIC_PORT%/
exit /b 0

:status
if defined BF_ARG1 (call :fail "status accepts no arguments" & exit /b 1)
call :require_files || exit /b 1
call :load_ports || exit /b 1
call :read_pid || exit /b 1
if not defined BF_RECORDED_PID (
  call :port_is_free "%BF_PUBLIC_PORT%" || (call :fail "PID record is absent but public port %BF_PUBLIC_PORT% is listening" & exit /b 1)
  call :port_is_free "%BF_INTERNAL_PORT%" || (call :fail "PID record is absent but internal port %BF_INTERNAL_PORT% is listening" & exit /b 1)
  echo %BF_PROJECT_NAME% is stopped. Public URL when started: http://127.0.0.1:%BF_PUBLIC_PORT%/
  exit /b 3
)
call :pid_alive "%BF_RECORDED_PID%" || (call :fail "recorded PID %BF_RECORDED_PID% has exited; run stop.bat" & exit /b 1)
call :assert_application_pid "%BF_RECORDED_PID%" || exit /b 1
call :port_owned_by "%BF_PUBLIC_PORT%" "%BF_RECORDED_PID%" || (call :fail "public port is not owned only by PID %BF_RECORDED_PID%" & exit /b 1)
call :port_owned_by "%BF_INTERNAL_PORT%" "%BF_RECORDED_PID%" || (call :fail "internal port is not owned only by PID %BF_RECORDED_PID%" & exit /b 1)
echo %BF_PROJECT_NAME% PID %BF_RECORDED_PID% is running. Public URL: http://127.0.0.1:%BF_PUBLIC_PORT%/. Logs: "%BF_ROOT%\%BF_LOG_DIRECTORY:/=\%"
exit /b 0

:start
if defined BF_ARG1 if /I not "%BF_ARG1%"=="--startup-timeout" (call :fail "usage: start.bat [--startup-timeout SECONDS]" & exit /b 1)
if /I "%BF_ARG1%"=="--startup-timeout" if not defined BF_ARG2 (call :fail "--startup-timeout requires seconds" & exit /b 1)
if defined BF_ARG3 (call :fail "usage: start.bat [--startup-timeout SECONDS]" & exit /b 1)
if /I "%BF_ARG1%"=="--startup-timeout" set "BF_STARTUP_TIMEOUT=%BF_ARG2%"
set "BF_TIMEOUT_VALUE=%BF_STARTUP_TIMEOUT%"
powershell.exe -NoProfile -Command "$v=0; if(-not [int]::TryParse($env:BF_TIMEOUT_VALUE,[ref]$v) -or $v -lt 1){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "--startup-timeout must be a positive integer" & exit /b 1)
call :check || exit /b 1
call :assert_stopped || exit /b 1
for %%I in ("%BF_PID_FILE%") do set "BF_PID_DIRECTORY=%%~dpI"
if not exist "%BF_PID_DIRECTORY%" mkdir "%BF_PID_DIRECTORY%" || (call :fail "runtime run directory could not be created" & exit /b 1)
if exist "%BF_SHUTDOWN_FILE%" del /q "%BF_SHUTDOWN_FILE%" || (call :fail "a stale shutdown request could not be removed" & exit /b 1)
set "BF_START_ROOT=%BF_ROOT%"
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -Command "$a='--env-file=.env '+[char]34+$env:BF_START_SCRIPT+[char]34; $p=Start-Process -FilePath node -ArgumentList $a -WorkingDirectory $env:BF_START_ROOT -PassThru; $p.Id"`) do set "BF_CHILD_PID=%%P"
if not defined BF_CHILD_PID (call :fail "the application process could not be started" & exit /b 1)
>"%BF_PID_FILE%" echo %BF_CHILD_PID%
set /a BF_ELAPSED=0
:start_health_loop
call :pid_alive "%BF_CHILD_PID%" || (del /q "%BF_PID_FILE%" >nul 2>nul & call :fail "application exited before becoming healthy" & exit /b 1)
set "BF_HEALTH_URL=http://127.0.0.1:%BF_PUBLIC_PORT%/"
powershell.exe -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $env:BF_HEALTH_URL; if($r.StatusCode -eq 200){exit 0}}catch{}; exit 1" >nul 2>nul
if errorlevel 1 goto start_health_wait
call :port_owned_by "%BF_INTERNAL_PORT%" "%BF_CHILD_PID%"
if not errorlevel 1 goto start_ready
:start_health_wait
if %BF_ELAPSED% GEQ %BF_STARTUP_TIMEOUT% goto start_timeout_shutdown
powershell.exe -NoProfile -Command "Start-Sleep -Seconds ([int]$env:BF_POLL_INTERVAL)"
set /a BF_ELAPSED+=BF_POLL_INTERVAL
goto start_health_loop
:start_ready
echo %BF_PROJECT_NAME% PID %BF_CHILD_PID% is ready in a visible terminal at http://127.0.0.1:%BF_PUBLIC_PORT%/. Logs: "%BF_ROOT%\%BF_LOG_DIRECTORY:/=\%"
exit /b 0
:start_timeout_shutdown
type nul > "%BF_SHUTDOWN_FILE%" || (call :fail "health check timed out and the normal shutdown request could not be written" & exit /b 1)
set /a BF_STOP_ELAPSED=0
:start_timeout_wait
call :pid_alive "%BF_CHILD_PID%" || goto start_timeout_stopped
if %BF_STOP_ELAPSED% GEQ %BF_STOP_TIMEOUT% (call :fail "health check timed out; PID %BF_CHILD_PID% may still own ports %BF_PUBLIC_PORT% and %BF_INTERNAL_PORT%; inspect the application log and retry stop.bat --stop-timeout %BF_STOP_TIMEOUT%" & exit /b 1)
powershell.exe -NoProfile -Command "Start-Sleep -Seconds ([int]$env:BF_POLL_INTERVAL)"
set /a BF_STOP_ELAPSED+=BF_POLL_INTERVAL
goto start_timeout_wait
:start_timeout_stopped
del /q "%BF_PID_FILE%" >nul 2>nul
del /q "%BF_SHUTDOWN_FILE%" >nul 2>nul
call :fail "health check timed out after %BF_STARTUP_TIMEOUT% seconds; the application then closed normally"
exit /b 1

:stop
if defined BF_ARG1 if /I not "%BF_ARG1%"=="--stop-timeout" (call :fail "usage: stop.bat [--stop-timeout SECONDS]" & exit /b 1)
if /I "%BF_ARG1%"=="--stop-timeout" if not defined BF_ARG2 (call :fail "--stop-timeout requires seconds" & exit /b 1)
if defined BF_ARG3 (call :fail "usage: stop.bat [--stop-timeout SECONDS]" & exit /b 1)
if /I "%BF_ARG1%"=="--stop-timeout" set "BF_STOP_TIMEOUT=%BF_ARG2%"
set "BF_TIMEOUT_VALUE=%BF_STOP_TIMEOUT%"
powershell.exe -NoProfile -Command "$v=0; if(-not [int]::TryParse($env:BF_TIMEOUT_VALUE,[ref]$v) -or $v -lt 1){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "--stop-timeout must be a positive integer" & exit /b 1)
call :require_files || exit /b 1
call :load_ports || exit /b 1
call :read_pid || exit /b 1
if not defined BF_RECORDED_PID (
  call :port_is_free "%BF_PUBLIC_PORT%" || (call :fail "PID record is absent but public port is listening" & exit /b 1)
  call :port_is_free "%BF_INTERNAL_PORT%" || (call :fail "PID record is absent but internal port is listening" & exit /b 1)
  echo %BF_PROJECT_NAME% is already stopped.
  exit /b 0
)
call :pid_alive "%BF_RECORDED_PID%" || goto remove_stale_pid
call :assert_application_pid "%BF_RECORDED_PID%" || exit /b 1
type nul > "%BF_SHUTDOWN_FILE%" || (call :fail "normal shutdown request could not be written for PID %BF_RECORDED_PID%" & exit /b 1)
set /a BF_ELAPSED=0
:stop_wait_loop
call :pid_alive "%BF_RECORDED_PID%" || goto stop_confirm_ports
if %BF_ELAPSED% GEQ %BF_STOP_TIMEOUT% (call :fail "PID %BF_RECORDED_PID% did not exit; inspect ports %BF_PUBLIC_PORT% and %BF_INTERNAL_PORT% plus the application log, then retry stop.bat --stop-timeout %BF_STOP_TIMEOUT%" & exit /b 1)
powershell.exe -NoProfile -Command "Start-Sleep -Seconds ([int]$env:BF_POLL_INTERVAL)"
set /a BF_ELAPSED+=BF_POLL_INTERVAL
goto stop_wait_loop
:stop_confirm_ports
call :port_is_free "%BF_PUBLIC_PORT%" || (call :fail "application exited but public port remains listening" & exit /b 1)
call :port_is_free "%BF_INTERNAL_PORT%" || (call :fail "application exited but internal port remains listening" & exit /b 1)
del /q "%BF_PID_FILE%" >nul 2>nul
del /q "%BF_SHUTDOWN_FILE%" >nul 2>nul
echo %BF_PROJECT_NAME% PID %BF_RECORDED_PID% stopped.
exit /b 0
:remove_stale_pid
call :port_is_free "%BF_PUBLIC_PORT%" || (call :fail "recorded PID exited but public port remains listening" & exit /b 1)
call :port_is_free "%BF_INTERNAL_PORT%" || (call :fail "recorded PID exited but internal port remains listening" & exit /b 1)
del /q "%BF_PID_FILE%" >nul 2>nul
echo Removed stale PID record for process %BF_RECORDED_PID%.
exit /b 0

:backup
if defined BF_ARG1 (call :fail "backup accepts no arguments" & exit /b 1)
call :require_files || exit /b 1
call :load_ports || exit /b 1
call :assert_stopped || exit /b 1
call :create_backup_with_release || exit /b 1
exit /b 0

:create_backup_with_release
if not exist "%BF_ROOT%\.git\" (call :fail "backup requires a Git installation so its release can be restored" & exit /b 1)
pushd "%BF_ROOT%"
set "BF_BACKUP_TAG="
for /f "delims=" %%T in ('git describe --tags --exact-match 2^>nul') do set "BF_BACKUP_TAG=%%T"
if not defined BF_BACKUP_TAG (popd & call :fail "backup requires the installed commit to be an exact release tag" & exit /b 1)
set "BF_BACKUP_REPOSITORY="
for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "BF_BACKUP_REPOSITORY=%%R"
if not defined BF_BACKUP_REPOSITORY (popd & call :fail "backup could not read the origin repository" & exit /b 1)
if /I not "%BF_BACKUP_REPOSITORY%"=="%BF_REPOSITORY%" (popd & call :fail "backup origin must match the configured release repository" & exit /b 1)
set "BF_BACKUP_OUTPUT=%TEMP%\booruflow-backup-%RANDOM%-%RANDOM%.txt"
node scripts\prod-backup.mjs >"%BF_BACKUP_OUTPUT%" 2>&1
set "BF_RESULT=%ERRORLEVEL%"
popd
type "%BF_BACKUP_OUTPUT%"
if not "%BF_RESULT%"=="0" (del /q "%BF_BACKUP_OUTPUT%" & call :fail "runtime backup did not complete" & exit /b 1)
set "BF_BACKUP_NAME="
for /f "tokens=3" %%B in ('findstr /B /C:"Production backup " "%BF_BACKUP_OUTPUT%"') do set "BF_BACKUP_NAME=%%B"
del /q "%BF_BACKUP_OUTPUT%"
if not defined BF_BACKUP_NAME (call :fail "runtime backup did not report a backup identifier" & exit /b 1)
set "BF_BACKUP_NAME_CHECK=%BF_BACKUP_NAME%"
powershell.exe -NoProfile -Command "if($env:BF_BACKUP_NAME_CHECK -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$'){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "runtime backup reported an invalid backup identifier" & exit /b 1)
if not exist "%BF_BACKUP_VERSION_DIRECTORY%\" mkdir "%BF_BACKUP_VERSION_DIRECTORY%" || (call :fail "backup version metadata directory could not be created" & exit /b 1)
set "BF_BACKUP_METADATA=%BF_BACKUP_VERSION_DIRECTORY%\%BF_BACKUP_NAME%.json"
>"%BF_BACKUP_METADATA%" echo {
>>"%BF_BACKUP_METADATA%" echo   "metadata_version": 1,
>>"%BF_BACKUP_METADATA%" echo   "backup": "%BF_BACKUP_NAME%",
>>"%BF_BACKUP_METADATA%" echo   "tag": "%BF_BACKUP_TAG%",
>>"%BF_BACKUP_METADATA%" echo   "repository_https": "%BF_BACKUP_REPOSITORY%"
>>"%BF_BACKUP_METADATA%" echo }
exit /b 0

:restore
if /I not "%BF_ARG1%"=="--backup" (call :fail "usage: restore.bat --backup data/recovery/backup-directory" & exit /b 1)
if not defined BF_ARG2 (call :fail "--backup requires a data/recovery directory" & exit /b 1)
if defined BF_ARG3 (call :fail "usage: restore.bat --backup data/recovery/backup-directory" & exit /b 1)
set "BF_RESTORE_ARGUMENT=%BF_ARG2%"
powershell.exe -NoProfile -Command "if($env:BF_RESTORE_ARGUMENT -notmatch '^data/recovery/[A-Za-z0-9][A-Za-z0-9._-]*$'){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "--backup must name one direct data/recovery backup directory" & exit /b 1)
for %%B in ("%BF_RESTORE_ARGUMENT%") do set "BF_RESTORE_NAME=%%~nxB"
if not exist "%BF_ROOT%\%BF_RESTORE_ARGUMENT%\" (call :fail "backup directory is missing under data/recovery" & exit /b 1)
set "BF_RESTORE_METADATA=%BF_BACKUP_VERSION_DIRECTORY%\%BF_RESTORE_NAME%.json"
if not exist "%BF_RESTORE_METADATA%" (call :fail "matching release metadata is missing beside the backup directory" & exit /b 1)
set "BF_RESTORE_METADATA_PATH=%BF_RESTORE_METADATA%"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$m=Get-Content -Raw -LiteralPath $env:BF_RESTORE_METADATA_PATH|ConvertFrom-Json; if($m.metadata_version -ne 1 -or $m.backup -ne $env:BF_RESTORE_NAME){exit 1}; $m.tag"`) do set "BF_RECOVERY_TAG=%%V"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$m=Get-Content -Raw -LiteralPath $env:BF_RESTORE_METADATA_PATH|ConvertFrom-Json; $m.repository_https"`) do set "BF_RECOVERY_REPOSITORY=%%V"
if not defined BF_RECOVERY_TAG (call :fail "backup release metadata is missing its tag" & exit /b 1)
set "BF_RECOVERY_TAG_CHECK=%BF_RECOVERY_TAG%"
powershell.exe -NoProfile -Command "if($env:BF_RECOVERY_TAG_CHECK -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$'){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "backup release metadata contains an invalid tag" & exit /b 1)
if not defined BF_RECOVERY_REPOSITORY (call :fail "backup release metadata is missing its repository" & exit /b 1)
if /I not "%BF_RECOVERY_REPOSITORY%"=="%BF_REPOSITORY%" (call :fail "backup release metadata repository does not match this release configuration" & exit /b 1)
if not exist "%BF_ROOT%\.git\" (call :fail "restore requires the installation Git directory" & exit /b 1)
where git >nul 2>nul || (call :fail "restore requires Git on PATH" & exit /b 1)
where npm >nul 2>nul || (call :fail "restore requires npm on PATH" & exit /b 1)
where node >nul 2>nul || (call :fail "restore requires Node.js on PATH" & exit /b 1)
set "BF_ENV_PATH=%BF_ROOT%\%BF_RESTORE_ARGUMENT%\.installation\.env"
call :load_ports_from_file || exit /b 1
call :assert_stopped || exit /b 1
pushd "%BF_ROOT%"
git remote set-url origin "%BF_RECOVERY_REPOSITORY%" && git fetch --tags origin && git checkout --detach "%BF_RECOVERY_TAG%" && call npm ci
set "BF_RESULT=%ERRORLEVEL%"
popd
if not "%BF_RESULT%"=="0" (call :fail "code restoration failed before runtime data was changed" & exit /b 1)
pushd "%BF_ROOT%"
node scripts\prod-restore.mjs --backup "%BF_RESTORE_ARGUMENT%"
set "BF_RESULT=%ERRORLEVEL%"
popd
if not "%BF_RESULT%"=="0" (call :fail "code and locked dependencies were restored, but configuration, database, or media restoration failed" & exit /b 1)
echo Code, locked dependencies, configuration, database, and media were restored to %BF_RECOVERY_TAG%.
exit /b 0

:update
set "BF_TARGET=%BF_DEFAULT_TAG%"
if defined BF_ARG1 if /I not "%BF_ARG1%"=="--tag" (call :fail "usage: update.bat [--tag vX.Y.Z]" & exit /b 1)
if /I "%BF_ARG1%"=="--tag" if not defined BF_ARG2 (call :fail "--tag requires vX.Y.Z" & exit /b 1)
if defined BF_ARG3 (call :fail "usage: update.bat [--tag vX.Y.Z]" & exit /b 1)
if /I "%BF_ARG1%"=="--tag" set "BF_TARGET=%BF_ARG2%"
set "BF_TARGET_CHECK=%BF_TARGET%"
powershell.exe -NoProfile -Command "if($env:BF_TARGET_CHECK -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$'){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "target tag must use vX.Y.Z form" & exit /b 1)
call :require_files || exit /b 1
call :load_ports || exit /b 1
call :assert_stopped || exit /b 1
if not exist "%BF_ROOT%\.git\" (call :fail "the application directory is not a Git installation" & exit /b 1)
pushd "%BF_ROOT%"
for /f "delims=" %%L in ('git status --porcelain') do set "BF_DIRTY=1"
if defined BF_DIRTY (popd & call :fail "the Git worktree contains local changes" & exit /b 1)
for /f "delims=" %%T in ('git describe --tags --exact-match 2^>nul') do set "BF_CURRENT=%%T"
if not defined BF_CURRENT (popd & call :fail "the installed commit is not an exact release tag" & exit /b 1)
call :version_at_least "%BF_TARGET:v=%" "%BF_CURRENT:v=%" || (popd & call :fail "release downgrade is not supported" & exit /b 1)
if /I "%BF_TARGET%"=="%BF_CURRENT%" (popd & echo %BF_TARGET% is already installed. & exit /b 0)
popd
call :create_backup_with_release || (call :fail "pre-update backup failed" & exit /b 1)
pushd "%BF_ROOT%"
git fetch --tags origin && git rev-parse -q --verify "refs/tags/%BF_TARGET%" >nul && git checkout --detach "%BF_TARGET%"
if errorlevel 1 (popd & call :fail "release checkout failed; run restore.bat --backup data/recovery/%BF_BACKUP_NAME%" & exit /b 1)
call npm ci
if errorlevel 1 (popd & call :fail "npm ci failed; run restore.bat --backup data/recovery/%BF_BACKUP_NAME%" & exit /b 1)
node scripts\runtime-data.mjs migrate --root "%BF_ROOT%"
if errorlevel 1 (popd & call :fail "database upgrade failed; run restore.bat --backup data/recovery/%BF_BACKUP_NAME%" & exit /b 1)
node scripts\runtime-data.mjs check --root "%BF_ROOT%"
if errorlevel 1 (popd & call :fail "updated runtime check failed; run restore.bat --backup data/recovery/%BF_BACKUP_NAME%" & exit /b 1)
popd
call :temporary_health || (call :fail "temporary health check failed; run restore.bat --backup data/recovery/%BF_BACKUP_NAME%" & exit /b 1)
echo Update to %BF_TARGET% completed. Start with "%BF_ROOT%\start.bat".
exit /b 0

:temporary_health
for %%I in ("%BF_SHUTDOWN_FILE%") do set "BF_SHUTDOWN_DIRECTORY=%%~dpI"
if not exist "%BF_SHUTDOWN_DIRECTORY%" mkdir "%BF_SHUTDOWN_DIRECTORY%" || exit /b 1
if exist "%BF_SHUTDOWN_FILE%" del /q "%BF_SHUTDOWN_FILE%" || exit /b 1
set "BF_TEMP_HEALTH="
set "BF_START_ROOT=%BF_ROOT%"
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -Command "$a='--env-file=.env '+[char]34+$env:BF_START_SCRIPT+[char]34; $p=Start-Process -FilePath node -ArgumentList $a -WorkingDirectory $env:BF_START_ROOT -WindowStyle Hidden -PassThru; $p.Id"`) do set "BF_TEMP_PID=%%P"
if not defined BF_TEMP_PID exit /b 1
set /a BF_ELAPSED=0
:temporary_health_loop
set "BF_HEALTH_URL=http://127.0.0.1:%BF_PUBLIC_PORT%/"
powershell.exe -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $env:BF_HEALTH_URL; if($r.StatusCode -eq 200){exit 0}}catch{}; exit 1" >nul 2>nul
if errorlevel 1 goto temporary_health_wait
call :port_owned_by "%BF_INTERNAL_PORT%" "%BF_TEMP_PID%"
if not errorlevel 1 (set "BF_TEMP_HEALTH=1" & goto temporary_shutdown)
:temporary_health_wait
if %BF_ELAPSED% GEQ %BF_STARTUP_TIMEOUT% goto temporary_shutdown
powershell.exe -NoProfile -Command "Start-Sleep -Seconds ([int]$env:BF_POLL_INTERVAL)"
set /a BF_ELAPSED+=BF_POLL_INTERVAL
goto temporary_health_loop
:temporary_shutdown
type nul > "%BF_SHUTDOWN_FILE%" || exit /b 1
set /a BF_STOP_ELAPSED=0
:temporary_stop_loop
call :pid_alive "%BF_TEMP_PID%" || goto temporary_stopped
if %BF_STOP_ELAPSED% GEQ %BF_STOP_TIMEOUT% exit /b 1
powershell.exe -NoProfile -Command "Start-Sleep -Seconds ([int]$env:BF_POLL_INTERVAL)"
set /a BF_STOP_ELAPSED+=BF_POLL_INTERVAL
goto temporary_stop_loop
:temporary_stopped
del /q "%BF_SHUTDOWN_FILE%" >nul 2>nul
if defined BF_TEMP_HEALTH exit /b 0
exit /b 1

:data_export
set "BF_OUTPUT="
set "BF_INCLUDE="
if /I "%BF_ARG1%"=="--output" set "BF_OUTPUT=%BF_ARG2%"
if /I "%BF_ARG1%"=="--output" if /I "%BF_ARG3%"=="--include-instances" set "BF_INCLUDE=--include-instances"
if /I "%BF_ARG1%"=="--include-instances" if /I "%BF_ARG2%"=="--output" set "BF_OUTPUT=%BF_ARG3%"
if /I "%BF_ARG1%"=="--include-instances" if /I "%BF_ARG2%"=="--output" set "BF_INCLUDE=--include-instances"
if not defined BF_OUTPUT (call :fail "usage: data-export.bat --output DIR [--include-instances]" & exit /b 1)
if /I "%BF_ARG1%"=="--output" if defined BF_ARG3 if /I not "%BF_ARG3%"=="--include-instances" (call :fail "usage: data-export.bat --output DIR [--include-instances]" & exit /b 1)
if /I "%BF_ARG1%"=="--output" if defined BF_ARG4 (call :fail "usage: data-export.bat --output DIR [--include-instances]" & exit /b 1)
if /I "%BF_ARG1%"=="--include-instances" if defined BF_ARG4 (call :fail "usage: data-export.bat --output DIR [--include-instances]" & exit /b 1)
for %%I in ("%BF_OUTPUT%") do set "BF_OUTPUT=%%~fI"
call :require_files || exit /b 1
call :load_ports || exit /b 1
call :assert_stopped || exit /b 1
pushd "%BF_ROOT%"
node scripts\runtime-data.mjs data-export --root "%BF_ROOT%" --output "%BF_OUTPUT%" %BF_INCLUDE%
set "BF_RESULT=%ERRORLEVEL%"
popd
if not "%BF_RESULT%"=="0" (call :fail "data export failed" & exit /b 1)
exit /b 0

:data_pack
if /I not "%BF_ARG1%"=="--input" (call :fail "usage: data-pack.bat --input DIR --output FILE.tar.gz" & exit /b 1)
if not defined BF_ARG2 (call :fail "--input requires a directory" & exit /b 1)
if /I not "%BF_ARG3%"=="--output" (call :fail "usage: data-pack.bat --input DIR --output FILE.tar.gz" & exit /b 1)
if not defined BF_ARG4 (call :fail "--output requires a .tar.gz file" & exit /b 1)
if defined BF_ARG5 (call :fail "usage: data-pack.bat --input DIR --output FILE.tar.gz" & exit /b 1)
set "BF_INPUT=%BF_ARG2%"
set "BF_OUTPUT=%BF_ARG4%"
for %%I in ("%BF_INPUT%") do set "BF_INPUT=%%~fI"
for %%I in ("%BF_OUTPUT%") do set "BF_OUTPUT=%%~fI"
set "BF_OUTPUT_EXTENSION=%BF_OUTPUT%"
powershell.exe -NoProfile -Command "if(-not $env:BF_OUTPUT_EXTENSION.EndsWith('.tar.gz',[StringComparison]::OrdinalIgnoreCase)){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "--output must end in .tar.gz" & exit /b 1)
if exist "%BF_OUTPUT%" (call :fail "data package output already exists" & exit /b 1)
if not exist "%BF_INPUT%\" (call :fail "data package input directory does not exist" & exit /b 1)
call :require_files || exit /b 1
pushd "%BF_ROOT%"
node scripts\runtime-data.mjs data-validate --root "%BF_ROOT%" --input "%BF_INPUT%"
if errorlevel 1 (popd & call :fail "export directory validation failed" & exit /b 1)
popd
tar.exe -czf "%BF_OUTPUT%" -C "%BF_INPUT%" .
if errorlevel 1 (del /q "%BF_OUTPUT%" >nul 2>nul & call :fail "tar could not create the data package" & exit /b 1)
for %%F in ("%BF_OUTPUT%") do set "BF_ARCHIVE_SIZE=%%~zF"
set "BF_SIZE_VALUE=%BF_ARCHIVE_SIZE%"
set "BF_SIZE_LIMIT=%BF_ARCHIVE_MAX_BYTES%"
powershell.exe -NoProfile -Command "if([int64]$env:BF_SIZE_VALUE -gt [int64]$env:BF_SIZE_LIMIT){exit 1}" >nul 2>nul
if errorlevel 1 (del /q "%BF_OUTPUT%" & call :fail "data package exceeds configured size" & exit /b 1)
echo Data package created: "%BF_OUTPUT%" (%BF_ARCHIVE_SIZE% bytes^)
exit /b 0

:prepare_import_input
set "BF_IMPORT_DIRECTORY=%BF_INPUT%"
if exist "%BF_IMPORT_DIRECTORY%\" exit /b 0
if not exist "%BF_IMPORT_DIRECTORY%" (call :fail "data package input does not exist" & exit /b 1)
for %%F in ("%BF_IMPORT_DIRECTORY%") do set "BF_ARCHIVE_SIZE=%%~zF"
set "BF_SIZE_VALUE=%BF_ARCHIVE_SIZE%"
set "BF_SIZE_LIMIT=%BF_ARCHIVE_MAX_BYTES%"
powershell.exe -NoProfile -Command "if([int64]$env:BF_SIZE_VALUE -gt [int64]$env:BF_SIZE_LIMIT){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "archive exceeds configured size" & exit /b 1)
set "BF_ARCHIVE_LIST=%TEMP%\booruflow-list-%RANDOM%-%RANDOM%.txt"
tar.exe -tzf "%BF_IMPORT_DIRECTORY%" >"%BF_ARCHIVE_LIST%" 2>nul || (del /q "%BF_ARCHIVE_LIST%" >nul 2>nul & call :fail "archive is truncated or invalid" & exit /b 1)
set "BF_LIST_PATH=%BF_ARCHIVE_LIST%"
set "BF_LIST_LIMIT=%BF_ARCHIVE_MAX_ENTRIES%"
powershell.exe -NoProfile -Command "$p=Get-Content -LiteralPath $env:BF_LIST_PATH; if($p.Count -gt [int]$env:BF_LIST_LIMIT){exit 1}; $s=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); foreach($e in $p){if([IO.Path]::IsPathRooted($e) -or $e.Contains('\') -or $e.Contains(':') -or $e -match '[\x00-\x1f\x7f]'){exit 1}; $n=$e; while($n.StartsWith('./')){$n=$n.Substring(2)}; $n=$n.TrimEnd('/'); if($n.Length -eq 0){continue}; $parts=$n -split '/'; if(-not $s.Add($n)){exit 1}; foreach($part in $parts){if($part.Length -eq 0 -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$'){exit 1}; $stem=($part -split '\.')[0]; if($stem -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$'){exit 1}}}" >nul 2>nul
if errorlevel 1 (del /q "%BF_ARCHIVE_LIST%" & call :fail "archive contains too many, unsafe, or duplicate paths" & exit /b 1)
set "BF_ARCHIVE_VERBOSE=%TEMP%\booruflow-verbose-%RANDOM%-%RANDOM%.txt"
tar.exe -tvzf "%BF_IMPORT_DIRECTORY%" >"%BF_ARCHIVE_VERBOSE%" 2>nul || (del /q "%BF_ARCHIVE_LIST%" & del /q "%BF_ARCHIVE_VERBOSE%" >nul 2>nul & call :fail "archive verbose listing failed" & exit /b 1)
set "BF_VERBOSE_PATH=%BF_ARCHIVE_VERBOSE%"
set "BF_SIZE_LIMIT=%BF_ARCHIVE_MAX_BYTES%"
powershell.exe -NoProfile -Command "$total=[int64]0; foreach($line in Get-Content -LiteralPath $env:BF_VERBOSE_PATH){if($line -notmatch '^[-d]'){exit 1}; if($line -match '^-'){ $fields=$line -split '\s+'; $total += [int64]$fields[4]; if($total -gt [int64]$env:BF_SIZE_LIMIT){exit 1}}}" >nul 2>nul
if errorlevel 1 (del /q "%BF_ARCHIVE_LIST%" & del /q "%BF_ARCHIVE_VERBOSE%" & call :fail "archive contains an unsupported entry type or exceeds the expanded-size limit" & exit /b 1)
del /q "%BF_ARCHIVE_VERBOSE%"
del /q "%BF_ARCHIVE_LIST%"
set "BF_ARCHIVE_SOURCE=%BF_IMPORT_DIRECTORY%"
set "BF_IMPORT_DIRECTORY=%TEMP%\booruflow-import-%RANDOM%-%RANDOM%"
mkdir "%BF_IMPORT_DIRECTORY%" || (call :fail "temporary import directory could not be created" & exit /b 1)
tar.exe -xzf "%BF_ARCHIVE_SOURCE%" -C "%BF_IMPORT_DIRECTORY%" || (rmdir /s /q "%BF_IMPORT_DIRECTORY%" & call :fail "archive extraction failed" & exit /b 1)
set "BF_IMPORT_TEMP=1"
exit /b 0

:data_import
set "BF_INPUT="
set "BF_MODE="
set "BF_BATCH="
if /I "%BF_ARG1%"=="--input" if /I "%BF_ARG3%"=="--check" if not defined BF_ARG4 (set "BF_INPUT=%BF_ARG2%" & set "BF_MODE=check")
if /I "%BF_ARG1%"=="--input" if /I "%BF_ARG3%"=="--apply" if not defined BF_ARG4 (set "BF_INPUT=%BF_ARG2%" & set "BF_MODE=apply")
if /I "%BF_ARG1%"=="--recover" if /I "%BF_ARG2%"=="--batch" if not defined BF_ARG4 (set "BF_BATCH=%BF_ARG3%" & set "BF_MODE=recover")
if not defined BF_MODE (call :fail "usage: data-import.bat --input PATH --check or --apply; or --recover --batch ID" & exit /b 1)
if /I not "%BF_MODE%"=="recover" if not defined BF_INPUT (call :fail "--input requires a path" & exit /b 1)
if /I "%BF_MODE%"=="recover" if not defined BF_BATCH (call :fail "--batch requires an ID" & exit /b 1)
call :require_files || exit /b 1
call :load_ports || exit /b 1
call :assert_stopped || exit /b 1
if /I "%BF_MODE%"=="recover" goto data_recover
for %%I in ("%BF_INPUT%") do set "BF_INPUT=%%~fI"
call :prepare_import_input || exit /b 1
pushd "%BF_ROOT%"
if /I "%BF_MODE%"=="check" (node scripts\runtime-data.mjs data-check --root "%BF_ROOT%" --input "%BF_IMPORT_DIRECTORY%") else node scripts\runtime-data.mjs data-import --root "%BF_ROOT%" --input "%BF_IMPORT_DIRECTORY%"
set "BF_RESULT=%ERRORLEVEL%"
popd
if defined BF_IMPORT_TEMP rmdir /s /q "%BF_IMPORT_DIRECTORY%"
if not "%BF_RESULT%"=="0" (call :fail "data import failed during application validation or database work" & exit /b 1)
exit /b 0
:data_recover
pushd "%BF_ROOT%"
node scripts\runtime-data.mjs data-recover --root "%BF_ROOT%" --batch "%BF_BATCH%"
set "BF_RESULT=%ERRORLEVEL%"
popd
if not "%BF_RESULT%"=="0" (call :fail "data import batch recovery failed" & exit /b 1)
exit /b 0
