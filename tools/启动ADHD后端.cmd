@echo off
chcp 65001 >nul
title ADHD Backend Launcher
set "backendLauncher=%~dp0start-backend.ps1"
if not exist "%backendLauncher%" set "backendLauncher=%~dp0ADHD-AB协作版\tools\start-backend.ps1"
if not exist "%backendLauncher%" (
  echo Backend launcher was not found in ADHD project folder.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%backendLauncher%"
