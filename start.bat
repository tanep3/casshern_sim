@echo off
setlocal

echo Starting Casshern Sim Dev Server...

REM Check if WASM is built
if not exist frontend\src\pkg (
    echo WASM package not found. Running build first...
    call build.bat
)

cd frontend
call npm install
call npm run dev
endlocal
