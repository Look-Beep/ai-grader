@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. / 未检测到 Node.js
  echo Please install Node.js 18 or newer: https://nodejs.org/
  echo 请先安装 Node.js 18 或更高版本，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

rem Default: LAN mode (other computers / phones can open it)
rem Usage: start.bat local   -> localhost only
if /i "%~1"=="local" (
  set HOST=127.0.0.1
)

node server.js
pause
