#!/bin/bash
set -e

echo "========================================"
echo "Casshern Sim Build Script (Linux/Mac)"
echo "========================================"

# 1. Build Rust WASM
echo "[1/3] Building Rust WASM..."
if ! command -v wasm-pack &> /dev/null; then
    echo "wasm-pack not found. Installing via cargo..."
    cargo install wasm-pack
fi
wasm-pack build --target web --out-dir pkg

# 2. Copy pkg to frontend
echo "[2/3] Installing WASM package to frontend..."
rm -rf frontend/src/pkg
cp -r pkg frontend/src/pkg

# 3. Build Frontend
echo "[3/3] Building Frontend..."
cd frontend
npm install
npm run build

echo "========================================"
echo "Build Complete! check 'frontend/dist'"
echo "To start dev server: ./start.sh"
echo "========================================"
