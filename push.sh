#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "[1/3] Staging dist..."
git add artifacts/api-server/dist/

echo "[2/3] Committing..."
git -c user.email="bot@replit.com" -c user.name="Replit" commit -m "rebuild: dist with Ready To Cut flow"

echo "[3/3] Pushing to origin/main..."
git push origin main

echo "Done. Northflank should detect the new commit and redeploy."
