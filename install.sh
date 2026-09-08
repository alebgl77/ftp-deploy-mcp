#!/usr/bin/env sh
# One-command installer / Installation en une commande : ftp-deploy-mcp (macOS / Linux).
# Make executable if needed / Rendre executable si necessaire : chmod +x install.sh
set -e

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR/ERREUR] Node.js not found / Node.js introuvable." >&2
  echo "Install Node.js 22+ from https://nodejs.org, then re-run this script." >&2
  echo "Installez Node.js 22+ depuis https://nodejs.org puis relancez ce script." >&2
  exit 1
fi

echo "Installing dependencies / Installation des dependances..."
npm install --no-audit --no-fund

exec node src/index.js setup
