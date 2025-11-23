require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const net = require('net');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);

// =======================
// KONFIG DASAR
// =======================

const SERVERS_FILE = path.join(__dirname, 'servers.json');

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID || null;

let CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '60', 10);
if (isNaN(CHECK_INTERVAL) || CHECK_INTERVAL < 10) CHECK_INTERVAL = 60;

let monitoringEnabled = (process.env.MONITORING_ENABLED || 'true').toLowerCase() === 'true';

// In-memory sesi admin (untuk tambah VPS)
const adminSessions = {}; // { userId: { step, temp } }

// Status terakhir VPS untuk notifikasi auto
// { serverId: { online, lastChange, lastMs } }
const lastStatuses = {};

// Retry gagal cek (untuk 3x sebelum dianggap DOWN)
const failureCounts = {}; // { serverId: number }

// Ping terakhir per server (ms)
const lastPing = {}; // { serverId: ms }

// Cooldown alert ping spike (biar gak spam)
const pingCooldown = {}; // { serverId: timestamp }

// =======================
// FUNGSI BANTU
// =======================

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function loadServers() {
  try {
    if (!fs.existsSync(SERVERS_FILE)) return [];
    const raw = fs.readFileSync(SERVERS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
  } catch (e) {
    console.error('Gagal load servers.json:', e.message);
    return [];
  }
}

function saveServers(servers) {
  try {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2), 'utf8');
  } catch (e) {
    console.error('Gagal save servers.json:', e.message);
  }
}

let servers = loadServers();

// Generate ID unik untuk VPS baru
function generateServerId() {
  return 'srv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// Cek status satu VPS
function checkServer(server, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let answered = false;

    const finish = (result) => {
      if (!answered) {
        answered = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeout);

    socket
      .connect(server.port, server.host, () => {
        const ms = Date.now() - start;
        finish({ online: true, ms });
      })
      .on('error', (err) => {
        finish({ online: false, error: err.message });
      })
      .on('timeout', () => {
        finish({ online: false, error: 'Timeout' });
      });
  });
}

// Kirim notifikasi ke admin/notify chat (dark style)
async function sendNotification(text, extra = {}) {
  try {
    const payload = {
      parse_mode: 'Markdown',
      ...extra,
    };

    if (NOTIFY_CHAT_ID) {
      await bot.telegram.sendMessage(NOTIFY_CHAT_ID, text, payload);
      return;
    }

    for (const adminId of ADMIN_IDS) {
      await bot.telegram.sendMessage(adminId, text, payload);
    }
  } catch (e) {
    console.error('Gagal kirim notifikasi:', e.message);
  }
}

