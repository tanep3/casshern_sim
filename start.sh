#!/bin/bash
set -e

echo "Starting Casshern Sim Dev Server..."

# Check if WASM is built
if [ ! -d "frontend/src/pkg" ]; then
    echo "WASM package not found. Running build first..."
    ./build.sh
fi

cd frontend
npm install
npm run dev
