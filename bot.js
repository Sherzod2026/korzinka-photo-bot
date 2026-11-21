// Telegram-бот: собирает фото полок из группы мерчендайзеров.
// Каждое фото сохраняется с названием маркета из подписи к нему. В группе бот ничего не пишет.
// По команде /zip (и автоматически вечером) бот присылает ZIP-архив фото за день.
// Внешних библиотек нет — только Node.js (версия 18+).

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- Настройки (переменные окружения на Render) ----------
const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';          // кому слать архив (ваш личный чат с ботом)
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')   // из каких групп собирать (пусто = все)
  .split(',').map(s => s.trim()).filter(Boolean);
const SEND_HOUR = Number(process.env.SEND_HOUR || 20);          // час автоотправки архива (Ташкент), -1 = выкл.
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const KEEP_DAYS = 3;                                            // сколько дней хранить список фото
const PART_LIMIT = 45 * 1024 * 1024;                            // Telegram принимает файлы до 50 МБ

if (!TOKEN) { console.error('Нужна переменная TELEGRAM_TOKEN'); process.exit(1); }

const TG = `https://api.telegram.org/bot${TOKEN}`;
const WEBHOOK_PATH = `/webhook/${TOKEN.split(':')[0]}`;

// ---------- Время Ташкента ----------
function tashkentNow() {
  const iso = new Date(Date.now() + 5 * 3600 * 1000).toISOString(); // UTC+5
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), hour: Number(iso.slice(11, 13)) };
}

// ---------- Хранилище ----------
// Храним не сами фото, а их file_id в Telegram — фото скачиваются при сборке архива.
// Если задан GITHUB_TOKEN — список хранится в секретном GitHub Gist (не теряется,
// когда бесплатный сервер Render засыпает). Иначе — в локальном файле.
let db = { photos: [], lastSent: '' };
// photo: { chatId, messageId, albumId, fileId, ext, date, time, market, merch }

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GIST_DESC = 'korzinka-photo-bot-data';
let gistId = process.env.GIST_ID || '';
let gistOk = false; // не пишем в Gist, пока не прочитали его (чтобы не затереть данные)

