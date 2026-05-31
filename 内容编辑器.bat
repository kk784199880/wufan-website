@echo off
chcp 65001 >nul
title 吴凡个人网站 - 内容编辑器
echo.
echo   🔧 吴凡个人网站 - 内容编辑器
echo   ────────────────────────────
echo.
cd /d "%~dp0admin"
node server.mjs
pause
