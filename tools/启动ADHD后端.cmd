@echo off
chcp 65001 >nul
title ADHD Backend Launcher
if not exist "%~dp0ADHD-AB协作版\tools\start-backend.ps1" (
  echo Backend launcher was not found in ADHD project folder.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0ADHD-AB协作版\tools\start-backend.ps1"
