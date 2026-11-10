@echo off
setlocal
title MCA - Middle East Combat Arena
cd /d "%~dp0"

REM One-click launcher: installs dependencies on first run, builds the game,
REM starts the local server and opens it in your default browser.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 or newer is required. You have:
  node -v
  echo Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\vite" (
  echo Installing dependencies - first run only, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo Building the game...
call npm run build
if errorlevel 1 (
  echo The build failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo MCA is starting on http://localhost:8790
echo Keep this window open while you play. Close it to stop the game.
echo.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8790/"
node server\index.js
pause
