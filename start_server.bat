@echo off
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node server.js
) else (
  "C:\Program Files\nodejs\node.exe" server.js
)
pause
