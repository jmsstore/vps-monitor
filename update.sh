#!/bin/bash
set -e

APP_NAME="vps-monitor"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "▶ Masuk ke folder $APP_DIR"
cd "$APP_DIR"

echo "▶ Tarik update dari Git (jika pakai Git)"
if [ -d .git ]; then
  git pull
else
  echo "⚠️ Folder ini bukan repo git, skip git pull"
fi

echo "▶ npm install (update dependency jika ada perubahan)..."
npm install

echo "▶ Restart bot di pm2..."
pm2 restart "$APP_NAME" || pm2 start bot.js --name "$APP_NAME"

echo "▶ Simpan konfigurasi pm2..."
pm2 save

echo "✅ Update selesai!"
