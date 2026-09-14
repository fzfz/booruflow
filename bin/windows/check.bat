@echo off
setlocal EnableExtensions DisableDelayedExpansion
for %%I in ("%~dp0..\..") do set "BF_ROOT=%%~fI"
"%BF_ROOT%\scripts\platform\windows\operations.bat" "check" %*
