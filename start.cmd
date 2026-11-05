@echo off
setlocal
cd /d "%~dp0"
set "MONITOR_HOST_DISPLAY=%MONITOR_HOST%"
if not defined MONITOR_HOST_DISPLAY set "MONITOR_HOST_DISPLAY=127.0.0.1"
set "MONITOR_PORT_DISPLAY=%MONITOR_PORT%"
if not defined MONITOR_PORT_DISPLAY set "MONITOR_PORT_DISPLAY=4420"
start "Agent Monitor" cmd /k "node --disable-warning=ExperimentalWarning src/server.ts"
timeout /t 2 >nul
start "" "http://%MONITOR_HOST_DISPLAY%:%MONITOR_PORT_DISPLAY%"
endlocal
