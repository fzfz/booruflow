@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem These defaults are generated from config\release\release.json so this
rem installer can run before the repository exists.
set "BF_PROJECT_NAME=BooruFlow"
set "BF_REPOSITORY=https://github.com/fzfz/booruflow.git"
set "BF_TAG=v0.88.0"
set "BF_NODE_MINIMUM=24.21.0"
set "BF_NPM_MINIMUM=10.9.3"
set "BF_GIT_MINIMUM=2.55.0"
set "BF_NODE_URL=https://nodejs.org/en/download"
set "BF_GIT_URL=https://git-scm.com/downloads"
set "BF_STARTUP_CWD=%CD%"
set "BF_DIRECTORY="
set "BF_INSTALLER_PATH=%~f0"

:parse_arguments
if "%~1"=="" goto arguments_complete
if /I "%~1"=="--directory" (
  if "%~2"=="" (call :fail "--directory requires a path" & exit /b 1)
  set "BF_DIRECTORY=%~2"
  shift
  shift
  goto parse_arguments
)
if /I "%~1"=="--tag" (
  if "%~2"=="" (call :fail "--tag requires vX.Y.Z" & exit /b 1)
  set "BF_TAG=%~2"
  shift
  shift
  goto parse_arguments
)
if /I "%~1"=="--help" goto usage
if /I "%~1"=="-h" goto usage
call :fail "an unknown installer argument was provided; run install.bat --help"
exit /b 1

:usage
echo Usage: install.bat [--directory PATH] [--tag vX.Y.Z]
exit /b 0

:arguments_complete
echo %BF_PROJECT_NAME% installer
echo Startup working directory and default installation directory: "%BF_STARTUP_CWD%"
if not defined BF_DIRECTORY set /p "BF_DIRECTORY=Press Enter to use the default directory, or enter another installation directory: "
if not defined BF_DIRECTORY set "BF_DIRECTORY=%BF_STARTUP_CWD%"
for %%I in ("%BF_DIRECTORY%") do set "BF_DESTINATION=%%~fI"
echo Final installation directory: "%BF_DESTINATION%"

if /I not "%OS%"=="Windows_NT" (call :fail "this installer supports Windows" & exit /b 1)
if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto architecture_ok
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto architecture_ok
call :fail "this installer supports Windows x64; detected %PROCESSOR_ARCHITECTURE%"
exit /b 1
:architecture_ok
echo Platform: Windows x64

set "BF_DESTINATION_CHECK=%BF_DESTINATION%"
powershell.exe -NoProfile -Command "$p=[IO.Path]::GetFullPath($env:BF_DESTINATION_CHECK); while(-not [IO.Directory]::Exists($p)){ $next=[IO.Directory]::GetParent($p); if($null -eq $next){exit 1}; $p=$next.FullName }; $probe=Join-Path $p ('.booruflow-write-'+[Guid]::NewGuid().ToString('N')); try { [IO.File]::WriteAllText($probe,''); [IO.File]::Delete($probe) } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (call :fail "the installation directory or its nearest existing parent is not writable" & exit /b 1)

call :require_tool node "%BF_NODE_MINIMUM%" "%BF_NODE_URL%"
if errorlevel 1 exit /b 1
call :require_tool npm "%BF_NPM_MINIMUM%" "%BF_NODE_URL%"
if errorlevel 1 exit /b 1
call :require_tool git "%BF_GIT_MINIMUM%" "%BF_GIT_URL%"
if errorlevel 1 exit /b 1
where tar.exe >nul 2>nul || (call :fail "Windows system tar is missing from PATH" & exit /b 1)
set "BF_TAR_VERSION="
for /f "delims=" %%V in ('tar.exe --version 2^>nul') do if not defined BF_TAR_VERSION set "BF_TAR_VERSION=%%V"
if not defined BF_TAR_VERSION (call :fail "Windows system tar exists but cannot run its version check" & exit /b 1)
echo tar: %BF_TAR_VERSION%

set "BF_TAG_CHECK=%BF_TAG%"
powershell.exe -NoProfile -Command "if($env:BF_TAG_CHECK -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$'){exit 1}" >nul 2>nul
if errorlevel 1 (call :fail "the release tag must use vX.Y.Z form" & exit /b 1)
echo Repository: %BF_REPOSITORY%
echo Release tag: %BF_TAG%
git ls-remote --exit-code --tags "%BF_REPOSITORY%" "refs/tags/%BF_TAG%" >nul 2>nul
if errorlevel 1 (call :fail "repository or release tag is unavailable: %BF_TAG%" & exit /b 1)

