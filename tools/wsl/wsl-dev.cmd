@echo off
rem WSL2 dev environment launcher - bypasses .ps1 execution policy (no system settings changed)
rem Usage: tools\wsl\wsl-dev.cmd [code|shell|health|build|serve|clean|status|push]
chcp 65001 >nul 2>&1
setlocal
powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0wsl-dev.ps1" %*
exit /b %ERRORLEVEL%