// Format durasi ms -> "X menit Y detik"
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s} detik`;
  return `${m} menit ${s} detik`;
}

// =======================
// MONITORING OTOMATIS (retry 3x + ping spike + notif dark)
// =======================

async function checkAllServersAndNotify() {
  if (!monitoringEnabled) return;
  if (!servers.length) return;

  for (const server of servers) {
    if (server.enabled === false) continue;

    try {
      const id = server.id;
      const result = await checkServer(server);
      const nowOnline = !!result.online;

      // Inisialisasi failure count
      if (failureCounts[id] == null) failureCounts[id] = 0;

      // --- Jika ONLINE ---
      if (nowOnline) {
        const ms = result.ms;
        lastPing[id] = ms;
        failureCounts[id] = 0;

        const prev = lastStatuses[id];

        // Hitung ping spike (kalau sebelumnya ada ping)
        const prevPing = prev && typeof prev.lastMs === 'number' ? prev.lastMs : null;
        if (prevPing != null) {
          const diff = ms - prevPing;
          if (diff > 120) {
            const lastAlert = pingCooldown[id] || 0;
            if (Date.now() - lastAlert > 180000) {
              const spikeMsg =
`━━━━━━━━━━━━━━━
⚠️ *PING SPIKE TERDETEKSI*
🖥 ${server.name} ${server.emoji || ''}
📈 ${prevPing}ms → *${ms}ms*
⏱ ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━`;
              await sendNotification(spikeMsg);
              pingCooldown[id] = Date.now();
            }
          }
        }

        // Update status
        if (!prev) {
          lastStatuses[id] = {
            online: true,
            lastChange: new Date().toISOString(),
            lastMs: ms,
          };
          continue;
        }

        if (!prev.online && nowOnline) {
          const now = new Date();
          const lastChange = new Date(prev.lastChange);
          const downtimeMs = now - lastChange;

          const upMsg =
`━━━━━━━━━━━━━━━
🟢 *SERVER ONLINE KEMBALI*
🖥 ${server.name} ${server.emoji || ''}
🌐 \`${server.host}:${server.port}\`
⏳ Downtime: *${formatDuration(downtimeMs)}*
⏱ ${now.toLocaleString()}
━━━━━━━━━━━━━━━`;

          await sendNotification(upMsg);

          lastStatuses[id] = {
            online: true,
            lastChange: now.toISOString(),
            lastMs: ms,
          };
        } else {
          // Tetap ONLINE, update ping saja
          lastStatuses[id].online = true;
          lastStatuses[id].lastMs = ms;
        }

        continue;
      }

      // --- Jika TIDAK ONLINE (gagal cek) ---
      lastPing[server.id] = 'TIMEOUT';
      failureCounts[server.id] += 1;

      // Belum 3x gagal → jangan dianggap down dulu
      if (failureCounts[server.id] < 3) continue;

      const prev = lastStatuses[server.id];
      const now = new Date();

      if (!prev) {
        // Belum ada status sebelumnya: tandai offline tapi tanpa notifikasi
        lastStatuses[server.id] = {
          online: false,
          lastChange: now.toISOString(),
          lastMs: null,
        };
        continue;
      }

      if (prev.online) {
        // Dari ONLINE ke OFFLINE setelah 3x gagal
        lastStatuses[server.id] = {
          online: false,
          lastChange: now.toISOString(),
          lastMs: null,
        };

        const downMsg =
`━━━━━━━━━━━━━━━
🔻 *SERVER DOWN*
🖥 ${server.name} ${server.emoji || ''}
🌐 \`${server.host}:${server.port}\`
ℹ️ Info: ${result.error || 'Tidak dapat dijangkau (3x percobaan gagal)'}
⏱ ${now.toLocaleString()}
━━━━━━━━━━━━━━━`;

        await sendNotification(downMsg);
      }
      // Kalau sebelumnya sudah offline, biarin saja (tidak spam)
    } catch (e) {
      console.error('Error saat monitoring', server.name, e.message);
    }
  }
}

// Jalankan interval monitoring
setInterval(checkAllServersAndNotify, CHECK_INTERVAL * 1000);

// =======================
// UI BANTU: KATEGORI BERDASARKAN EMOJI
// =======================

function getCategories() {
  const categories = {};
  servers.forEach((s) => {
    const flag = s.emoji || '🌍';
    if (!categories[flag]) categories[flag] = [];
    categories[flag].push(s);
  });
  return categories;
}

// Ambil icon status berdasar lastStatus + ping
function getStatusIcon(server) {
  const st = lastStatuses[server.id];
  if (!st) return '⚪'; // unknown

  if (!st.online) return '🔴';

  const ms = st.lastMs;
  if (typeof ms !== 'number') return '🟢';

  if (ms < 90) return '🟢';
  if (ms < 200) return '🟡';
  if (ms < 350) return '🟠';
  return '🟣';
}

function formatLatency(server) {
  const st = lastStatuses[server.id];
  if (!st || typeof st.lastMs !== 'number') return '…';
  return `${st.lastMs}ms`;
}

// =======================
// MENU UTAMA
// =======================

function homeMenu(isAdminUser = false) {
  const rows = [
    [
      Markup.button.callback('📡 Cek Status VPS', 'menu_cek'),
      Markup.button.callback('📋 Daftar VPS', 'menu_list'),
    ],
    [Markup.button.callback('ℹ️ Info Bot', 'menu_info')],
  ];
  if (isAdminUser) {
    rows.push([Markup.button.callback('🛠 Menu Admin', 'admin_menu')]);
  }
  return Markup.inlineKeyboard(rows);
}

bot.start((ctx) => {
  const isAdminUser = isAdmin(ctx.from.id);
  ctx.reply(
    `Halo *${ctx.from.first_name || ''}* 👋\n` +
      `Selamat datang di *VPS Status Checker Bot*.\n\n` +
      `Gunakan tombol di bawah untuk mulai.`,
    {
      parse_mode: 'Markdown',
      ...homeMenu(isAdminUser),
    }
  );
});

