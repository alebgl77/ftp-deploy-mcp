#!/usr/bin/env sh
# One-command installer for ftp-deploy-mcp (macOS / Linux).
# You may need to make it executable first: chmod +x install.sh
set -e

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found / Node.js introuvable." >&2
  echo "Install Node.js 18+ from https://nodejs.org, then re-run this script." >&2
  exit 1
fi

echo "Installing dependencies / Installation des dependances..."
npm install --no-audit --no-fund

exec node src/index.js setup
