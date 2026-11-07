#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== clean =="
npm run clean

echo "== install from lockfile =="
npm ci

echo "== typecheck =="
npm run typecheck

echo "== build =="
npm run build

echo "== unit tests =="
node --test "test/**/*.test.js"

echo "== public CLI smoke =="
node dist/cli/main.js doctor
node dist/cli/main.js version

echo "== CI OK =="