// =======================
// MENU CEK VPS (KATEGORI BERDASARKAN EMOJI)
// =======================

bot.action('menu_cek', async (ctx) => {
  await ctx.answerCbQuery();

  if (!servers.length) {
    return ctx.editMessageText('❌ Belum ada VPS yang terdaftar.', {
      ...homeMenu(isAdmin(ctx.from.id)),
    });
  }

  const categories = getCategories();
  const buttons = [];

  Object.keys(categories).forEach((flag) => {
    buttons.push([
      Markup.button.callback(`${flag} Server ${flag}`, `cat_${flag}`),
    ]);
  });

  buttons.push([
    Markup.button.callback('🌍 Semua VPS', 'cat_ALL'),
  ]);

  buttons.push([
    Markup.button.callback('⬅️ Kembali', 'back_home'),
  ]);

  ctx.editMessageText('📡 *Pilih kategori server:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons),
  });
});

// Tampilkan daftar server per kategori / ALL
bot.action(/cat_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const key = ctx.match[1]; // emoji atau "ALL"

  let list;
  if (key === 'ALL') {
    list = servers.slice();
  } else {
    const categories = getCategories();
    list = categories[key] || [];
  }

  if (!list.length) {
    return ctx.editMessageText('Tidak ada server di kategori ini.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Kembali', 'menu_cek')],
      ]),
    });
  }

  const buttons = [];
  let row = [];

  list.forEach((s) => {
    const icon = getStatusIcon(s);
    const flag = s.emoji || '🖥';
    const latency = formatLatency(s);

    row.push(
      Markup.button.callback(
        `${icon} ${s.name} ${flag} (${latency})`,
        `check_${s.id}`
      )
    );

    if (row.length === 2) {
      buttons.push(row);
      row = [];
    }
  });

  if (row.length === 1) buttons.push(row);

  buttons.push([
    Markup.button.callback('⬅️ Kembali', 'menu_cek'),
  ]);

  ctx.editMessageText('📡 *Status VPS Terkini:*\nPilih server untuk cek detail.', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons),
  });
});

// =======================
// MENU DAFTAR VPS
// =======================

bot.action('menu_list', async (ctx) => {
  await ctx.answerCbQuery();

  if (!servers.length) {
    return ctx.editMessageText('📋 *Daftar VPS kosong.*', {
      parse_mode: 'Markdown',
      ...homeMenu(isAdmin(ctx.from.id)),
    });
  }

  let text = '📋 *Daftar VPS Terdaftar:*\n\n';
  servers.forEach((s, i) => {
    const st = lastStatuses[s.id];
    const status = st ? (st.online ? 'ONLINE' : 'OFFLINE') : 'UNKNOWN';
    const latency = st && typeof st.lastMs === 'number' ? `${st.lastMs} ms` : '-';
    text +=
      `${i + 1}. *${s.name}* ${s.emoji || ''}\n` +
      `   🌐 \`${s.host}:${s.port}\`\n` +
      `   Status: *${status}* | Latency: ${latency}\n\n`;
  });

  ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Kembali', 'back_home')],
    ]),
  });
});

// =======================
// CEK VPS INDIVIDU (BUTTON check_*)
// =======================

