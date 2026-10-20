@echo off
chcp 65001 >nul
title ADHD Main System - 8000
if not exist "%~dp0tools\start-backend.ps1" (
  echo Demo launcher was not found. Keep this file inside the project folder.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-backend.ps1" -NoPause
set "demoExit=%errorlevel%"
if "%demoExit%"=="0" (
  echo.
  echo Examples and regular accounts now use the same main system.
  echo User login:   http://127.0.0.1:8000/patient-web/login.html
  echo Doctor login: http://127.0.0.1:8000/doctor-web/login.html
  echo Mini program server: http://127.0.0.1:8000/api/v1
)
pause
exit /b %demoExit%
