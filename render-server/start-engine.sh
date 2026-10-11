#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Chưa cài Node.js (https://nodejs.org)"; exit 1; }
[ -d node_modules ] || npm install --omit=dev
npm start