bot.on('callback_query', async (ctx, next) => {
  const data = ctx.callbackQuery.data || '';

  // =======================
  // CEK VPS INDIVIDU
  // =======================
  if (data.startsWith('check_')) {
    const id = data.replace('check_', '');
    const server = servers.find((s) => s.id === id);

    if (!server) {
      await ctx.answerCbQuery('Server tidak ditemukan.', { show_alert: true });
      return;
    }

    await ctx.answerCbQuery('Sedang mengecek...');
    await ctx.editMessageText(
      `🔍 Mengecek *${server.name}*...\n` +
        `🌐 \`${server.host}:${server.port}\``,
      { parse_mode: 'Markdown' }
    );

    const result = await checkServer(server);

    const flag = server.emoji || '';
    if (result.online) {
      const ms = result.ms;
      lastStatuses[server.id] = {
        online: true,
        lastChange: new Date().toISOString(),
        lastMs: ms,
      };
      lastPing[server.id] = ms;

      const flagLine = flag ? `🏳️ ${flag}\n` : '';

      await ctx.editMessageText(
        `🟢 *${server.name}* *ONLINE*\n` +
          flagLine +
          `🌐 Host: \`${server.host}\`\n` +
          `📌 Port: ${server.port}\n` +
          `⚡ Respon: *${ms} ms*`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Kembali', 'menu_cek')],
          ]),
        }
      );
    } else {
      lastStatuses[server.id] = {
        online: false,
        lastChange: new Date().toISOString(),
        lastMs: null,
      };
      lastPing[server.id] = 'TIMEOUT';

      const flagLine = flag ? `🏳️ ${flag}\n` : '';

      await ctx.editMessageText(
        `🔴 *${server.name}* *OFFLINE*\n` +
          flagLine +
          `🌐 Host: \`${server.host}\`\n` +
          `📌 Port: ${server.port}\n` +
          `ℹ️ Info: ${result.error || 'Tidak dapat dijangkau'}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Kembali', 'menu_cek')],
          ]),
        }
      );
    }

    return;
  }

  // =======================
  // HAPUS VPS (ADMIN)
  // =======================
  if (data.startsWith('admin_del_')) {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('Kamu bukan admin.', { show_alert: true });
      return;
    }

    const id = data.replace('admin_del_', '');
    const server = servers.find((s) => s.id === id);

    if (!server) {
      await ctx.answerCbQuery('Server tidak ditemukan.', { show_alert: true });
      return;
    }

    // Hapus dari array servers
    servers = servers.filter((s) => s.id !== id);
    saveServers(servers);

    // Bersihkan cache status
    delete lastStatuses[id];
    delete failureCounts[id];
    delete lastPing[id];

    await ctx.answerCbQuery('VPS dihapus.');

    await ctx.editMessageText(`🗑 VPS *${server.name}* telah dihapus.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Kembali', 'admin_menu')],
      ]),
    });

    return;
  }

  return next();
});


// =======================
// INFO BOT
// =======================

bot.action('menu_info', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.editMessageText(
    `ℹ️ *Info Bot*\n\n` +
      `Bot ini dapat:\n` +
      `• Cek status VPS (online/offline)\n` +
      `• Menampilkan latency (ms)\n` +
      `• Monitoring otomatis & notifikasi jika VPS down / up lagi\n` +
      `• Retry 3x sebelum dianggap DOWN\n` +
      `• Deteksi lonjakan ping (ping spike)\n` +
      `• Kategori server otomatis berdasarkan emoji\n` +
      `• Admin dapat menambah/menghapus VPS dari dalam bot`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Kembali', 'back_home')],
      ]),
    }
  );
});

// =======================
// TOMBOL KEMBALI KE HOME
// =======================

bot.action('back_home', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.editMessageText('Pilih menu:', {
    ...homeMenu(isAdmin(ctx.from.id)),
  });
});

// =======================
// MENU ADMIN
// =======================

bot.action('admin_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('Kamu bukan admin.', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();

  const statusText = monitoringEnabled ? '🟢 Aktif' : '🔴 Nonaktif';

  ctx.editMessageText('🛠 *Menu Admin*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Tambah VPS', 'admin_add')],
      [Markup.button.callback('🗑 Hapus VPS', 'admin_del_menu')],
      [Markup.button.callback(`📡 Monitoring: ${statusText}`, 'admin_toggle_mon')],
      [Markup.button.callback('📄 Lihat Config', 'admin_view')],
      [Markup.button.callback('⬅️ Kembali', 'back_home')],
    ]),
  });
});

// Toggle Monitoring
bot.action('admin_toggle_mon', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('Kamu bukan admin.', { show_alert: true });
    return;
  }

  monitoringEnabled = !monitoringEnabled;

  await ctx.answerCbQuery(
    monitoringEnabled ? 'Monitoring diaktifkan.' : 'Monitoring dimatikan.'
  );

  const statusText = monitoringEnabled ? '🟢 Aktif' : '🔴 Nonaktif';

  ctx.editMessageText('🛠 *Menu Admin*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Tambah VPS', 'admin_add')],
      [Markup.button.callback('🗑 Hapus VPS', 'admin_del_menu')],
      [Markup.button.callback(`📡 Monitoring: ${statusText}`, 'admin_toggle_mon')],
      [Markup.button.callback('📄 Lihat Config', 'admin_view')],
      [Markup.button.callback('⬅️ Kembali', 'back_home')],
    ]),
  });
});

