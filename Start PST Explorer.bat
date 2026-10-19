@echo off
title PST Explorer
cd /d "%~dp0"
where node >nul 2>nul || (echo You need to install Node.js 22 or later from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installing dependencies... & call npm install --omit=dev)
echo Starting PST Explorer... (close this window to stop it)
node server.js --open
pause
