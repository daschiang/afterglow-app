@echo off
title Afterglow
cd /d "%~dp0"

if not exist node_modules (
  echo First time setup - installing packages, please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo Install failed. Please make sure Node.js 22.5 or newer is installed.
    echo Download it from: https://nodejs.org  (choose the LTS version)
    echo.
    pause
    exit /b 1
  )
)

if not exist .env (
  echo.
  echo .env file not found!
  echo Please copy .env.example, rename the copy to .env,
  echo fill in your OPENAI_API_KEY, then run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting the Afterglow server, please wait...
start "Afterglow Server" /min cmd /c "node server.js"
timeout /t 3 /nobreak >nul
start "" http://localhost:3000

echo.
echo The server is now running in the background.
echo Your browser should have opened automatically.
echo If it did not, open this address manually: http://localhost:3000
echo.
echo To stop Afterglow: find the minimized window titled
echo "Afterglow Server" in your taskbar (or press Alt+Tab), and close it.
echo This window (the one you're reading right now) can be closed
echo safely without affecting the running server.
echo.
pause
