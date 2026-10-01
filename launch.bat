@echo off
title Bot Crossing
cd /d "%~dp0"

rem Rebuild whenever the checked-out commit differs from the one dist\ was built from, so a
rem pull or a merge shows up on the next launch instead of serving a stale build.
set "HEAD="
for /f %%i in ('git rev-parse HEAD 2^>nul') do set "HEAD=%%i"
set "BUILT="
if exist "dist\.build-commit" set /p BUILT=<"dist\.build-commit"
set "NEED="
if not exist "dist\index.html" set "NEED=1"
if defined HEAD if not "%HEAD%"=="%BUILT%" set "NEED=1"

if defined NEED (
    echo Building Bot Crossing...
    call npm run build
    if errorlevel 1 (
        echo Build failed.
        pause
        exit /b 1
    )
    if defined HEAD >"dist\.build-commit" echo %HEAD%
)

echo Starting Bot Crossing on http://127.0.0.1:5274 ...
start http://127.0.0.1:5274
node server/serve.mjs
pause