set "BF_INSTALL_IN_PLACE="
if not exist "%BF_DESTINATION%" goto clone_release
if not exist "%BF_DESTINATION%\" (call :fail "the installation path exists and is not a directory" & exit /b 1)
if exist "%BF_DESTINATION%\.git\" if exist "%BF_DESTINATION%\package.json" (call :fail "an existing installation was found; run its update.bat script" & exit /b 1)
set "BF_INSTALLER_CHECK_DESTINATION=%BF_DESTINATION%"
set "BF_INSTALLER_CHECK_SOURCE=%BF_INSTALLER_PATH%"
powershell.exe -NoProfile -Command "$items=@(Get-ChildItem -Force -LiteralPath $env:BF_INSTALLER_CHECK_DESTINATION); if($items.Count -eq 0){exit 0}; if($items.Count -eq 1 -and -not $items[0].PSIsContainer -and $items[0].FullName.Equals($env:BF_INSTALLER_CHECK_SOURCE,[StringComparison]::OrdinalIgnoreCase)){exit 10}; exit 1" >nul 2>nul
set "BF_INSTALLER_CHECK_RESULT=%ERRORLEVEL%"
if "%BF_INSTALLER_CHECK_RESULT%"=="10" set "BF_INSTALL_IN_PLACE=1"
if not "%BF_INSTALLER_CHECK_RESULT%"=="0" if not "%BF_INSTALLER_CHECK_RESULT%"=="10" (call :fail "the installation directory contains files other than this installer" & exit /b 1)

:clone_release
echo Cloning %BF_REPOSITORY% at %BF_TAG%...
set "BF_CLONE_DESTINATION=%BF_DESTINATION%"
if defined BF_INSTALL_IN_PLACE set "BF_CLONE_DESTINATION=%BF_DESTINATION%.clone-%RANDOM%-%RANDOM%"
if defined BF_INSTALL_IN_PLACE if exist "%BF_CLONE_DESTINATION%" (call :fail "the temporary clone directory already exists" & exit /b 1)
git clone --branch "%BF_TAG%" --depth 1 "%BF_REPOSITORY%" "%BF_CLONE_DESTINATION%"
if errorlevel 1 (
  echo Clone stopped while writing: "%BF_CLONE_DESTINATION%" 1>&2
  call :fail "git clone failed; inspect or remove the remaining target directory before retrying"
  exit /b 1
)
if defined BF_INSTALL_IN_PLACE (
  fc.exe /B "%BF_INSTALLER_PATH%" "%BF_CLONE_DESTINATION%\install.bat" >nul 2>nul || (call :fail "the installer differs from the selected tag; download that tag's install.bat or choose another empty installation directory" & exit /b 1)
  robocopy.exe "%BF_CLONE_DESTINATION%" "%BF_DESTINATION%" /E /MOVE /XF install.bat /R:0 /W:0 >nul
  if errorlevel 8 (call :fail "the temporary clone could not be moved into the installation directory" & exit /b 1)
  if exist "%BF_CLONE_DESTINATION%\install.bat" del /q "%BF_CLONE_DESTINATION%\install.bat" >nul 2>nul
  if exist "%BF_CLONE_DESTINATION%" (
    rmdir "%BF_CLONE_DESTINATION%"
    if errorlevel 1 (call :fail "the empty temporary clone directory could not be removed" & exit /b 1)
  )
)
if not exist "%BF_DESTINATION%\package.json" (call :fail "the cloned release is missing package.json" & exit /b 1)
if not exist "%BF_DESTINATION%\package-lock.json" (call :fail "the cloned release is missing package-lock.json" & exit /b 1)

pushd "%BF_DESTINATION%" || (call :fail "the cloned installation directory cannot be opened" & exit /b 1)
echo Installing the dependencies locked by package-lock.json with npm ci...
call npm ci
set "BF_NPM_STATUS=%ERRORLEVEL%"
if not "%BF_NPM_STATUS%"=="0" (
  popd
  echo Repair Node.js and npm from %BF_NODE_URL%. The cloned directory remains in the displayed installation directory. Inspect it, remove that new failed directory, then rerun this installer. 1>&2
  call :fail "npm ci failed while installing locked dependencies"
  exit /b 1
)

