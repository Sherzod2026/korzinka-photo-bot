// Telegram-бот: собирает фото полок из группы мерчендайзеров.
// Каждое фото сохраняется с названием маркета из подписи к нему. В группе бот ничего не пишет.
// По команде /zip (и автоматически вечером) бот присылает ZIP-архив фото за день.
// Внешних библиотек нет — только Node.js (версия 18+).

const http = require('http');
const os = require('os');
const crypto = require('crypto');
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
const KEEP_DAYS = 7;                                            // сколько дней хранить список фото
const PART_LIMIT_TG = 45 * 1024 * 1024;                         // до этого размера архив приходит прямо в Telegram

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

let zipBusy = false;

async function sendZip(chatId, date, onlyNew = true) {
  if (zipBusy) return send(chatId, '⏳ Архив уже собирается, дождитесь его.');
  zipBusy = true;
  try { await buildAndSendZip(chatId, date, onlyNew); }
  finally { zipBusy = false; }
}

// ---------- Один ZIP-архив: пишем на диск сервера и даём ссылку на скачивание ----------
// Telegram не принимает от бота файлы больше 50 МБ, поэтому большой архив отдаём ссылкой.
const ZIP_DIR = path.join(os.tmpdir(), 'polka-zips');
const LINK_HOURS = 3;
const downloads = new Map(); // token -> { file, name, expires }
try { fs.rmSync(ZIP_DIR, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(ZIP_DIR, { recursive: true });

class ZipFileWriter {
  constructor(file) { this.fd = fs.openSync(file, 'w'); this.offset = 0; this.central = []; this.count = 0; }
  write(buf) { fs.writeSync(this.fd, buf); this.offset += buf.length; }
  add(nameStr, data) {
    const name = Buffer.from(nameStr, 'utf8');
    const crc = crc32(data);
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10); cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(this.offset, 42);
    this.central.push(cen, name);
    this.write(local); this.write(name); this.write(data);
    this.count++;
  }
  close() {
    const cenBuf = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.count, 8); end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(this.offset, 16);
    const start = this.offset;
    this.write(cenBuf); this.write(end);
    fs.closeSync(this.fd);
    return this.offset;
  }
}

async function buildAndSendZip(chatId, date, onlyNew) {
  const list = db.photos.filter(p => p.date === date && (!onlyNew || !p.sent))
    .sort((a, b) => (a.market || '').localeCompare(b.market || '') || a.time.localeCompare(b.time));
  if (!list.length) {
    return send(chatId, onlyNew
      ? `За ${date} новых фото нет (всё уже выгружено). Все фото за день: /zip ${fmtDate(date)}`
      : `За ${date} фото нет. Бот хранит фото за последние ${KEEP_DAYS} дней и видит только то, что пришло после его добавления в группу.`);
  }
  await send(chatId, `Собираю один архив за ${date}: ${list.length} фото. Это займёт несколько минут.`);

  const used = new Map();
  const items = list.map(p => {
    const base = `${safeName(p.market) || 'БЕЗ МАРКЕТА'} - ${safeName(p.merch) || 'мерч'} - ${p.time.replace(':', '-')}`;
    const n = (used.get(base) || 0) + 1; used.set(base, n);
    return { p, name: `${base} - ${n}.${p.ext}` };
  });

  const token = crypto.randomBytes(12).toString('hex');
  const zipName = `Фото_полок_${fmtDate(date)}.zip`;
  const file = path.join(ZIP_DIR, `${token}.zip`);
  const zw = new ZipFileWriter(file);
  const done = [];
  let failed = 0;
  const BATCH = 4;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async it => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { return { it, data: await downloadFile(it.p.fileId) }; }
        catch (e) { if (attempt === 3) { console.error('Скачивание:', e.message); return null; } await new Promise(r => setTimeout(r, 1000 * attempt)); }
      }
    }));
    for (const r of results) {
      if (!r) { failed++; continue; }
      zw.add(r.it.name, r.data); done.push(r.it.p);
    }
  }
  const size = zw.close();
  const mb = (size / 1048576).toFixed(1);

  downloads.set(token, { file, name: zipName, expires: Date.now() + LINK_HOURS * 3600 * 1000 });
  setTimeout(() => { downloads.delete(token); fs.rm(file, { force: true }, () => {}); }, LINK_HOURS * 3600 * 1000);

  if (size <= PART_LIMIT_TG) {
    await sendDocument(chatId, fs.readFileSync(file), zipName, `Фото полок за ${fmtDate(date)}: ${done.length} фото`);
  } else if (PUBLIC_URL) {
    await send(chatId,
      `📦 Архив готов: ${done.length} фото, ${mb} МБ — одним файлом.\n` +
      `Скачать: ${PUBLIC_URL}/download/${token}\n` +
      `Скачайте сразу: бесплатный сервер засыпает через ~15 минут без активности, и файл удаляется (тогда просто отправьте /zip ещё раз — для даты: /zip ${fmtDate(date)}).`);
  } else {
    throw new Error('архив больше 50 МБ, а PUBLIC_URL не задан');
  }
  done.forEach(x => { x.sent = true; });
  save();
  if (failed) await send(chatId, `⚠️ Не удалось скачать ${failed} фото — повторите /zip позже, они придут как новые.`);
}

