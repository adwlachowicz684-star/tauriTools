@echo off
rem 分配项目组 - 一键编译（调用同目录 build.ps1，产物 dist\分配项目组.exe）
title 分配项目组 - 一键编译
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
echo.
pause