async function gh(method, url, body) {
  const r = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'korzinka-photo-bot',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${j.message || ''}`);
  return j;
}

async function loadDb() {
  if (!GITHUB_TOKEN) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) { /* файла ещё нет */ }
    console.log('Хранилище: локальный файл (на бесплатном Render теряется при засыпании!)');
    return;
  }
  if (!gistId) { // ищем свой Gist по описанию, если нет — создаём
    const list = await gh('GET', '/gists?per_page=100');
    const found = list.find(g => g.description === GIST_DESC);
    if (found) gistId = found.id;
    else {
      const g = await gh('POST', '/gists', {
        description: GIST_DESC, public: false,
        files: { 'data.json': { content: JSON.stringify(db) } },
      });
      gistId = g.id;
    }
  }
  const g = await gh('GET', `/gists/${gistId}`);
  const f = g.files && g.files['data.json'];
  if (f) {
    let text = f.content;
    if (f.truncated) text = await (await fetch(f.raw_url)).text();
    try { db = JSON.parse(text); } catch (_) { /* пусто */ }
  }
  db.photos = db.photos || [];
  gistOk = true;
  console.log(`Хранилище: GitHub Gist ${gistId}, записей: ${db.photos.length}`);
}

let saveTimer = null, saving = Promise.resolve();
function save() {
  const cutoff = new Date(Date.now() + 5 * 3600 * 1000 - KEEP_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  db.photos = db.photos.filter(p => p.date >= cutoff);
  if (!GITHUB_TOKEN) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('Сохранение:', e.message); }
    return;
  }
  if (!gistOk) { console.error('Gist не загружен — изменения не сохранены'); return; }
  clearTimeout(saveTimer); // сохраняем в Gist не чаще раза в 3 сек.
  saveTimer = setTimeout(() => {
    saving = saving.then(() => gh('PATCH', `/gists/${gistId}`, {
      files: { 'data.json': { content: JSON.stringify(db) } },
    })).catch(e => console.error('Сохранение в Gist:', e.message));
  }, 3000);
}

// ---------- Telegram API ----------
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error(`Telegram ${method}:`, j.description);
  return j.result;
}

function send(chatId, text, replyTo) {
  return tg('sendMessage', {
    chat_id: chatId, text,
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
}

async function downloadFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  if (!f || !f.file_path) throw new Error('файл недоступен');
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function sendDocument(chatId, buffer, filename, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', caption);
  fd.append('document', new Blob([buffer]), filename);
  const r = await fetch(`${TG}/sendDocument`, { method: 'POST', body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description);
}

// ---------- ZIP (без сжатия: JPEG и так сжат) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) { // files: [{ name, data: Buffer }]
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 имена
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10); cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(f.data.length, 20); cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + f.data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

// ---------- Сборка архива за день ----------
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function sendZip(chatId, date) {
  const list = db.photos.filter(p => p.date === date)
    .sort((a, b) => (a.market || '').localeCompare(b.market || '') || a.time.localeCompare(b.time));
  if (!list.length) return send(chatId, `За ${date} фото нет.`);
  await send(chatId, `Собираю архив за ${date}: ${list.length} фото…`);

  const used = new Map();
  const files = [];
  let failed = 0;
  for (const p of list) {
    try {
      const data = await downloadFile(p.fileId);
      const base = `${safeName(p.market) || 'БЕЗ МАРКЕТА'} - ${safeName(p.merch) || 'мерч'} - ${p.time.replace(':', '-')}`;
      const n = (used.get(base) || 0) + 1; used.set(base, n);
      files.push({ name: `${base} - ${n}.${p.ext}`, data });
    } catch (e) { failed++; console.error('Скачивание:', e.message); }
  }

  // Делим на части до 45 МБ
  const chunks = []; let cur = [], size = 0;
  for (const f of files) {
    if (cur.length && size + f.data.length > PART_LIMIT) { chunks.push(cur); cur = []; size = 0; }
    cur.push(f); size += f.data.length;
  }
  if (cur.length) chunks.push(cur);

  for (let i = 0; i < chunks.length; i++) {
    const suffix = chunks.length > 1 ? `_часть${i + 1}` : '';
    await sendDocument(chatId, makeZip(chunks[i]), `Фото_полок_${date}${suffix}.zip`,
      `Фото полок за ${date}${chunks.length > 1 ? ` (часть ${i + 1} из ${chunks.length})` : ''}: ${chunks[i].length} фото`);
  }
  if (failed) await send(chatId, `⚠️ ${failed} фото не удалось скачать.`);
}

function statText(date) {
  const list = db.photos.filter(p => p.date === date);
  if (!list.length) return `За ${date} фото нет.`;
  const by = new Map();
  list.forEach(p => { const m = p.market || '❗ без маркета'; by.set(m, (by.get(m) || 0) + 1); });
  const lines = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([m, n]) => `${m}: ${n}`);
  return `Фото за ${date}: ${list.length}\nМаркетов: ${[...by.keys()].filter(k => !k.startsWith('❗')).length}\n\n${lines.join('\n')}`;
}

// Автоотправка архива вечером.
// Бесплатный сервер может спать в 20:00 — поэтому проверяем при каждом пробуждении:
// после SEND_HOUR отправляем сегодняшний архив, до SEND_HOUR — вчерашний, если он не ушёл.
let autoBusy = false;
async function maybeAutoSend() {
  if (!ADMIN_CHAT_ID || SEND_HOUR < 0 || autoBusy) return;
  const now = tashkentNow();
  const yesterday = new Date(Date.now() + 5 * 3600 * 1000 - 86400 * 1000).toISOString().slice(0, 10);
  const target = now.hour >= SEND_HOUR ? now.date : yesterday;
  if ((db.lastSent || '') >= target) return;
  autoBusy = true;
  db.lastSent = target; save();
  try {
    if (db.photos.some(p => p.date === target)) await sendZip(ADMIN_CHAT_ID, target);
  } catch (e) { console.error('Автоотправка:', e.message); }
  autoBusy = false;
}
setInterval(maybeAutoSend, 60 * 1000);

// ---------- Обработка сообщений ----------
function photoOf(msg) {
  if (msg.photo && msg.photo.length) return { fileId: msg.photo[msg.photo.length - 1].file_id, ext: 'jpg' };
  const mt = (msg.document && msg.document.mime_type) || '';
  if (/^image\//.test(mt)) {
    const ext = (msg.document.file_name || '').split('.').pop() || mt.split('/')[1] || 'jpg';
    return { fileId: msg.document.file_id, ext: ext.toLowerCase() };
  }
  return null;
}

function setMarket(chatId, messageId, market) {
  const p = db.photos.find(x => x.chatId === chatId && x.messageId === messageId);
  if (!p) return 0;
  const targets = p.albumId ? db.photos.filter(x => x.chatId === chatId && x.albumId === p.albumId) : [p];
  targets.forEach(x => { x.market = market; });
  save();
  return targets.length;
}

async function handleMessage(msg, edited) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const isPrivate = msg.chat.type === 'private';
  const isAdmin = !ADMIN_CHAT_ID || chatId === ADMIN_CHAT_ID;

  // --- Команды: только в личном чате администратора. В группе бот молчит. ---
  if (text.startsWith('/')) {
    if (!isPrivate || !isAdmin) return;
  if (/^\/id\b/.test(text)) return send(chatId, `ID этого чата: ${chatId}`);
  if (/^\/start\b/.test(text) || /^\/help\b/.test(text)) {
    return send(chatId,
      'Бот собирает фото полок.\n\n' +
      'Бот молча собирает фото из группы: в подписи к фото — название маркета ' +
      '(или Reply на фото с названием). В группе бот ничего не пишет.\n\n' +
      'Команды:\n/stat — сколько фото за сегодня по маркетам\n/zip — архив фото за сегодня\n' +
      '/zip 2026-11-20 — архив за дату\n/id — ID чата');
  }
  if (/^\/stat\b/.test(text)) {
    if (!isAdmin) return;
    const d = (text.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || tashkentNow().date;
    return send(chatId, statText(d));
  }
  if (/^\/zip\b/.test(text)) {
    if (!isAdmin) return;
    const d = (text.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || tashkentNow().date;
    return sendZip(chatId, d).catch(e => send(chatId, `⚠️ Ошибка: ${e.message}`));
  }
    return;
  }
  if (isPrivate) return; // фото собираем только из групп

  if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(chatId)) return;

  // --- Ответ текстом на фото = название маркета ---
  if (text && msg.reply_to_message && !text.startsWith('/')) {
    setMarket(chatId, msg.reply_to_message.message_id, text); // молча
    return;
  }

  const photo = photoOf(msg);
  if (!photo) return;
  const caption = (msg.caption || '').trim();

  // --- Изменили подпись у уже сохранённого фото ---
  if (edited) {
    if (caption) setMarket(chatId, msg.message_id, caption);
    return;
  }

  const now = tashkentNow();
  const merch = [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' ')
    || (msg.from && msg.from.username) || '';
  const albumId = msg.media_group_id || '';

  // В альбоме подпись есть только у одного фото — берём её для всего альбома
  let market = caption;
  if (albumId) {
    const sibling = db.photos.find(x => x.chatId === chatId && x.albumId === albumId && x.market);
    if (caption) db.photos.filter(x => x.chatId === chatId && x.albumId === albumId).forEach(x => { x.market = caption; });
    else if (sibling) market = sibling.market;
  }

  db.photos.push({
    chatId, messageId: msg.message_id, albumId, fileId: photo.fileId, ext: photo.ext,
    date: now.date, time: now.time, market, merch,
  });
  save();
}

// ---------- HTTP-сервер (webhook) ----------
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200); res.end('ok'); // отвечаем Telegram сразу
      try {
        const u = JSON.parse(body);
        const msg = u.message || u.edited_message;
        if (msg) handleMessage(msg, !!u.edited_message).catch(e => console.error(e));
        maybeAutoSend();
      } catch (e) { console.error(e); }
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`Бот работает. Фото за сегодня: ${db.photos.filter(p => p.date === tashkentNow().date).length}`);
  maybeAutoSend();
});

(async () => {
  try { await loadDb(); } catch (e) { console.error('Загрузка хранилища:', e.message); }
  server.listen(PORT, async () => {
    console.log(`Сервер на порту ${PORT}`);
    if (PUBLIC_URL) {
      await tg('setWebhook', { url: `${PUBLIC_URL}${WEBHOOK_PATH}`, allowed_updates: ['message', 'edited_message'] });
      console.log('Webhook установлен');
    } else {
      console.warn('PUBLIC_URL не задан — webhook не установлен');
    }
    maybeAutoSend();
  });
})();

module.exports = { makeZip, crc32 }; // для проверки
