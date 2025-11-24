# VPS Monitor Bot (Telegram)

Bot Telegram untuk monitoring status VPS otomatis.
Bot akan mengirim notifikasi ketika server **DOWN** atau **ONLINE kembali**.

✅ Tanpa ping spike  
✅ Bisa jalan bareng bot lain  
✅ Instalasi sekali klik via `install.sh`  

---

## 📦 Instalasi

```bash
cd ~
sudo apt update
sudo apt install -y git
git clone https://github.com/jmsstore/vps-monitor.git
cd vps-monitor && nano .env && chmod +x install.sh update.sh
./install.sh
```
Isi datanya:

```
BOT_TOKEN=TOKEN_BOT_KAMU
ADMIN_IDS=123456789
NOTIFY_CHAT_ID=-1001234567890
MONITORING_ENABLED=true
MONITORING_INTERVAL=60
```

## 🔄 Update Bot

```bash
./update.sh
```

---
### Cek Bot Jalan
```
pm2 list
```
### Log Bot
```
pm2 logs vps-monitor
```

## ✅ Requirements

- Node.js 16+
- npm
- pm2 (auto install via script)

---

## ⚠️ Jangan upload `.env`

Repo sudah termasuk `.gitignore`
