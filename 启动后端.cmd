@echo off
chcp 65001 >nul
title ADHD Backend - 8000
if not exist "%~dp0tools\start-backend.ps1" (
  echo Backend launcher was not found. Keep this file inside the project folder.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-backend.ps1" -Stable %*
exit /b %errorlevel%
