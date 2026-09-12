@echo off
rem 分配项目组 - 单文件发布（调用同目录 publish-single.ps1，产物 dist\single\分配项目组.exe）
title 分配项目组 - 单文件发布
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-single.ps1" %*
echo.
pause
