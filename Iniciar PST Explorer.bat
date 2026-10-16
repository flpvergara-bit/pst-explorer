@echo off
title PST Explorer
cd /d "%~dp0"
where node >nul 2>nul || (echo Necesitas instalar Node.js 22 o superior desde https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencias... & call npm install --omit=dev)
echo Iniciando PST Explorer... (cierra esta ventana para detenerlo)
node server.js --open
pause
