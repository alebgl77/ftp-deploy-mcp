@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERREUR/ERROR] Node.js est introuvable / Node.js was not found.
  echo Installez Node.js 22+ depuis https://nodejs.org puis relancez ce script.
  echo Install Node.js 22+ from https://nodejs.org, then re-run this script.
  echo.
  pause
  exit /b 1
)

echo Installation des dependances / Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [ERREUR/ERROR] npm install a echoue / npm install failed.
  echo.
  pause
  exit /b 1
)

node src\index.js setup

echo.
pause
