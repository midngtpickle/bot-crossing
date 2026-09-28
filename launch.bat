@echo off
title Bot Crossing
cd /d "%~dp0"

if not exist "dist\index.html" (
    echo Building Bot Crossing...
    call npm run build
)

echo Starting Bot Crossing on http://127.0.0.1:5274 ...
start http://127.0.0.1:5274
node server/serve.mjs
pause