// Lihat config
bot.action('admin_view', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('Kamu bukan admin.', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();

  let text = `📄 *Config Singkat*\n\n`;
  text += `• Total VPS: *${servers.length}*\n`;
  text += `• Monitoring: *${monitoringEnabled ? 'Aktif' : 'Nonaktif'}*\n`;
  text += `• Interval cek: *${CHECK_INTERVAL} detik*\n`;

  ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Kembali', 'admin_menu')],
    ]),
  });
});

// =======================
// ADMIN: TAMBAH VPS (FLOW)
// =======================

bot.action('admin_add', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('Kamu bukan admin.', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();

  const uid = String(ctx.from.id);

  adminSessions[uid] = {
    step: 'name',
    temp: {},
  };

  await ctx.editMessageText(
    '➕ *Tambah VPS Baru*\n\nSilakan kirim *Nama VPS* (contoh: SERVER SG 1).',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Batal', 'admin_add_cancel')],
      ]),
    }
  );
});

bot.action('admin_add_cancel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('Kamu bukan admin.', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery('Dibatalkan.');
  delete adminSessions[String(ctx.from.id)];

  ctx.editMessageText('Aksi dibatalkan.', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Kembali', 'admin_menu')],
    ]),
  });
});

// Handler pesan teks untuk flow tambah VPS
bot.on('text', async (ctx, next) => {
  const uid = String(ctx.from.id);

  if (!isAdmin(uid) || !adminSessions[uid]) {
    return next();
  }

  const session = adminSessions[uid];
  const text = ctx.message.text.trim();

  if (session.step === 'name') {
    session.temp.name = text;
    session.step = 'host';
    return ctx.reply(
      `Nama VPS: *${text}*\n\nSekarang kirim *Host / IP* VPS (contoh: sg1.example.com atau 1.1.1.1).`,
      { parse_mode: 'Markdown' }
    );
  }

  if (session.step === 'host') {
    session.temp.host = text;
    session.step = 'port';
    return ctx.reply(
      `Host VPS: *${text}*\n\nSekarang kirim *Port* yang akan dicek (contoh: 22, 80, 443).`,
      { parse_mode: 'Markdown' }
    );
  }

  if (session.step === 'port') {
    const port = parseInt(text, 10);
    if (isNaN(port) || port <= 0 || port > 65535) {
      return ctx.reply('Port tidak valid. Kirim angka port yang benar (1–65535).');
    }

    session.temp.port = port;

    const newServer = {
      id: generateServerId(),
      name: session.temp.name,
      host: session.temp.host,
      port: session.temp.port,
      emoji: session.temp.emoji || undefined,
      enabled: true,
    };

    servers.push(newServer);
    saveServers(servers);

    delete adminSessions[uid];

    return ctx.reply(
      `✅ VPS baru ditambahkan:\n\n` +
        `• Nama: *${newServer.name}*\n` +
        `• Host: \`${newServer.host}\`\n` +
        `• Port: *${newServer.port}*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Menu Admin', 'admin_menu')],
        ]),
      }
    );
  }

  return next();
});

// =======================
// ADMIN: HAPUS VPS
// =======================

bot.action('admin_del_menu', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('Kamu bukan admin.', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();

  if (!servers.length) {
    return ctx.editMessageText('Tidak ada VPS yang bisa dihapus.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Kembali', 'admin_menu')],
      ]),
    });
  }

  const buttons = servers.map((s) => [
    Markup.button.callback(`🗑 ${s.name}`, `admin_del_${s.id}`),
  ]);

  buttons.push([Markup.button.callback('⬅️ Kembali', 'admin_menu')]);

  ctx.editMessageText('Pilih VPS yang ingin dihapus:', Markup.inlineKeyboard(buttons));
});

// =======================
// JALANKAN BOT
// =======================

bot
  .launch()
  .then(() => {
    console.log('Bot VPS status berjalan...');
    console.log('Monitoring:', monitoringEnabled ? 'Aktif' : 'Nonaktif');
    console.log('Interval cek:', CHECK_INTERVAL, 'detik');
  })
  .catch(console.error);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
