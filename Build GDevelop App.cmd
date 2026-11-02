@echo off
REM ---------------------------------------------------------------------------
REM  Build the GDevelop desktop app (Electron) - double click this file.
REM  The build can take several minutes: the console shows each step.
REM ---------------------------------------------------------------------------
setlocal
title GDevelop - Build the desktop app
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found in your PATH.
  echo         Install the LTS version from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

echo Building GDevelop... this can take several minutes.
echo.
node "newIDE\scripts\build-desktop-app.js" --open-folder %*
set BUILD_EXIT_CODE=%ERRORLEVEL%

echo.
if "%BUILD_EXIT_CODE%"=="0" (
  echo Build finished successfully.
) else (
  echo Build FAILED ^(exit code %BUILD_EXIT_CODE%^).
)
echo.
pause
exit /b %BUILD_EXIT_CODE%
