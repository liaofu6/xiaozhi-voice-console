@echo off
chcp 65001 >nul
cd /d "%~dp0"
title xiaozhi music mcp

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ first.
  pause
  exit /b 1
)

if exist cookie.txt (
  set /p COOKIE=<cookie.txt
  set METING_NETEASE_COOKIE=%COOKIE%
) else (
  echo [WARN] cookie.txt not found. Free songs only.
)

if exist endpoint.txt set /p MCP_ENDPOINT=<endpoint.txt

rem 可选：自定义 ffmpeg 路径（不设置则使用 PATH 中的 ffmpeg）
if exist "E:\ffmpeg\ffmpeg.exe" set "FFMPEG=E:\ffmpeg\ffmpeg.exe"
if defined FFMPEG echo ffmpeg: %FFMPEG%

echo starting xiaozhi music mcp ...
echo probe:   http://127.0.0.1:3000/probe
echo oggtest: http://127.0.0.1:3000/oggtest
echo.

node server.js

echo.
echo server stopped.
pause
