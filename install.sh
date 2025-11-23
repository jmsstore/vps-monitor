#!/bin/bash
set -e

APP_NAME="vps-monitor"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "▶ Masuk ke folder $APP_DIR"
cd "$APP_DIR"

echo "▶ Cek Node.js dan npm..."
if ! command -v node >/dev/null 2>&1; then
  echo "⏳ Node.js belum ada, install dulu..."
  sudo apt update
  sudo apt install -y nodejs npm
else
  echo "✅ Node.js sudah terinstall"
fi

echo "▶ npm install..."
npm install

echo "▶ Cek pm2..."
if ! command -v pm2 >/dev/null 2>&1; then
  echo "⏳ pm2 belum ada, install dulu..."
  sudo npm install -g pm2
else
  echo "✅ pm2 sudah terinstall"
fi

echo "▶ Start bot dengan pm2..."
if pm2 list | grep -q "$APP_NAME"; then
  echo "↻ Proses dengan nama $APP_NAME sudah ada, restart..."
  pm2 restart "$APP_NAME"
else
  echo "▶ Menjalankan bot.js dengan nama $APP_NAME"
  pm2 start bot.js --name "$APP_NAME"
fi

echo "▶ Simpan list proses pm2..."
pm2 save

echo "▶ Atur pm2 agar auto-start saat reboot..."
pm2 startup -u "$USER" --hp "$HOME"

echo "✅ Selesai!"
echo "ℹ️ Cek status dengan: pm2 list"
echo "ℹ️ Lihat log dengan: pm2 logs $APP_NAME"
