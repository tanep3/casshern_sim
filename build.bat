@echo off
setlocal

echo ========================================
echo Casshern Sim Build Script (Windows)
echo ========================================

REM 1. Build Rust WASM
echo [1/3] Building Rust WASM...
where wasm-pack >nul 2>nul
if %errorlevel% neq 0 (
    echo is wasm-pack not found. Installing via cargo...
    cargo install wasm-pack
)
wasm-pack build --target web --out-dir pkg
if %errorlevel% neq 0 exit /b %errorlevel%

REM 2. Copy pkg to frontend
echo [2/3] Installing WASM package to frontend...
if exist frontend\src\pkg rmdir /s /q frontend\src\pkg
xcopy /s /e /i pkg frontend\src\pkg
if %errorlevel% neq 0 exit /b %errorlevel%

REM 3. Build Frontend
echo [3/3] Building Frontend...
cd frontend
call npm install
call npm run build
if %errorlevel% neq 0 exit /b %errorlevel%

echo ========================================
echo Build Complete! check 'frontend/dist'
echo To start dev server: start.bat
echo ========================================
endlocal