if exist ".env" goto preserve_environment
if not exist ".env.example" (popd & call :fail "the cloned release is missing .env.example" & exit /b 1)
copy /Y ".env.example" ".env" >nul || (popd & call :fail "the environment template could not be copied" & exit /b 1)
where powershell.exe >nul 2>nul || (popd & call :fail "Windows PowerShell is required to create the ComfyUI credential encryption key" & exit /b 1)
set "BF_COMFYUI_KEY="
for /f "usebackq delims=" %%K in (`powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $b=New-Object byte[] 32; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($b) } finally { $rng.Dispose() }; -join ($b | ForEach-Object { $_.ToString('x2') })"`) do set "BF_COMFYUI_KEY=%%K"
if not defined BF_COMFYUI_KEY (popd & call :fail "the ComfyUI credential encryption key could not be generated" & exit /b 1)
set "BF_COMFYUI_KEY_CHECK=%BF_COMFYUI_KEY%"
powershell.exe -NoProfile -Command "if($env:BF_COMFYUI_KEY_CHECK -notmatch '^[a-f0-9]{64}$' -or $env:BF_COMFYUI_KEY_CHECK -eq ('0'*64)){exit 1}" >nul 2>nul
if errorlevel 1 (popd & call :fail "the ComfyUI credential encryption key result is invalid" & exit /b 1)
>>".env" echo.
>>".env" echo NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY=%BF_COMFYUI_KEY%
echo Created .env with a new ComfyUI credential encryption key.
goto initialize_database

:preserve_environment
echo Existing .env and ComfyUI credential encryption key were preserved.

:initialize_database
if not exist "scripts\runtime-data.mjs" (popd & call :fail "the release is missing scripts\runtime-data.mjs" & exit /b 1)
node scripts\runtime-data.mjs init --root "%BF_DESTINATION%"
if errorlevel 1 (popd & call :fail "empty database or media initialization failed" & exit /b 1)

set "BF_CONFIGURATION_STATUS=ready"
for %%N in (NOOBAI_EMBEDDING_BASE_URL NOOBAI_EMBEDDING_API_KEY NOOBAI_EMBEDDING_MODEL NOOBAI_RERANKER_BASE_URL NOOBAI_RERANKER_API_KEY NOOBAI_RERANKER_MODEL) do call :check_configuration %%N
popd
echo Installation directory: "%BF_DESTINATION%"
echo Installed release: %BF_TAG%
if /I "%BF_CONFIGURATION_STATUS%"=="ready" (
  echo Installation complete. Configuration is ready.
) else (
  echo Installation complete, configuration pending. Fill the listed values before starting.
)
echo Start with: "%BF_DESTINATION%\start.bat"
exit /b 0

:check_configuration
findstr /B /L "%~1=" ".env" | findstr /R /V /X "%~1=" >nul
if errorlevel 1 (
  echo Configuration required in "%BF_DESTINATION%\.env": %~1
  set "BF_CONFIGURATION_STATUS=configuration pending"
)
exit /b 0

:require_tool
where %~1 >nul 2>nul
if errorlevel 1 (
  echo %~1 is missing or PATH does not contain its executable. 1>&2
  echo Required version: %~2 or later. Official installer: %~3 1>&2
  call :fail "%~1 is required"
  exit /b 1
)
if /I "%~1"=="git" (
  for /f "tokens=3" %%V in ('git --version 2^>nul') do set "BF_TOOL_VERSION=%%V"
) else (
  for /f "delims=" %%V in ('%~1 --version 2^>nul') do set "BF_TOOL_VERSION=%%V"
)
if not defined BF_TOOL_VERSION (call :fail "%~1 exists on PATH but its version command failed" & exit /b 1)
set "BF_TOOL_VERSION=%BF_TOOL_VERSION:v=%"
call :version_at_least "%BF_TOOL_VERSION%" "%~2"
if errorlevel 1 (
  echo %~1 version is unsupported: %BF_TOOL_VERSION% 1>&2
  echo Required version: %~2 or later. Official installer: %~3 1>&2
  call :fail "%~1 must be upgraded"
  exit /b 1
)
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

:fail
echo Installation failed: %~1 1>&2
echo Resolve the reported problem, then run this installer again. 1>&2
exit /b 1