function statText(date) {
  const list = db.photos.filter(p => p.date === date);
  if (!list.length) return `За ${date} фото нет.`;
  const fresh = list.filter(p => !p.sent).length;
  const by = new Map();
  list.forEach(p => { const m = p.market || '❗ без маркета'; by.set(m, (by.get(m) || 0) + 1); });
  const lines = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([m, n]) => `${m}: ${n}`);
  return `Фото за ${date}: ${list.length} (новых, ещё не выгружено: ${fresh})\n` +
    `Маркетов: ${[...by.keys()].filter(k => !k.startsWith('❗')).length}\n\n${lines.join('\n')}`;
}

// Дата из команды: 2026-11-21, 21.11.2026, 21 11 2026, 21.11 (текущий год)
function parseDate(text) {
  const t = text.replace(/^\/\w+(@\w+)?/, '');
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/(\d{1,2})[.\s\/-]+(\d{1,2})(?:[.\s\/-]+(\d{4}))?/);
  if (m) return `${m[3] || tashkentNow().date.slice(0, 4)}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function fmtDate(d) { const [y, mo, da] = d.split('-'); return `${da}.${mo}.${y}`; }

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
  if (msg.photo && msg.photo.length) {
    const ph = msg.photo[msg.photo.length - 1];
    return { fileId: ph.file_id, uid: ph.file_unique_id || '', ext: 'jpg' };
  }
  const mt = (msg.document && msg.document.mime_type) || '';
  if (/^image\//.test(mt)) {
    const ext = (msg.document.file_name || '').split('.').pop() || mt.split('/')[1] || 'jpg';
    return { fileId: msg.document.file_id, uid: msg.document.file_unique_id || '', ext: ext.toLowerCase() };
  }
  return null;
}

// Кнопки внизу личного чата
const KEYBOARD = { keyboard: [[{ text: '📦 ZIP за сегодня' }, { text: '📊 Статистика' }]], resize_keyboard: true, is_persistent: true };
function sendKb(chatId, text) { return tg('sendMessage', { chat_id: chatId, text, reply_markup: KEYBOARD }); }

function tashkentFromUnix(sec) {
  const iso = new Date(sec * 1000 + 5 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

// Кто автор пересланного фото
function forwardAuthor(msg) {
  const o = msg.forward_origin;
  if (o) {
    if (o.sender_user) return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
    if (o.sender_user_name) return o.sender_user_name;
    if (o.sender_chat) return o.sender_chat.title || '';
    if (o.chat) return o.chat.title || '';
  }
  if (msg.forward_from) return [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' ');
  if (msg.forward_sender_name) return msg.forward_sender_name;
  return '';
}

// Счётчик принятых фото в личном чате — один ответ на всю пачку
const intake = new Map();
function countIntake(chatId, dup) {
  let c = intake.get(chatId);
  if (!c) { c = { added: 0, dup: 0, noMarket: 0, dates: new Set() }; intake.set(chatId, c); }
  clearTimeout(c.timer);
  c.timer = setTimeout(() => {
    intake.delete(chatId);
    const dates = [...c.dates].sort().map(fmtDate);
    const noM = db.photos.filter(p => p.chatId === chatId && !p.market && c.dates.has(p.date)).length;
    sendKb(chatId,
      `📥 Принято фото: ${c.added}` + (c.dup ? ` (повторов пропущено: ${c.dup})` : '') +
      (dates.length ? `\nДаты: ${dates.join(', ')}` : '') +
      (noM ? `\n⚠️ Без названия маркета: ${noM}` : '') +
      (dates.length ? `\n\nАрхив: /zip ${dates[dates.length - 1]}` : ''));
  }, 4000);
  return c;
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
  // Кнопки
  if (isPrivate && isAdmin && text === '📦 ZIP за сегодня') {
    return sendZip(chatId, tashkentNow().date, true).catch(e => send(chatId, `⚠️ Ошибка: ${e.message}`));
  }
  if (isPrivate && isAdmin && text === '📊 Статистика') return send(chatId, statText(tashkentNow().date));

  if (text.startsWith('/')) {
    if (!isPrivate || !isAdmin) return;
  if (/^\/id\b/.test(text)) return send(chatId, `ID этого чата: ${chatId}`);
  if (/^\/start\b/.test(text) || /^\/help\b/.test(text)) {
    return sendKb(chatId,
      'Бот собирает фото полок.\n\n' +
      'Бот молча собирает фото из группы: в подписи к фото — название маркета ' +
      '(или Reply на фото с названием). В группе бот ничего не пишет.\n' +
      'Можно и переслать (Forward) фото из группы сюда — бот возьмёт подпись, автора и дату оригинала.\n\n' +
      'Команды:\n/zip — новые фото за сегодня (которые ещё не выгружали)\n' +
      '/zip 21.11.2026 — все фото за эту дату\n/stat — сколько фото за сегодня\n/stat 21.11.2026 — за дату\n/id — ID чата\n\n' +
      `Бот хранит список фото ${KEEP_DAYS} дней и видит только фото, пришедшие после его добавления в группу.`);
  }
  if (/^\/stat\b/.test(text)) {
    return send(chatId, statText(parseDate(text) || tashkentNow().date));
  }
  if (/^\/zip\b/.test(text)) {
    const d = parseDate(text);
    // /zip — только новые фото за сегодня; /zip 21.11.2026 — все фото за эту дату
    return sendZip(chatId, d || tashkentNow().date, !d).catch(e => send(chatId, `⚠️ Ошибка: ${e.message}`));
  }
    return;
  }
  if (isPrivate && !isAdmin) return; // в личке принимаем фото только от администратора

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

  const fwdDate = (msg.forward_origin && msg.forward_origin.date) || msg.forward_date;
  const now = fwdDate ? tashkentFromUnix(fwdDate) : tashkentNow();
  const merch = (isPrivate && forwardAuthor(msg)) ||
    [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' ') ||
    (msg.from && msg.from.username) || '';
  const albumId = msg.media_group_id || '';

  // Повтор того же фото (переслали дважды или оно уже пришло из группы) — пропускаем
  if (photo.uid) {
    const old = db.photos.find(x => x.uid === photo.uid);
    if (old) {
      if (!old.market && caption) { old.market = caption; save(); }
      if (isPrivate) countIntake(chatId, true).dup++;
      return;
    }
  }

  // В альбоме подпись есть только у одного фото — берём её для всего альбома
  let market = caption;
  if (albumId) {
    const sibling = db.photos.find(x => x.chatId === chatId && x.albumId === albumId && x.market);
    if (caption) db.photos.filter(x => x.chatId === chatId && x.albumId === albumId).forEach(x => { x.market = caption; });
    else if (sibling) market = sibling.market;
  }

  db.photos.push({
    chatId, messageId: msg.message_id, albumId, fileId: photo.fileId, uid: photo.uid, ext: photo.ext,
    date: now.date, time: now.time, market, merch,
  });
  save();
  if (isPrivate) { const c = countIntake(chatId, false); c.added++; c.dates.add(now.date); }
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
  const dl = req.method === 'GET' && req.url.match(/^\/download\/([0-9a-f]{24})$/);
  if (dl) {
    const d = downloads.get(dl[1]);
    if (!d || d.expires < Date.now() || !fs.existsSync(d.file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Ссылка устарела. Отправьте боту /zip ещё раз.');
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': fs.statSync(d.file).size,
      'content-disposition': `attachment; filename="photos.zip"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    });
    return fs.createReadStream(d.file).pipe(res);
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
