@echo off
cd /d "%~dp0\..\.."
set "NICEGAL_STATE_DIR=%APPDATA%\nicegal\nicegal-server"
set "NICEGAL_RUNTIME_CONFIG=%LOCALAPPDATA%\nicegal-server\runtime.json"
set "NICEGAL_LOCAL_MODELS_DIR=%CD%\temp\clip-models\exports"
set "NICEGAL_SERVER_PATH=%CD%\nicegal-server\target\debug\nicegal-server.exe"
set "NICEGAL_IMAGE_MODEL="
call pnpm dev
