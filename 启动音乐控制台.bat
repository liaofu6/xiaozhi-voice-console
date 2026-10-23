@echo off
chcp 65001 >nul
setlocal
set "DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 后再运行。
  pause
  exit /b 1
)

rem 若控制台已在运行，直接打开窗口
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',3210);exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 (
  start "" /b wscript.exe "%DIR%_panel_launch.vbs" "%DIR%panel.js"
  timeout /t 2 /nobreak >nul
)

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app="http://127.0.0.1:3210" --window-size=980,760
) else (
  start "" "http://127.0.0.1:3210"
)
exit /b 0
