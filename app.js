'use strict';

/* ================= Helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = s => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
};
const fmtBytes = b => {
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  if (!b || b < 1) return '0 ك.ب';
  if (b < KB * 10) return (b / KB).toFixed(1) + ' ك.ب';
  if (b < MB) return Math.round(b / KB) + ' ك.ب';
  if (b < GB) return (b / MB).toFixed(1) + ' م.ب';
  return (b / GB).toFixed(2) + ' ج.ب';
};
const uid = () => (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ================= IndexedDB ================= */
const DB_NAME = 'imusic-db', DB_VERSION = 1;
let db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('playlists')) d.createObjectStore('playlists', { keyPath: 'id' });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function dbOp(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const st = db.transaction(store, mode).objectStore(store);
    const req = fn(st);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbPut = (store, val) => dbOp(store, 'readwrite', st => st.put(val));
const dbDelete = (store, key) => dbOp(store, 'readwrite', st => st.delete(key));
const dbGetAll = store => dbOp(store, 'readonly', st => st.getAll());
const dbClear = store => dbOp(store, 'readwrite', st => st.clear());
async function dbQuotaSafePut(store, val) {
  try { await dbPut(store, val); return true; }
  catch (e) {
    if (e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
      toast('مساحة التخزين المخصصة للتطبيق ممتلئة! احذف بعض الأغاني أو امسح بيانات المتصفح القديمة.', 'error', 5200);
    } else {
      toast('تعذر حفظ البيانات محلياً: ' + (e && e.name ? e.name : 'خطأ'), 'error', 4000);
    }
    return false;
  }
}

/* ================= State ================= */
const state = {
  songs: [],
  playlists: [],
  currentId: null,
  ctx: 'library',
  shuffle: false,
  repeat: 'off',
  volume: 1,
  shuffleOrder: [],
  shuffleDirty: true,
  pendingSeek: null,
  selectionMode: false,
  selected: new Set(),
  openPlaylistId: null,
  lastProgressSaved: 0,
  audioFailedNext: false
};
const audio = $('#audio');
let currentUrl = null;
let massArtUrl = null;
/* كاشات الأغلفة بنظام LRU — يمنع نمو الذاكرة بلا حد مع المكتبات الكبيرة */
function createLru(max, onEvict) {
  let cap = max;
  const map = new Map();
  const trim = () => {
    while (map.size > cap) {
      const ok = map.keys().next().value;
      const ov = map.get(ok);
      map.delete(ok);
      if (onEvict) onEvict(ok, ov);
    }
  };
  return {
    get size() { return map.size; },
    get(k) { if (!map.has(k)) return undefined; const v = map.get(k); map.delete(k); map.set(k, v); return v; },
    set(k, v) { if (map.has(k)) map.delete(k); map.set(k, v); trim(); },
    setMax(n) { cap = n; trim(); },
    delete(k) { if (!map.has(k)) return; const v = map.get(k); map.delete(k); if (onEvict) onEvict(k, v); },
    deletePrefix(prefix) { for (const k of [...map.keys()]) if (String(k).startsWith(prefix)) { const v = map.get(k); map.delete(k); if (onEvict) onEvict(k, v); } },
    clear() { for (const [k, v] of [...map]) if (onEvict) onEvict(k, v); map.clear(); },
    has(k) { return map.has(k); }
  };
}
const ART_CACHE_MAX = 240;
const artCache = createLru(ART_CACHE_MAX, null);
const REAL_ART_MAX = 300;
const realArtUrls = createLru(REAL_ART_MAX, v => { if (v) { try { URL.revokeObjectURL(v); } catch (e) { /* ignore */ } } });

const PKEY = 'imusic-prefs';
const prefs = { theme: 'dark', volume: 1, shuffle: false, repeat: 'off', lastSongId: '', lastPosition: 0, lastCtx: 'library', hintDismissed: false, librarySort: 'added', bg: 'none', glass: 'frost', memSave: false };
const SORT_MODES = ['added', 'alpha', 'plays'];
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PKEY);
    if (raw) Object.assign(prefs, JSON.parse(raw));
  } catch (e) { /* ignore */ }
  prefs.volume = clamp(Number(prefs.volume) || 1, 0, 1);
  if (!SORT_MODES.includes(prefs.librarySort)) prefs.librarySort = 'added';
}
function savePrefs() {
  try { localStorage.setItem(PKEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
}

/* ================= Artwork ================= */
function titleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
let bodyFontCache = null;
function drawArtCanvas(canvas, str, px) {
  if (!bodyFontCache) bodyFontCache = getComputedStyle(document.body).fontFamily;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = canvas.height = px;
  const S = px;
  const seed = titleHash(str || 'iMusic');
  const h1 = seed % 360;
  const h2 = (h1 + 50 + (seed % 45)) % 360;
  const lin = ctx.createLinearGradient(0, 0, S, S);
  lin.addColorStop(0, `hsl(${h1} 60% 32%)`);
  lin.addColorStop(1, `hsl(${h2} 74% 44%)`);
  ctx.fillStyle = lin;
  ctx.fillRect(0, 0, S, S);
  const rad = ctx.createRadialGradient(S * 0.28, S * 0.16, 0, S * 0.28, S * 0.16, S * 0.95);
  rad.addColorStop(0, 'hsla(0,0%,100%,.22)');
  rad.addColorStop(1, 'hsla(0,0%,100%,0)');
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(8,12,24,.40)';
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = Math.max(1.5, S * 0.011);
  const rings = 3 + (seed % 3);
  for (let i = 0; i < rings; i++) {
    ctx.beginPath();
    ctx.arc(S * (0.12 + i * 0.24), S * (0.82 - i * 0.12), S * (0.14 + i * 0.1), 0, Math.PI * 2);
    ctx.stroke();
  }
  const letter = ((str || '').trim().charAt(0) || '♪');
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = `800 ${S * 0.32}px ${bodyFontCache}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(4,8,20,.55)';
  ctx.shadowBlur = S * 0.05;
  ctx.fillText(letter, S * 0.5, S * 0.56);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,.16)';
  ctx.font = `800 ${S * 0.26}px ${bodyFontCache}`;
  ctx.fillText('♪', S * 0.84, S * 0.26);
}
function songArt(song, px) {
  const key = song.id + ':' + px;
  const hit = artCache.get(key);
  if (hit !== undefined) return hit;
  const c = document.createElement('canvas');
  drawArtCanvas(c, song.name, px);
  const url = c.toDataURL('image/jpeg', 0.88);
  artCache.set(key, url);
  return url;
}
function songArtBlobUrl(song, px) {
  return new Promise(resolve => {
    const c = document.createElement('canvas');
    drawArtCanvas(c, song.name, px);
    try {
      c.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/png');
    } catch (e) { resolve(null); }
  });
}

/* ================= استخراج صورة الغلاف المدمجة من ملفات الصوت ================= */
function getRealArtUrl(song) {
  let u = realArtUrls.get(song.id);
  if (u) return u;
  u = URL.createObjectURL(song.art);
  realArtUrls.set(song.id, u);
  return u;
}
function artSrc(song, px) {
  return song.art ? getRealArtUrl(song) : songArt(song, px);
}
async function extractCoverArt(file) {
  try {
    if (!file || !file.size) return null;
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    let blob = null;
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) blob = await id3Picture(file);
    else if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) blob = await mp4Picture(file);
    else if (head[0] === 0x66 && head[1] === 0x4C && head[2] === 0x61 && head[3] === 0x43) blob = await flacPicture(file);
    else if (head[0] === 0x4F && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) blob = await oggPicture(file);
    if (!blob || !blob.size) return null;
    return await normalizeCover(blob);
  } catch (e) { return null; }
}
async function normalizeCover(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const max = 512;
    const scale = Math.min(1, max / Math.max(bmp.width || 1, bmp.height || 1));
    const w = Math.max(1, Math.round((bmp.width || 512) * scale));
    const h = Math.max(1, Math.round((bmp.height || 512) * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const out = await new Promise(r => c.toBlob(b => r(b), 'image/jpeg', 0.85));
    return out || blob;
  } catch (e) { return null; }
}
function flacPictureFromBytes(pic) {
  const ddv = new DataView(pic.buffer, pic.byteOffset, pic.byteLength);
  if (pic.length < 32) return null;
  const mimeLen = ddv.getUint32(4);
  const mime = new TextDecoder().decode(pic.subarray(8, 8 + mimeLen)) || 'image/jpeg';
  let p = 8 + mimeLen;
  const descLen = ddv.getUint32(p); p += 4 + descLen + 16;
  if (p + 4 > pic.length) return null;
  const dataLen = ddv.getUint32(p); p += 4;
  if (p + dataLen > pic.length) return null;
  return new Blob([pic.subarray(p, p + dataLen)], { type: mime });
}
async function id3Picture(file) {
  const MAX_SCAN = 6 * 1024 * 1024;
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_SCAN)).arrayBuffer());
  if (!(buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)) return null;
  const ver = buf[3];
  const flags = buf[5];
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const end = Math.min(10 + size, buf.length);
  let pos = 10;
  if (flags & 0x40) {
    if (ver === 3) { const esz = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0; pos += 4 + esz; }
    else { pos += (((buf[pos] & 0x7f) << 21) | ((buf[pos + 1] & 0x7f) << 14) | ((buf[pos + 2] & 0x7f) << 7) | (buf[pos + 3] & 0x7f)); }
    if (pos >= end) return null;
  }
  const dv = new DataView(buf.buffer);
  const fidLen = ver === 2 ? 3 : 4;
  const hdLen = ver === 2 ? 6 : 10;
  while (pos + hdLen <= end) {
    let fid = '';
    for (let i = 0; i < fidLen; i++) fid += String.fromCharCode(buf[pos + i]);
    if (!/^[A-Z0-9]+$/.test(fid)) break;
    let fsz;
    if (ver === 2) fsz = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
    else if (ver === 4) fsz = ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f);
    else fsz = dv.getUint32(pos + 4);
    if (fsz <= 0 || pos + hdLen + fsz > end) break;
    const fstart = pos + hdLen;
    if (fid === 'APIC' || fid === 'PIC') {
      const d = buf.subarray(fstart, fstart + fsz);
      if (d.length < 4) return null;
      const enc = d[0];
      let p, mime;
      if (ver === 2) {
        const fmt = String.fromCharCode(d[1], d[2], d[3]);
        mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
        p = 4;
      } else {
        let m = '';
        p = 1;
        while (p < d.length && d[p] !== 0) m += String.fromCharCode(d[p++]);
        p++;
        mime = m || 'image/jpeg';
      }
      if (p >= d.length) return null;
      p++;
      if (enc === 1 || enc === 2) { while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2; p += 2; }
      else { while (p < d.length && d[p] !== 0) p++; p++; }
      if (p >= d.length) return null;
      return new Blob([d.subarray(p)], { type: mime });
    }
    pos = fstart + fsz;
  }
  return null;
}
async function mp4Picture(file) {
  const findTopAtom = async (name) => {
    let pos = 0;
    while (pos + 8 <= file.size) {
      const h = new Uint8Array(await file.slice(pos, pos + 8).arrayBuffer());
      const sz = ((h[0] << 24 | h[1] << 16 | h[2] << 8 | h[3]) >>> 0);
      const nm = String.fromCharCode(h[4], h[5], h[6], h[7]);
      if (sz < 8) return null;
      if (nm === name) return { start: pos + 8, size: sz - 8 };
      pos += sz;
    }
    return null;
  };
  const moov = await findTopAtom('moov');
  if (!moov) return null;
  const buf = new Uint8Array(await file.slice(moov.start, moov.start + Math.min(moov.size, 12 * 1024 * 1024)).arrayBuffer());
  const scan = (start, end, name) => {
    let pos = start;
    while (pos + 8 <= end) {
      const sz = ((buf[pos] << 24 | buf[pos + 1] << 16 | buf[pos + 2] << 8 | buf[pos + 3]) >>> 0);
      const nm = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
      if (sz < 8) return null;
      if (nm === name) return { start: pos + 8, size: Math.min(sz - 8, end - pos - 8) };
      pos += sz;
    }
    return null;
  };
  const udta = scan(0, buf.length, 'udta'); if (!udta) return null;
  const meta = scan(udta.start, udta.start + udta.size, 'meta'); if (!meta) return null;
  const ilst = scan(meta.start + 4, meta.start + meta.size, 'ilst'); if (!ilst) return null;
  const covr = scan(ilst.start, ilst.start + ilst.size, 'covr'); if (!covr) return null;
  const data = scan(covr.start, covr.start + covr.size, 'data'); if (!data || data.size < 16) return null;
  const typeFlag = ((buf[data.start] << 24 | buf[data.start + 1] << 16 | buf[data.start + 2] << 8 | buf[data.start + 3]) >>> 0) & 0xffffff;
  const mime = typeFlag === 14 ? 'image/png' : 'image/jpeg';
  const payload = buf.subarray(data.start + 8, data.start + data.size);
  if (!payload.length) return null;
  return new Blob([payload], { type: mime });
}
async function flacPicture(file) {
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 10 * 1024 * 1024)).arrayBuffer());
  if (!(buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43)) return null;
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const b = buf[pos];
    const last = b & 0x80, type = b & 0x7f;
    const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    if (type === 6) {
      if (pos + len > buf.length) return null;
      return flacPictureFromBytes(buf.subarray(pos, pos + len));
    }
    pos += len;
    if (last) break;
  }
  return null;
}
async function oggPicture(file) {
  const MAX_SCAN = 3 * 1024 * 1024;
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_SCAN)).arrayBuffer());
  const key = 'METADATA_BLOCK_PICTURE=';
  let found = -1;
  for (let i = 0; i + key.length < buf.length; i++) {
    let ok = true;
    for (let j = 0; j < key.length; j++) { if (buf[i + j] !== key.charCodeAt(j)) { ok = false; break; } }
    if (ok) { found = i + key.length; break; }
  }
  if (found < 0) return null;
  let b64 = '';
  for (let i = found; i < buf.length && b64.length < 2 * 1024 * 1024; i++) {
    const ch = buf[i];
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 43 || ch === 47 || ch === 61) b64 += String.fromCharCode(ch);
    else break;
  }
  if (b64.length < 64) return null;
  const bin = atob(b64);
  const pic = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pic[i] = bin.charCodeAt(i);
  return flacPictureFromBytes(pic);
}

/* ================= Data access ================= */
const getSong = id => state.songs.find(s => s.id === id) || null;
function getPlaylist(id) { return state.playlists.find(p => p.id === id) || null; }
function ctxLabel(id) {
  if (id === 'library') return 'المكتبة الكاملة';
  const p = getPlaylist(id);
  return p ? p.name : 'المكتبة الكاملة';
}
function playsLabel(n) {
  if (!n) return '';
  if (n === 1) return 'مرة واحدة';
  if (n === 2) return 'مرتان';
  if (n <= 10) return n + ' مرات';
  return n + ' مرة';
}
function sortedSongIds(ids, mode) {
  if (mode === 'alpha') {
    return [...ids].sort((a, b) => {
      const sa = getSong(a), sb = getSong(b);
      return (sa ? sa.name : '').localeCompare(sb ? sb.name : '', 'ar', { numeric: true });
    });
  }
  if (mode === 'plays') {
    return [...ids].sort((a, b) => {
      const sa = getSong(a), sb = getSong(b);
      return ((sb ? sb.plays : 0) || 0) - ((sa ? sa.plays : 0) || 0) || ((sa ? sa.order : 0) - (sb ? sb.order : 0));
    });
  }
  return ids;
}
function ctxIds(id) {
  if (id === 'library') {
    const ids = state.songs.map(s => s.id);
    return sortedSongIds(ids, prefs.librarySort);
  }
  const p = getPlaylist(id);
  if (!p) return state.songs.map(s => s.id);
  const ids = p.order.filter(sid => getSong(sid));
  return (p.sort && p.sort !== 'manual') ? sortedSongIds(ids, p.sort) : ids;
}
function nextOrder() {
  let max = -1;
  for (const s of state.songs) if (s.order > max) max = s.order;
  return max + 1;
}

/* ================= Toasts ================= */
const toastsEl = $('#toasts');
const toastIcons = { success: '#i-check', error: '#i-close', info: '#i-note' };
function toast(msg, type = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<svg class="icon"><use href="${toastIcons[type] || toastIcons.info}"/></svg><span>${esc(msg)}</span>`;
  toastsEl.appendChild(el);
  setTimeout(() => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, ms);
  return el;
}
function progressToast(msg) {
  const el = toast(msg, 'info', 1000000);
  return {
    el,
    update(text) { const sp = el.querySelector('span'); if (sp) sp.textContent = text; },
    end() { el.classList.add('leaving'); setTimeout(() => el.remove(), 260); }
  };
}

/* ================= Modals ================= */
const modalRoot = $('#modalRoot'), modalEl = $('#modal');
let modalEscCtl = null;
function bindModalEsc(handler) {
  if (modalEscCtl) modalEscCtl.abort();
  modalEscCtl = new AbortController();
  document.addEventListener('keydown', handler, { signal: modalEscCtl.signal });
}
function abortModalEsc() {
  if (modalEscCtl) { modalEscCtl.abort(); modalEscCtl = null; }
}
let modalCloseTimer = 0;
function openModal(inner) {
  clearTimeout(modalCloseTimer);
  modalEl.classList.remove('closing');
  $('#modalBackdrop').classList.remove('closing');
  modalEl.innerHTML = inner;
  modalRoot.hidden = false;
  const first = modalEl.querySelector('.modal-input, button');
  setTimeout(() => { if (first) first.focus({ preventScroll: true }); }, 60);
  return modalEl;
}
function closeModal() {
  if (modalRoot.hidden || modalEl.classList.contains('closing')) return;
  modalEl.classList.add('closing');
  $('#modalBackdrop').classList.add('closing');
  clearTimeout(modalCloseTimer);
  modalCloseTimer = setTimeout(() => {
    modalRoot.hidden = true;
    modalEl.innerHTML = '';
    modalEl.classList.remove('closing');
    $('#modalBackdrop').classList.remove('closing');
  }, 170);
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modalRoot.hidden) closeModal();
});
function confirmDialog({ title, message, okText }) {
  return new Promise(resolve => {
    openModal(`
      <div class="modal-head"><h3>${esc(title)}</h3>
        <button class="icon-btn" data-x type="button" aria-label="إغلاق"><svg class="icon"><use href="#i-close"/></svg></button></div>
      <div class="modal-body"><p class="modal-note" style="margin-top:2px">${esc(message)}</p></div>
      <div class="modal-foot">
        <button class="btn ghost" data-no type="button">إلغاء</button>
        <button class="btn primary" data-ok type="button">${esc(okText || 'تأكيد')}</button>
      </div>`);
    const okBtn = $('[data-ok]', modalEl);
    const dangerWords = ['تأكيد الحذف', 'حذف', 'إزالة'];
    if (dangerWords.some(w => (okText || '').includes(w))) {
      okBtn.style.background = 'linear-gradient(135deg,var(--danger),#d92b2b)';
      okBtn.style.boxShadow = '0 6px 18px var(--danger-soft)';
    }
    let settled = false;
    const done = v => { if (settled) return; settled = true; abortModalEsc(); closeModal(); resolve(v); };
    bindModalEsc(ev => { if (ev.key === 'Escape') done(false); });
    $('[data-ok]', modalEl).onclick = () => done(true);
    $('[data-no]', modalEl).onclick = () => done(false);
    $('[data-x]', modalEl).onclick = () => done(false);
    $('#modalBackdrop').onclick = () => done(false);
  });
}
function nameDialog({ title, value = '', okText = 'حفظ', placeholder = 'اسم القائمة' }) {
  return new Promise(resolve => {
    openModal(`
      <div class="modal-head"><h3>${esc(title)}</h3>
        <button class="icon-btn" data-x type="button" aria-label="إغلاق"><svg class="icon"><use href="#i-close"/></svg></button></div>
      <div class="modal-body">
        <input id="nameField" class="modal-input" type="text" maxlength="80" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off">
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-no type="button">إلغاء</button>
        <button class="btn primary" data-ok type="button">${esc(okText)}</button>
      </div>`);
    const field = $('#nameField', modalEl);
    field.focus(); field.select();
    let settled = false;
    const done = v => {
      if (settled) return; settled = true;
      abortModalEsc();
      closeModal(); resolve(v);
    };
    bindModalEsc(ev => { if (ev.key === 'Escape') done(null); });
    $('[data-ok]', modalEl).onclick = () => { const v = field.value.trim(); done(v ? v : null); };
    $('[data-no]', modalEl).onclick = () => done(null);
    $('[data-x]', modalEl).onclick = () => done(null);
    $('#modalBackdrop').onclick = () => done(null);
    field.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = field.value.trim(); done(v ? v : null); } });
  });
}

/* ================= Row templates ================= */
function artImg(song, px, cls) {
  return `<img class="${cls}" src="${artSrc(song, px)}" alt="" draggable="false" loading="lazy">`;
}
function rowLibraryHTML(song) {
  const sub = 'مخزنة محلياً · ' + fmtBytes(song.size) + (song.plays ? ' · ' + playsLabel(song.plays) : '');
  return `
    ${state.selectionMode ? `<span class="sel-check"><svg class="icon"><use href="#i-check"/></svg></span>` : ''}
    <span class="art-wrap">${artImg(song, 96, 'art-thumb')}
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    </span>
    <span class="row-main">
      <span class="row-title">${esc(song.name)}</span>
      <span class="row-sub">${esc(sub)}</span>
    </span>
    <span class="row-side">
      <span class="side-time">${fmtTime(song.duration)}</span>
      <button class="icon-btn row-menu" data-menu aria-label="خيارات الأغنية"><svg class="icon"><use href="#i-more"/></svg></button>
    </span>`;
}
function rowPlaylistHTML(song, i, manual) {
  const sub = (manual ? 'اسحب للترتيب أو استخدم الأسهم' : 'مرتبة تلقائياً') + (song.plays ? ' · ' + playsLabel(song.plays) : '');
  const drag = manual ? `<span class="drag-handle" data-drag role="separator" aria-label="اسحب لإعادة الترتيب"><svg class="icon"><use href="#i-drag"/></svg></span>` : '<span class="drag-handle-spacer" aria-hidden="true"></span>';
  return `
    ${drag}
    <span class="art-wrap">${artImg(song, 96, 'art-thumb')}<span class="num-badge">${i + 1}</span>
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    </span>
    <span class="row-main">
      <span class="row-title">${esc(song.name)}</span>
      <span class="row-sub">${esc(sub)}</span>
    </span>
    <span class="row-side">
      <span class="side-time">${fmtTime(song.duration)}</span>
      ${manual ? `<button class="icon-btn row-up" data-up aria-label="تحريك للأعلى"><svg class="icon"><use href="#i-up"/></svg></button>
      <button class="icon-btn row-down" data-down aria-label="تحريك للأسفل"><svg class="icon"><use href="#i-down"/></svg></button>` : ''}
      <button class="icon-btn row-x" data-remove aria-label="إزالة من القائمة"><svg class="icon"><use href="#i-close"/></svg></button>
    </span>`;
}

/* ================= Rendering ================= */
const libraryList = $('#libraryList'), playlistsList = $('#playlistsList'), playlistListEl = $('#playlistList');
function rowCtxMatches(row) {
  if (row.closest('#libraryList')) return state.ctx === 'library';
  if (row.closest('#playlistList')) return state.ctx === state.openPlaylistId;
  return false;
}
function buildLibraryRow(song, enterId) {
  const isCur = song.id === state.currentId && state.ctx === 'library';
  const li = document.createElement('li');
  li.className = 'song-row' + (isCur ? ' playing' : '') + (state.selected.has(song.id) ? ' selected' : '') + (song.id === enterId ? ' enter' : '');
  li.dataset.id = song.id;
  li.setAttribute('role', 'button');
  li.setAttribute('tabindex', '0');
  li.setAttribute('aria-label', 'تشغيل ' + song.name);
  li.innerHTML = rowLibraryHTML(song);
  return li;
}
function renderLibrary(enterId) {
  const ids = ctxIds('library');
  libraryList.replaceChildren(...ids.map(id => buildLibraryRow(getSong(id), enterId)));
  if (!enterId && state.songs.length && !fxOff()) {
    libraryList.classList.remove('stagger');
    void libraryList.offsetWidth;
    libraryList.classList.add('stagger');
  }
  $('#libraryEmpty').classList.toggle('hidden', state.songs.length > 0);
  $('#clearAllBtn').classList.toggle('hidden', state.songs.length === 0);
  $('#selectModeBtn').classList.toggle('hidden', state.songs.length === 0);
}
function appendLibraryRow(song, enterId) {
  libraryList.appendChild(buildLibraryRow(song, enterId));
  $('#libraryEmpty').classList.add('hidden');
  $('#clearAllBtn').classList.remove('hidden');
  $('#selectModeBtn').classList.remove('hidden');
}
function renderPlaylists(enterId) {
  playlistsList.innerHTML = state.playlists.map(p => {
    const ids = ctxIds(p.id);
    const dur = ids.reduce((a, id) => { const s = getSong(id); return a + (s ? s.duration : 0); }, 0);
    return `<li class="playlist-card ${p.id === enterId ? 'enter' : ''}" data-id="${p.id}" role="button" tabindex="0" aria-label="فتح قائمة ${esc(p.name)}">
      <span class="playlist-cover"><svg class="icon"><use href="#i-queue_music"/></svg></span>
      <span class="pl-main"><h3 class="pl-name">${esc(p.name)}</h3><span class="pl-count">${ids.length} ${ids.length === 1 ? 'أغنية' : 'أغانٍ'} · ${fmtTime(dur)}</span></span>
      <span class="pl-side">
        <button class="icon-btn card-play" data-play aria-label="تشغيل القائمة"><svg class="icon"><use href="#i-play"/></svg></button>
        <button class="icon-btn card-menu" data-menu aria-label="خيارات القائمة"><svg class="icon"><use href="#i-more"/></svg></button>
      </span>
    </li>`;
  }).join('');
  if (!enterId && state.playlists.length && !fxOff()) {
    playlistsList.classList.remove('stagger');
    void playlistsList.offsetWidth;
    playlistsList.classList.add('stagger');
  }
  $('#playlistsEmpty').classList.toggle('hidden', state.playlists.length > 0);
}
function renderPlaylistDetail(enterId) {
  const p = getPlaylist(state.openPlaylistId);
  if (!p) return;
  const manual = !p.sort || p.sort === 'manual';
  const ids = ctxIds(p.id);
  playlistListEl.innerHTML = ids.map((sid, i) => {
    const s = getSong(sid);
    const isCur = s.id === state.currentId && state.ctx === p.id;
    return `<li class="song-row ${isCur ? 'playing' : ''} ${s.id === enterId ? 'enter' : ''}" data-id="${s.id}" role="button" tabindex="0" aria-label="تشغيل ${esc(s.name)}">
      ${rowPlaylistHTML(s, i, manual)}
    </li>`;
  }).join('');
  if (!enterId && ids.length && !fxOff()) {
    playlistListEl.classList.remove('stagger');
    void playlistListEl.offsetWidth;
    playlistListEl.classList.add('stagger');
  }
  const total = ids.reduce((a, id) => { const s = getSong(id); return a + (s ? s.duration : 0); }, 0);
  $('#playlistEmpty').classList.toggle('hidden', ids.length > 0);
  $('#detailTitle').textContent = p.name;
  $('#detailMeta').textContent = `${ids.length} ${ids.length === 1 ? 'أغنية' : 'أغانٍ'} · ${fmtTime(total)}`;
  $('#detailPlayBtn').classList.toggle('hidden', ids.length === 0);
  const sp = $('#sortPlaylistBtn');
  if (sp) sp.classList.toggle('active', !manual);
}
function updatePlayingHighlight() {
  $$('.song-row').forEach(row => {
    row.classList.toggle('playing', row.dataset.id === state.currentId && rowCtxMatches(row));
  });
}

/* ================= Mini player / NP ================= */
const miniPlayer = $('#miniPlayer'), miniTitle = $('#miniTitle'), miniContext = $('#miniContext'), miniArt = $('#miniArt');
const npTitle = $('#npTitle'), npContext = $('#npContext'), npArt = $('#npArt'), npArtImg = $('#npArtImg');
const npCur = $('#npCur'), npTotal = $('#npTotal'), npProgress = $('#npProgress'), npVolume = $('#npVolume');
const miniProgressFill = $('#miniProgressFill');
const playIcons = { play: '#i-play', pause: '#i-pause' };

function showMini(show) {
  if (show) {
    miniPlayer.classList.remove('hidden');
    requestAnimationFrame(() => miniPlayer.classList.add('visible'));
    document.body.classList.remove('no-mini');
  } else {
    miniPlayer.classList.remove('visible');
    document.body.classList.add('no-mini');
    setTimeout(() => { if (!state.currentId) miniPlayer.classList.add('hidden'); }, 340);
  }
}
function updatePlayButtons() {
  const paused = !state.currentId || audio.paused;
  const ic = paused ? playIcons.play : playIcons.pause;
  for (const btn of [$('#miniPlay'), $('#npPlay')]) {
    if (!btn) continue;
    const use = btn.querySelector('use');
    if (use) {
      if (use.getAttribute('href') !== ic) {
        use.setAttribute('href', ic);
        const svg = btn.querySelector('svg');
        if (svg && !fxOff()) {
          svg.classList.remove('icon-pop');
          void svg.getBoundingClientRect();
          svg.classList.add('icon-pop');
          svg.addEventListener('animationend', () => svg.classList.remove('icon-pop'), { once: true });
        }
      }
    }
    btn.setAttribute('aria-label', paused ? 'تشغيل' : 'إيقاف مؤقت');
  }
  npArt.classList.toggle('playing', !paused);
}
function updateNowFields() {
  const s = state.currentId ? getSong(state.currentId) : null;
  if (!s) return;
  const label = ctxLabel(state.ctx);
  miniTitle.textContent = s.name;
  miniContext.textContent = 'من: ' + label;
  npTitle.textContent = s.name;
  npContext.textContent = 'تشغيل من: ' + label;
  npTitle.title = s.name;
  document.title = s.name + ' — iMusic';
  miniArt.src = artSrc(s, 96);
  npArtImg.src = artSrc(s, 320);
  npTotal.textContent = fmtTime(s.duration);
}
function resetProgressUI() {
  npProgress.value = 0;
  npProgress.style.setProperty('--val', '0%');
  npCur.textContent = '0:00';
  miniProgressFill.style.transform = 'scaleX(0)';
}
function resetPlayerUI() {
  state.currentId = null;
  if (currentUrl) { const u = currentUrl; currentUrl = null; setTimeout(() => URL.revokeObjectURL(u), 300); }
  const ms = massArtUrl; massArtUrl = null;
  if (ms) setTimeout(() => URL.revokeObjectURL(ms), 300);
  audio.removeAttribute('src'); audio.load();
  miniTitle.textContent = 'لا شيء قيد التشغيل';
  miniContext.textContent = '';
  npTitle.textContent = 'لا أغنية محددة';
  npContext.textContent = '';
  document.title = 'iMusic';
  npProgress.value = 0; npProgress.style.setProperty('--val', '0%');
  npCur.textContent = '0:00'; npTotal.textContent = '0:00';
  miniProgressFill.style.transform = 'scaleX(0)';
  updatePlayButtons();
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch (e) { /* ignore */ }
  }
}

/* ================= Playback core ================= */
function buildShuffleOrder() {
  const base = ctxIds(state.ctx).filter(id => getSong(id));
  const arr = base.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  if (state.currentId) {
    const i = arr.indexOf(state.currentId);
    if (i > 0) { const c = arr.splice(i, 1)[0]; arr.unshift(c); }
  }
  state.shuffleOrder = arr;
  state.shuffleDirty = false;
}
function resolveOrder() {
  const base = ctxIds(state.ctx).filter(id => getSong(id));
  if (!state.shuffle) return base;
  if (state.shuffleDirty || !state.shuffleOrder.length) buildShuffleOrder();
  const live = state.shuffleOrder.filter(id => getSong(id));
  if (live.length !== base.length) { buildShuffleOrder(); return state.shuffleOrder.filter(id => getSong(id)); }
  return live;
}
function updateProgressUI() {
  const d = audio.duration;
  if (isFinite(d) && d > 0) {
    const p = clamp(audio.currentTime / d, 0, 1);
    npProgress.value = Math.round(p * 1000);
    npProgress.style.setProperty('--val', (p * 100).toFixed(2) + '%');
    miniProgressFill.style.transform = `scaleX(${p})`;
    npCur.textContent = fmtTime(audio.currentTime);
  }
}
async function loadSong(id) {
  const s = getSong(id);
  if (!s) return false;
  state.currentId = id;
  state.pendingSeek = null;
  state.audioFailedNext = false;
  s.plays = (s.plays || 0) + 1;
  dbPut('songs', s).catch(() => {});
  prefs.lastSongId = id;
  prefs.lastCtx = state.ctx;
  prefs.lastPosition = 0;
  savePrefs();
  state.lastProgressSaved = Date.now();
  if (massArtUrl) {
    const oldMs = massArtUrl; massArtUrl = null;
    setTimeout(() => { if (massArtUrl !== oldMs) URL.revokeObjectURL(oldMs); }, 2000);
  }
  updateNowFields();
  resetProgressUI();
  updatePlayingHighlight();
  updateMediaSession(s);
  const url = URL.createObjectURL(s.blob);
  const oldUrl = currentUrl;
  currentUrl = url;
  audio.src = url;
  audio.load();
  updateProgressUI();
  if (oldUrl) setTimeout(() => URL.revokeObjectURL(oldUrl), 500);
  return true;
}
async function playSong(id, ctx) {
  if (!getSong(id)) { toast('هذه الأغنية لم تعد موجودة', 'error'); return; }
  if (ctx) state.ctx = ctx;
  state.shuffleDirty = true;
  await loadSong(id);
  showMini(true);
  try { await audio.play(); } catch (e) { /* gesture needed */ }
  updatePlayButtons();
}
function togglePlay() {
  if (!state.currentId) {
    const ids = ctxIds('library');
    if (ids.length) playSong(ids[0], 'library');
    return;
  }
  if (audio.paused) { audio.play().catch(() => {}); } else { audio.pause(); }
}
async function stepTo(id) {
  await loadSong(id);
  showMini(true);
  audio.play().catch(() => {});
  updatePlayButtons();
}
function stepSong(dir, manual) {
  if (!state.currentId) return;
  const ord = resolveOrder();
  if (!ord.length) return;
  const i = ord.indexOf(state.currentId);
  let n = i + dir;
  if (n >= ord.length) {
    if (manual || state.repeat === 'all') n = 0;
    else { audio.pause(); try { audio.currentTime = 0; } catch (e) {} return; }
  } else if (n < 0) {
    n = ord.length - 1;
  }
  const nextId = ord[n];
  if (nextId && nextId !== state.currentId) stepTo(nextId);
  else if (nextId === state.currentId) { try { audio.currentTime = 0; } catch (e) {} audio.play().catch(() => {}); }
}
audio.addEventListener('ended', () => {
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  stepSong(1, false);
});
audio.addEventListener('error', () => {
  if (!state.currentId || state.audioFailedNext) return;
  state.audioFailedNext = true;
  toast('تعذر تشغيل هذا الملف، جارٍ تجاوزه…', 'error', 2200);
  setTimeout(() => stepSong(1, true), 500);
});
audio.addEventListener('timeupdate', () => {
  updateProgressUI();
  const now = Date.now();
  if (now - state.lastProgressSaved > 3000) {
    state.lastProgressSaved = now;
    prefs.lastPosition = audio.currentTime || 0;
    savePrefs();
  }
  updateMediaPosition();
});
audio.addEventListener('loadedmetadata', () => {
  if (isFinite(audio.duration)) npTotal.textContent = fmtTime(audio.duration);
  if (state.pendingSeek !== null) {
    const target = clamp(state.pendingSeek, 0, Math.max(0, (audio.duration || 0) - 1));
    try { audio.currentTime = state.pendingSeek; updateProgressUI(); } catch (e) { /* ignore */ }
    state.pendingSeek = null;
  }
});
audio.addEventListener('play', () => {
  updatePlayButtons();
  if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {} }
});
audio.addEventListener('pause', () => {
  updatePlayButtons();
  prefs.lastPosition = audio.currentTime || 0;
  savePrefs();
  if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {} }
});

/* ================= Media Session ================= */
function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  const apply = (art) => {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.name,
        artist: 'iMusic',
        album: ctxLabel(state.ctx),
        artwork: art ? [art] : []
      });
    } catch (e) { /* ignore */ }
  };
  if (song.art) {
    apply({ src: getRealArtUrl(song), sizes: '512x512', type: song.art.type || 'image/jpeg' });
  }
  else if (massArtUrl) { apply({ src: massArtUrl, sizes: '384x384', type: 'image/png' }); }
  else {
    songArtBlobUrl(song, 384).then(url => {
      if (!url || state.currentId !== song.id) { if (url && state.currentId !== song.id) URL.revokeObjectURL(url); return; }
      massArtUrl = url;
      apply({ src: massArtUrl, sizes: '384x384', type: 'image/png' });
    });
  }
  updateMediaPosition();
}
function updateMediaPosition() {
  if (!('mediaSession' in navigator) || !isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: clamp(audio.currentTime, 0, audio.duration)
    });
  } catch (e) { /* ignore */ }
}
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('nexttrack', () => stepSong(1, true));
    navigator.mediaSession.setActionHandler('previoustrack', () => stepSong(-1, true));
    navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); updateProgressUI(); });
    navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); updateProgressUI(); });
    navigator.mediaSession.setActionHandler('seekto', d => {
      if (d && d.seekTime != null && isFinite(d.seekTime)) { audio.currentTime = d.seekTime; updateProgressUI(); }
    });
  } catch (e) { /* ignore */ }
}

/* ================= Theme ================= */
const themeBtn = $('#themeBtn'), themeMeta = $('#themeColorMeta');
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  themeMeta.content = t === 'light' ? '#eef1f8' : '#0b0e17';
  themeBtn.querySelector('use').setAttribute('href', t === 'light' ? '#i-moon' : '#i-sun');
}
themeBtn.addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const t = isLight ? 'dark' : 'light';
  prefs.theme = t; savePrefs(); applyTheme(t);
  toast(isLight ? 'الوضع الليلي' : 'الوضع النهاري', 'info', 1200);
});

/* ================= Tabs & views ================= */
function switchView(v) {
  $$('.view').forEach(x => x.classList.remove('active'));
  $('#view-' + v).classList.add('active');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v || (v === 'playlist' && t.dataset.view === 'playlists')));
  positionTabInk();
  if (v !== 'library' && state.selectionMode) { exitSelectionMode(false); renderLibrary(); }
}
function positionTabInk() {
  const ink = $('.tab-ink');
  const active = $('.tab.active');
  const tabs = $('.tabs');
  if (!ink || !active || !tabs) return;
  const ar = active.getBoundingClientRect();
  const tr = tabs.getBoundingClientRect();
  ink.style.width = ar.width + 'px';
  ink.style.left = (ar.left - tr.left) + 'px';
}
window.addEventListener('resize', positionTabInk);

/* ================= Songs: add ================= */
const fileInput = $('#fileInput');
const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|ogg|oga|opus|wav|wave|flac|weba|webm|3gp|amr)$/i;
function isAudio(f) { return (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name); }
function readDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    let settled = false;
    const finish = (dur, ok) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      a.removeAttribute('src');
      try { a.load(); } catch (e) { /* ignore */ }
      if (ok) resolve(dur); else reject(new Error('unsupported'));
    };
    const timer = setTimeout(() => finish(0, false), 12000);
    a.onerror = () => finish(0, false);
    a.onloadedmetadata = () => {
      if (settled) return;
      const d = a.duration;
      if (isFinite(d) && d > 0) { finish(d, true); return; }
      try { a.currentTime = 1e7; } catch (e) { finish(0, false); return; }
      let tries = 0;
      a.ontimeupdate = () => {
        tries++;
        if (isFinite(a.duration) && a.duration > 0) { const dd = a.duration; a.ontimeupdate = null; finish(dd, true); }
        else if (tries > 30) { a.ontimeupdate = null; finish(0, false); }
      };
    };
    a.src = url;
  });
}
let persistAsked = false;
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const pt = progressToast('جارٍ إضافة الأغاني… 0/' + files.length);
  let added = 0;
  const failedType = [], failedMeta = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size === 0) { failedMeta.push(f.name); continue; }
    if (!isAudio(f)) { failedType.push(f.name); continue; }
    pt.update(`جارٍ إضافة الأغاني… ${i + 1}/${files.length}`);
    const dur = await readDuration(f).catch(() => -1);
    if (dur < 0) { failedMeta.push(f.name); continue; }
    const song = {
      id: uid(),
      name: f.name.replace(/\.[^.]+$/, '') || 'أغنية بلا عنوان',
      duration: dur,
      size: f.size,
      order: nextOrder(),
      added: Date.now(),
      blob: f,
      art: null
    };
    song.art = await extractCoverArt(f);
    const ok = await dbQuotaSafePut('songs', song);
    if (!ok) break;
    state.songs.push(song);
    appendLibraryRow(song, song.id);
    added++;
  }
  pt.end();
  renderLibrary();
  if (added > 0) {
    toast(added === 1 ? 'تمت إضافة أغنية واحدة بنجاح' : `تمت إضافة ${added} أغانٍ بنجاح`, 'success');
    if (!persistAsked) {
      persistAsked = true;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(() => updateStorageInfo()).catch(() => {});
    }
    updateStorageInfo();
  }
  if (failedType.length) toast('ملفات غير مدعومة تم تجاهلها: ' + failedType.slice(0, 3).join('، ') + (failedType.length > 3 ? ' وغيرها' : ''), 'error', 4200);
  if (failedMeta.length) toast('تعذر قراءة معلومات هذه الملفات: ' + failedMeta.slice(0, 3).join('، ') + (failedMeta.length > 3 ? ' وغيرها' : ''), 'error', 4200);
}
fileInput.addEventListener('change', () => {
  const fl = fileInput.files;
  if (fl && fl.length) handleFiles(fl);
  fileInput.value = '';
});
$('#addSongsBtn').addEventListener('click', () => fileInput.click());

/* ================= Storage info ================= */
async function updateStorageInfo() {
  const el = $('#storageInfo');
  try {
    if (!navigator.storage || !navigator.storage.estimate) { el.textContent = ''; return; }
    const est = await navigator.storage.estimate();
    let persisted = false;
    try { persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { persisted = false; }
    el.textContent = `التخزين: ${fmtBytes(est.usage || 0)}${persisted ? ' · دائم ✓' : ''}`;
    el.title = `المستخدم ${fmtBytes(est.usage || 0)} من ${fmtBytes(est.quota || 0)}`;
  } catch (e) { el.textContent = ''; }
}

/* ================= Remove / clear ================= */
async function removeSong(id) {
  const s = getSong(id);
  if (!s) return;
  const ok = await confirmDialog({
    title: 'إزالة أغنية',
    message: `سيتم حذف «${s.name}» نهائياً من المكتبة وإزالتها من كل قوائم التشغيل. هل أنت متأكد؟`,
    okText: 'تأكيد الحذف'
  });
  if (!ok) return;
  try { await dbDelete('songs', id); } catch (e) { /* ignore */ }
  state.songs = state.songs.filter(x => x.id !== id);
  artCache.deletePrefix(id + ':');
  realArtUrls.delete(id);
  for (const p of state.playlists) {
    const before = p.order.length;
    p.order = p.order.filter(sid => sid !== id);
    if (p.order.length !== before) { state.shuffleDirty = true; try { await dbPut('playlists', p); } catch (e) { /* ignore */ } }
  }
  if (state.selected.has(id)) state.selected.delete(id);
  if (state.currentId === id) { resetPlayerUI(); showMini(false); }
  renderLibrary(); renderPlaylistDetail(); renderPlaylists();
  exitSelectionIfEmpty();
  toast('أُزيلت الأغنية نهائياً', 'success', 1800);
  updateStorageInfo();
}
async function clearAllSongs() {
  if (!state.songs.length) return;
  const ok = await confirmDialog({
    title: 'حذف جميع الأغاني',
    message: `سيتم حذف كل الأغاني (${state.songs.length}) نهائياً من التطبيق، وستصبح كل قوائم التشغيل فارغة (دون حذفها). هل أنت متأكد؟`,
    okText: 'تأكيد الحذف الكلي'
  });
  if (!ok) return;
  resetPlayerUI(); showMini(false);
  try { await dbClear('songs'); } catch (e) { /* ignore */ }
  state.songs = [];
  artCache.clear();
  realArtUrls.clear();
  state.selected.clear();
  for (const p of state.playlists) { p.order = []; try { await dbPut('playlists', p); } catch (e) { /* ignore */ } }
  state.ctx = 'library'; state.shuffleDirty = true;
  exitSelectionMode(false);
  renderLibrary(); renderPlaylistDetail(); renderPlaylists();
  toast('تم حذف كل الأغاني', 'success');
  updateStorageInfo();
}
$('#clearAllBtn').addEventListener('click', clearAllSongs);
function exitSelectionIfEmpty() {
  if (state.selectionMode && !state.songs.length) exitSelectionMode(true);
}

/* ================= إعادة تسمية الأغنية ================= */
async function renameSong(id) {
  const s = getSong(id);
  if (!s) return;
  const name = await nameDialog({ title: 'إعادة تسمية الأغنية', value: s.name, okText: 'حفظ', placeholder: 'اسم الأغنية' });
  if (!name || name === s.name) return;
  s.name = name;
  try { await dbPut('songs', s); } catch (e) { /* ignore */ }
  artCache.deletePrefix(s.id + ':');
  renderLibrary();
  renderPlaylistDetail();
  if (state.currentId === id) { updateNowFields(); updateMediaSession(s); }
  toast('تم تغيير اسم الأغنية', 'success', 1500);
}

/* ================= الترتيب ================= */
const SORT_OPTIONS = [
  { id: 'added', label: 'الأحدث إضافة' },
  { id: 'alpha', label: 'أبجديًا (أ-ي)' },
  { id: 'plays', label: 'الأكثر تشغيلاً' }
];
function sortLabel(mode) {
  const o = SORT_OPTIONS.find(x => x.id === mode);
  return o ? o.label : 'الأحدث إضافة';
}
function pickSort(current, includeManual, onPick) {
  const opts = includeManual ? [{ id: 'manual', label: 'يدوي (سحب وإفلات)' }, ...SORT_OPTIONS] : SORT_OPTIONS;
  openModal(`
    <div class="modal-head"><h3>ترتيب حسب</h3>
      <button class="icon-btn" data-x type="button" aria-label="إغلاق"><svg class="icon"><use href="#i-close"/></svg></button></div>
    <div class="modal-body">
      <div class="picker-list">
        ${opts.map(o => `<button class="picker-row ${o.id === current ? 'selected' : ''}" data-sort="${o.id}">
          <span class="picker-icon"><svg class="icon"><use href="#i-sort"/></svg></span>
          <span class="picker-main"><span class="picker-title">${o.label}</span></span>
          <span class="sel-check" style="${o.id === current ? 'background:var(--accent);border-color:var(--accent);color:#fff' : ''}"><svg class="icon"><use href="#i-check"/></svg></span>
        </button>`).join('')}
      </div>
    </div>`);
  $('[data-x]', modalEl).onclick = closeModal;
  $('#modalBackdrop').onclick = closeModal;
  $$('[data-sort]', modalEl).forEach(b => b.onclick = () => { closeModal(); onPick(b.dataset.sort); });
}
function updateSortLibraryLabel() {
  const el = $('#sortLibraryLabel');
  if (el) el.textContent = sortLabel(prefs.librarySort);
}
$('#sortLibraryBtn').addEventListener('click', () => {
  pickSort(prefs.librarySort, false, mode => {
    prefs.librarySort = mode;
    savePrefs();
    updateSortLibraryLabel();
    renderLibrary();
    updatePlayingHighlight();
    toast('الترتيب: ' + sortLabel(mode), 'info', 1300);
  });
});
$('#sortPlaylistBtn').addEventListener('click', () => {
  const p = getPlaylist(state.openPlaylistId);
  if (!p) return;
  const cur = (!p.sort || p.sort === 'manual') ? 'manual' : p.sort;
  pickSort(cur, true, async mode => {
    p.sort = mode;
    try { await dbPut('playlists', p); } catch (e) { /* ignore */ }
    renderPlaylistDetail();
    if (state.ctx === p.id) updatePlayingHighlight();
    toast(mode === 'manual' ? 'الترتيب: يدوي' : 'الترتيب: ' + sortLabel(mode), 'info', 1300);
  });
});

/* ================= Playlists CRUD ================= */
async function createPlaylist(name, ids = []) {
  const p = { id: uid(), name, order: ids.slice(), created: Date.now() };
  state.playlists.push(p);
  const ok = await dbQuotaSafePut('playlists', p);
  if (!ok) { state.playlists = state.playlists.filter(x => x.id !== p.id); return null; }
  renderPlaylists(p.id);
  return p;
}
$('#createPlaylistBtn').addEventListener('click', async () => {
  const name = await nameDialog({ title: 'قائمة تشغيل جديدة', okText: 'إنشاء' });
  if (!name) return;
  const p = await createPlaylist(name);
  if (p) toast(`أُنشئت قائمة «${p.name}»`, 'success', 2000);
});
async function renamePlaylist(id) {
  const p = getPlaylist(id);
  if (!p) return;
  const name = await nameDialog({ title: 'إعادة تسمية القائمة', value: p.name, okText: 'حفظ' });
  if (!name || name === p.name) return;
  p.name = name;
  try { await dbPut('playlists', p); } catch (e) { /* ignore */ }
  renderPlaylists();
  if (state.openPlaylistId === id) renderPlaylistDetail();
  if (state.ctx === id) updateNowFields();
  toast('تم تغيير اسم القائمة', 'success', 1500);
}
async function deletePlaylist(id) {
  const p = getPlaylist(id);
  if (!p) return;
  const ok = await confirmDialog({
    title: 'حذف القائمة',
    message: `سيتم حذف قائمة «${p.name}» فقط، والأغاني ستبقى في المكتبة كما هي. متابعة؟`,
    okText: 'تأكيد الحذف'
  });
  if (!ok) return;
  try { await dbDelete('playlists', id); } catch (e) { /* ignore */ }
  state.playlists = state.playlists.filter(x => x.id !== id);
  state.shuffleDirty = true;
  if (state.openPlaylistId === id) { state.openPlaylistId = null; switchView('playlists'); }
  else {
    renderPlaylists();
    if (activeViewPlaylist()) renderPlaylistDetail();
  }
  if (state.ctx === id) { state.ctx = 'library'; updateNowFields(); updatePlayingHighlight(); }
  toast('حُذفت القائمة، وتبقى الأغاني في المكتبة', 'success', 2400);
}
function activeViewPlaylist() { return document.querySelector('#view-playlist').classList.contains('active'); }

/* ================= Detail navigation ================= */
function openPlaylist(id) {
  const p = getPlaylist(id);
  if (!p) return;
  state.openPlaylistId = id;
  renderPlaylistDetail();
  switchView('playlist');
}
$('#backBtn').addEventListener('click', () => { state.openPlaylistId = null; switchView('playlists'); });
$('#detailMenuBtn').addEventListener('click', () => { if (state.openPlaylistId) playlistMenu(state.openPlaylistId); });
$('#detailPlayBtn').addEventListener('click', () => { if (state.openPlaylistId) startPlaylist(state.openPlaylistId); });
$('#addSongsToPlaylistBtn').addEventListener('click', () => { if (state.openPlaylistId) addSongsToPlaylist(state.openPlaylistId); });
function startPlaylist(id) {
  const ids = ctxIds(id);
  if (!ids.length) { toast('القائمة فارغة — أضف أغاني أولاً', 'info'); return; }
  state.ctx = id;
  state.shuffleDirty = true;
  playSong(ids[0], id);
}

/* ================= Menus ================= */
function songMenu(id) {
  const s = getSong(id);
  if (!s) return;
  openModal(`
    <div class="modal-head"><h3>${esc(s.name)}</h3>
      <button class="icon-btn" data-x type="button" aria-label="إغلاق"><svg class="icon"><use href="#i-close"/></svg></button></div>
    <div class="modal-body">
      <div class="picker-list">
        <button class="picker-row" data-a="play"><span class="picker-icon"><svg class="icon"><use href="#i-play"/></svg></span><span class="picker-main"><span class="picker-title">تشغيل الآن</span></span></button>
        <button class="picker-row" data-a="add"><span class="picker-icon"><svg class="icon"><use href="#i-playlist-add"/></svg></span><span class="picker-main"><span class="picker-title">إضافة إلى قائمة تشغيل…</span></span></button>
        <button class="picker-row" data-a="rename"><span class="picker-icon"><svg class="icon"><use href="#i-edit"/></svg></span><span class="picker-main"><span class="picker-title">إعادة تسمية</span></span></button>
        <button class="picker-row" data-a="remove" style="color:var(--danger)"><span class="picker-icon" style="background:var(--danger-soft);color:var(--danger)"><svg class="icon"><use href="#i-trash"/></svg></span><span class="picker-main"><span class="picker-title">إزالة من المكتبة</span></span></button>
      </div>
    </div>`);
  $('[data-x]', modalEl).onclick = closeModal;
  $('#modalBackdrop').onclick = closeModal;
  const map = {
    play: () => { closeModal(); playSong(id, 'library'); },
    add: () => { closeModal(); choosePlaylistAndAdd([id]); },
    rename: () => { closeModal(); renameSong(id); },
    remove: () => { closeModal(); removeSong(id); }
  };
  $$('[data-a]', modalEl).forEach(b => b.onclick = map[b.dataset.a]);
}
function playlistMenu(id) {
  const p = getPlaylist(id);
  if (!p) return;
  openModal(`
    <div class="modal-head"><h3>${esc(p.name)}</h3>
      <button class="icon-btn" data-x type="button" aria-label="إغلاق"><svg class="icon"><use href="#i-close"/></svg></button></div>
    <div class="modal-body">
      <div class="picker-list">
        <button class="picker-row" data-a="play"><span class="picker-icon"><svg class="icon"><use href="#i-play"/></svg></span><span class="picker-main"><span class="picker-title">تشغيل القائمة</span></span></button>
        <button class="picker-row" data-a="rename"><span class="picker-icon"><svg class="icon"><use href="#i-edit"/></svg></span><span class="picker-main"><span class="picker-title">إعادة تسمية</span></span></button>
        <button class="picker-row" data-a="delete" style="color:var(--danger)"><span class="picker-icon" style="background:var(--danger-soft);color:var(--danger)"><svg class="icon"><use href="#i-trash"/></svg></span><span class="picker-main"><span class="picker-title">حذف القائمة</span></span></button>
      </div>
    </div>`);
  $('[data-x]', modalEl).onclick = closeModal;
  $('#modalBackdrop').onclick = closeModal;
  const map = {
    play: () => { closeModal(); startPlaylist(id); },
    rename: () => { closeModal(); renamePlaylist(id); },
    delete: () => { closeModal(); deletePlaylist(id); }
  };
  $$('[data-a]', modalEl).forEach(b => b.onclick = map[b.dataset.a]);
}

/* ================= Choose playlist / add songs to playlist ================= */
function choosePlaylistAndAdd(songIds) {
  const n = songIds.length;
  openModal(`
    <div class="modal-head"><h3>إضافة ${n === 1 ? 'أغنية' : n + ' أغانٍ'} إلى قائمة</h3>
      <button class="icon-btn" data-x type="button" aria-label="إغلاق"><svg class="icon"><use href="#i-close"/></svg></button></div>
    <div class="modal-body">
      <div class="picker-list">
        <button class="picker-row" data-new><span class="picker-icon"><svg class="icon"><use href="#i-add"/></svg></span><span class="picker-main"><span class="picker-title">قائمة جديدة…</span></span></button>
        ${state.playlists.map(p => `<button class="picker-row" data-p="${p.id}">
          <span class="picker-icon"><svg class="icon"><use href="#i-queue_music"/></svg></span>
          <span class="picker-main"><span class="picker-title">${esc(p.name)}</span><span class="picker-sub">${ctxIds(p.id).length} أغنية</span></span>
        </button>`).join('')}
      </div>
      ${state.playlists.length === 0 ? '<p class="picker-empty">لا توجد قوائم بعد — اختر «قائمة جديدة…»</p>' : ''}
    </div>`);
  $('[data-x]', modalEl).onclick = closeModal;
  $('#modalBackdrop').onclick = closeModal;
  const proceedTarget = async targetId => {
    closeModal();
    if (targetId === '__new__') {
      const name = await nameDialog({ title: 'قائمة جديدة', okText: 'إنشاء وإضافة' });
      if (!name) return;
      const p = await createPlaylist(name, songIds);
      if (p) {
        if (state.openPlaylistId === p.id) renderPlaylistDetail();
        toast(`أُضيفت ${n} ${n === 1 ? 'أغنية' : 'أغانٍ'} إلى «${p.name}»`, 'success');
      }
      return;
    }
    const p = getPlaylist(targetId);
    if (!p) return;
    let added = 0;
    for (const sid of songIds) if (!p.order.includes(sid)) { p.order.push(sid); added++; }
    if (added) {
      try { await dbPut('playlists', p); } catch (e) { /* ignore */ }
      state.shuffleDirty = true;
      renderPlaylists(p.id);
      if (state.openPlaylistId === p.id) renderPlaylistDetail();
    }
    toast(added ? `أُضيفت ${added} ${added === 1 ? 'أغنية' : 'أغانٍ'} إلى «${p.name}»` : 'الأغاني موجودة في القائمة مسبقاً', added ? 'success' : 'info');
  };
  const news = $('[data-new]', modalEl);
  if (news) news.onclick = () => { closeModal(); proceedTarget('__new__'); };
  $$('[data-p]', modalEl).forEach(b => b.onclick = () => proceedTarget(b.dataset.p));
}
function addSongsToPlaylist(plId) {
  const p = getPlaylist(plId);
  if (!p) return;
  const existing = new Set(p.order);
  const candidates = state.songs.filter(s => !existing.has(s.id));
  const chosen = new Set();
  const pickCls = 'sel-check';
  const checkStyle = on => on ? 'background:var(--accent);border-color:var(--accent);color:#fff' : 'background:transparent;border-color:var(--text-3);color:transparent';
  openModal(`
    <div class="modal-head"><h3>إضافة أغانٍ إلى «${esc(p.name)}»</h3>
      <button class="icon-btn" data-x type="button" aria-label="إغلاق"><svg class="icon"><use href="#i-close"/></svg></button></div>
    <div class="modal-body">
      ${candidates.length === 0 ? '<p class="picker-empty">كل أغاني مكتبتك موجودة في هذه القائمة بالفعل</p>' : ''}
      <div class="picker-list">
        ${candidates.map(s => `<button class="picker-row" data-s="${s.id}">
          ${artImg(s, 96, 'picker-art')}
          <span class="picker-main"><span class="picker-title">${esc(s.name)}</span><span class="picker-sub">${fmtTime(s.duration)} · ${fmtBytes(s.size)}</span></span>
          <span class="${pickCls}" style="${checkStyle(chosen.has(s.id))}"><svg class="icon"><use href="#i-check"/></svg></span>
        </button>`).join('')}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-no type="button">إلغاء</button>
      <button class="btn primary" data-ok type="button"><span>إضافة (${chosen.size})</span></button>
    </div>`);
  $('[data-x]', modalEl).onclick = closeModal;
  $('#modalBackdrop').onclick = closeModal;
  const okBtn = $('[data-ok]', modalEl);
  const refresh = () => {
    okBtn.querySelector('span').textContent = 'إضافة' + (chosen.size ? ` (${chosen.size})` : '');
    okBtn.style.opacity = chosen.size ? '1' : '.55';
    $$('[data-s]', modalEl).forEach(b => {
      const chk = b.querySelector('.sel-check');
      chk.setAttribute('style', checkStyle(chosen.has(b.dataset.s)));
      b.classList.toggle('selected', chosen.has(b.dataset.s));
    });
  };
  $$('[data-s]', modalEl).forEach(b => b.addEventListener('click', () => {
    const s = b.dataset.s;
    if (chosen.has(s)) chosen.delete(s); else chosen.add(s);
    refresh();
  }));
  $('[data-no]', modalEl).onclick = closeModal;
  okBtn.addEventListener('click', async () => {
    if (!chosen.size) { toast('اختر أغنية واحدة على الأقل', 'info', 1600); return; }
    for (const sid of chosen) p.order.push(sid);
    try { await dbPut('playlists', p); } catch (e) { /* ignore */ }
    state.shuffleDirty = true;
    closeModal();
    renderPlaylistDetail(); renderPlaylists();
    toast(`أُضيفت ${chosen.size} ${chosen.size === 1 ? 'أغنية' : 'أغانٍ'} إلى القائمة`, 'success');
  });
  refresh();
}

/* ================= Selection mode ================= */
const selectionBar = $('#selectionBar');
function enterSelectionMode() {
  state.selectionMode = true;
  state.selected.clear();
  renderLibrary();
  selectionBar.classList.remove('hidden');
  installHint.classList.add('hidden');
  updateSelCount();
}
function exitSelectionMode(rerender = true) {
  state.selectionMode = false;
  state.selected.clear();
  selectionBar.classList.add('hidden');
  if (rerender) renderLibrary();
}
function updateSelCount() {
  const n = state.selected.size;
  $('#selCount').textContent = n ? `حددت ${n} ${n === 1 ? 'أغنية' : 'أغانٍ'}` : 'لم تحدد شيئاً';
}
$('#selectModeBtn').addEventListener('click', () => {
  if (state.selectionMode) exitSelectionMode(); else enterSelectionMode();
});
$('#selCancel').addEventListener('click', () => exitSelectionMode());
$('#selAddToPlaylist').addEventListener('click', () => {
  if (!state.selected.size) { toast('حدد أغنية واحدة على الأقل', 'info'); return; }
  const ids = [...state.selected];
  exitSelectionMode(false);
  renderLibrary();
  choosePlaylistAndAdd(ids);
});
$('#selDelete').addEventListener('click', async () => {
  if (!state.selected.size) { toast('حدد أغنية واحدة على الأقل', 'info'); return; }
  const ids = [...state.selected];
  const n = ids.length;
  const ok = await confirmDialog({
    title: 'حذف الأغاني المحددة',
    message: `سيتم حذف ${n} ${n === 1 ? 'أغنية' : 'أغانٍ'} نهائياً من المكتبة. متابعة؟`,
    okText: 'تأكيد الحذف'
  });
  if (!ok) return;
  for (const id of ids) {
    try { await dbDelete('songs', id); } catch (e) { /* ignore */ }
    state.songs = state.songs.filter(x => x.id !== id);
    artCache.deletePrefix(id + ':');
    realArtUrls.delete(id);
    for (const p of state.playlists) {
      const b = p.order.length;
      p.order = p.order.filter(sid => sid !== id);
      if (p.order.length !== b) state.shuffleDirty = true;
    }
  }
  for (const p of state.playlists) { try { await dbPut('playlists', p); } catch (e) { /* ignore */ } }
  if (state.currentId && (ids.includes(state.currentId))) { resetPlayerUI(); showMini(false); }
  artCache.clear();
  exitSelectionMode(true);
  renderPlaylistDetail(); renderPlaylists();
  toast(`حُذفت ${n} ${n === 1 ? 'أغنية' : 'أغانٍ'} نهائياً`, 'success');
  updateStorageInfo();
});

/* ================= List interactions ================= */
libraryList.addEventListener('click', e => {
  const row = e.target.closest('.song-row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.row-menu')) { songMenu(id); return; }
  if (state.selectionMode) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    row.classList.toggle('selected', state.selected.has(id));
    updateSelCount();
    return;
  }
  if (state.ctx !== 'library') { state.ctx = 'library'; state.shuffleDirty = true; updatePlayingHighlight(); updateNowFields(); }
  playSong(id, 'library');
});
libraryList.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.closest('button')) return;
  const row = e.target.closest('.song-row');
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.id;
  if (state.selectionMode) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); row.classList.toggle('selected'); updateSelCount(); return; }
  if (state.ctx !== 'library') { state.ctx = 'library'; state.shuffleDirty = true; updatePlayingHighlight(); updateNowFields(); }
  playSong(id, 'library');
});
playlistListEl.addEventListener('click', e => {
  const row = e.target.closest('.song-row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.drag-handle')) { e.preventDefault(); return; }
  if (e.target.closest('[data-up]')) { moveInPlaylist(id, -1); return; }
  if (e.target.closest('[data-down]')) { moveInPlaylist(id, 1); return; }
  if (e.target.closest('[data-remove]')) { removeFromPlaylist(id); return; }
  if (state.ctx !== state.openPlaylistId) { state.ctx = state.openPlaylistId; state.shuffleDirty = true; updatePlayingHighlight(); updateNowFields(); }
  playSong(id, state.openPlaylistId);
});
playlistListEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.closest('button')) return;
  const row = e.target.closest('.song-row');
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.id;
  if (state.ctx !== state.openPlaylistId) { state.ctx = state.openPlaylistId; state.shuffleDirty = true; updatePlayingHighlight(); updateNowFields(); }
  playSong(id, state.openPlaylistId);
});
playlistsList.addEventListener('click', e => {
  const card = e.target.closest('.playlist-card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('[data-play]')) { startPlaylist(id); return; }
  if (e.target.closest('[data-menu]')) { playlistMenu(id); return; }
  openPlaylist(id);
});
$$('[data-action]').forEach(b => b.addEventListener('click', () => {
  const a = b.dataset.action;
  if (a === 'add-songs') fileInput.click();
  else if (a === 'create-playlist') $('#createPlaylistBtn').click();
  else if (a === 'add-to-playlist' && state.openPlaylistId) addSongsToPlaylist(state.openPlaylistId);
}));
async function moveInPlaylist(id, dir) {
  const p = getPlaylist(state.openPlaylistId);
  if (!p) return;
  const i = p.order.indexOf(id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= p.order.length) return;
  const t = p.order[i]; p.order[i] = p.order[j]; p.order[j] = t;
  try { await dbPut('playlists', p); } catch (e) { /* ignore */ }
  state.shuffleDirty = true;
  renderPlaylistDetail();
}
async function removeFromPlaylist(id) {
  const p = getPlaylist(state.openPlaylistId);
  if (!p) return;
  p.order = p.order.filter(sid => sid !== id);
  try { await dbPut('playlists', p); } catch (e) { /* ignore */ }
  state.shuffleDirty = true;
  renderPlaylistDetail();
  toast('أُزيلت من القائمة — وستبقى في المكتبة', 'info', 2200);
}

/* ================= Drag to reorder ================= */
function setupDrag(listEl, onCommit) {
  let ghost = null, srcRow = null, fromIdx = -1, startTop = 0, grabDy = 0, rowH = 0, rects = [], targetIdx = -1;
  const onDown = e => {
    if (!e.target.closest('[data-drag]')) return;
    const row = e.target.closest('.song-row');
    if (!row) return;
    e.preventDefault();
    srcRow = row;
    const rows = $$('.song-row', listEl);
    fromIdx = rows.indexOf(row);
    if (fromIdx < 0) return;
    rects = rows.map(r => r.getBoundingClientRect());
    rowH = rows.length === 1 ? rects[0].height : Math.abs(rects[1].top - rects[0].top);
    grabDy = e.clientY - rects[fromIdx].top;
    startTop = rects[fromIdx].top;
    ghost = row.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = rects[fromIdx].width + 'px';
    ghost.style.left = rects[fromIdx].left + 'px';
    ghost.style.top = rects[fromIdx].top + 'px';
    document.body.appendChild(ghost);
    row.classList.add('dragging-src');
    document.body.classList.add('drag-active');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    targetIdx = fromIdx;
  };
  const onMove = e => {
    if (!ghost) return;
    const dy = e.clientY - grabDy - startTop;
    ghost.style.transform = `translateY(${dy}px)`;
    const gc = startTop + dy + rects[fromIdx].height / 2;
    let target = fromIdx;
    for (let i = 0; i < rects.length; i++) {
      if (i === fromIdx) continue;
      const cy = rects[i].top + rects[i].height / 2;
      if (i < fromIdx && gc < cy) { target = Math.min(target, i); }
      if (i > fromIdx && gc > cy) { target = Math.max(target, i); }
    }
    targetIdx = target;
    $$('.song-row', listEl).forEach((r, i) => {
      if (i === fromIdx) return;
      r.classList.remove('shift-up', 'shift-down');
      if (i >= target && i < fromIdx) { r.classList.add('shift-down'); r.style.setProperty('--shift', rowH + 'px'); }
      else if (i > fromIdx && i <= target) { r.classList.add('shift-up'); r.style.setProperty('--shift', rowH + 'px'); }
    });
  };
  const cleanup = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('drag-active');
    if (ghost) { ghost.remove(); ghost = null; }
    if (srcRow) { srcRow.classList.remove('dragging-src'); srcRow = null; }
    $$('.song-row', listEl).forEach(r => { r.classList.remove('shift-up', 'shift-down'); r.style.removeProperty('--shift'); });
  };
  const onUp = () => {
    if (!ghost) { cleanup(); return; }
    const from = fromIdx, to = targetIdx;
    cleanup();
    if (to >= 0 && to !== from) onCommit(from, to);
  };
  listEl.addEventListener('pointerdown', onDown);
}
setupDrag(playlistListEl, async (from, to) => {
  const p = getPlaylist(state.openPlaylistId);
  if (!p) return;
  const ids = p.order.filter(id => getSong(id));
  const moved = ids.splice(from, 1)[0];
  ids.splice(to, 0, moved);
  p.order = ids;
  try { await dbPut('playlists', p); } catch (e) { /* ignore */ }
  state.shuffleDirty = true;
  renderPlaylistDetail();
});

/* ================= Mini / NP controls ================= */
$('#miniPlay').addEventListener('click', togglePlay);
$('#npPlay').addEventListener('click', togglePlay);
$('#miniNext').addEventListener('click', () => stepSong(1, true));
$('#npNext').addEventListener('click', () => stepSong(1, true));
$('#miniPrev').addEventListener('click', () => { if (audio.duration && audio.currentTime > 3) { audio.currentTime = 0; } else stepSong(-1, true); });
$('#npPrev').addEventListener('click', () => { if (audio.duration && audio.currentTime > 3) { audio.currentTime = 0; updateProgressUI(); } else stepSong(-1, true); });
$('#miniOpen').addEventListener('click', () => { if (state.currentId) openNP(); });
$('#npClose').addEventListener('click', closeNP);
$('#npBackdrop').addEventListener('click', closeNP);
let npOpen = false;
function openNP() {
  if (!state.currentId) return;
  npOpen = true;
  $('#npBackdrop').classList.add('open');
  $('#npSheet').classList.add('open');
  $('#npSheet').setAttribute('aria-hidden', 'false');
}
function closeNP() {
  npOpen = false;
  $('#npBackdrop').classList.remove('open');
  $('#npSheet').classList.remove('open');
  $('#npSheet').setAttribute('aria-hidden', 'true');
}
$('#npShuffle').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  prefs.shuffle = state.shuffle; savePrefs();
  state.shuffleDirty = true;
  $('#npShuffle').classList.toggle('active', state.shuffle);
  toast(state.shuffle ? 'التشغيل العشوائي: مُفعّل' : 'التشغيل العشوائي: معطّل', 'info', 1300);
});
const REPEATS = ['off', 'all', 'one'];
$('#npRepeat').addEventListener('click', () => {
  const next = REPEATS[(REPEATS.indexOf(state.repeat) + 1) % 3];
  state.repeat = next;
  prefs.repeat = next; savePrefs();
  applyRepeatUI();
  toast(next === 'off' ? 'التكرار: معطّل' : next === 'all' ? 'التكرار: كل القائمة' : 'التكرار: الأغنية الحالية', 'info', 1300);
});
function applyRepeatUI() {
  const btn = $('#npRepeat');
  btn.classList.toggle('active', state.repeat !== 'off');
  const use = btn.querySelector('use');
  use.setAttribute('href', state.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  $('#repeatBadge').classList.toggle('hidden', state.repeat !== 'one');
}
$('#npMute').addEventListener('click', () => {
  if (state.volume > 0) { state.volume = 0; }
  else { state.volume = prefs.lastVolume || 0.8; }
  applyVolume();
});
$('#npVolume').addEventListener('input', () => {
  state.volume = Number(npVolume.value) / 100;
  if (state.volume > 0.01) prefs.lastVolume = state.volume;
  applyVolume();
});
function applyVolume() {
  audio.volume = clamp(state.volume, 0, 1);
  npVolume.value = Math.round(state.volume * 100);
  npVolume.style.setProperty('--val', (state.volume * 100) + '%');
  prefs.volume = state.volume; savePrefs();
  $('#npMute').querySelector('use').setAttribute('href', state.volume <= 0.01 ? '#i-vol-mute' : '#i-vol');
}
npProgress.addEventListener('input', () => {
  const v = Number(npProgress.value) / 1000;
  npProgress.style.setProperty('--val', (v * 100) + '%');
  const s = state.currentId ? getSong(state.currentId) : null;
  const d = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : (s ? s.duration : 0);
  if (d > 0) npCur.textContent = fmtTime(v * d);
});
npProgress.addEventListener('change', () => {
  const v = Number(npProgress.value) / 1000;
  const s = state.currentId ? getSong(state.currentId) : null;
  const d = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : (s ? s.duration : 0);
  if (d > 0) {
    audio.currentTime = v * d;
    prefs.lastPosition = audio.currentTime; savePrefs();
    updateMediaPosition();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && npOpen) closeNP(); });

/* ================= Install & update ================= */
let deferredPrompt = null;
const installBtn = $('#installBtn'), installHint = $('#installHint');
function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  window.__bipFired = true;
  installHint.classList.add('hidden');
  if (!isStandalone()) installBtn.classList.remove('hidden');
});
installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  try {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice && choice.outcome === 'accepted') { installBtn.classList.add('hidden'); toast('شكراً لتثبيت iMusic', 'success'); }
  } catch (e) { /* ignore */ }
  deferredPrompt = null;
});
window.addEventListener('appinstalled', () => {
  installBtn.classList.add('hidden');
  installHint.classList.add('hidden');
  deferredPrompt = null;
  toast('تم تثبيت iMusic بنجاح', 'success');
});
$('#installHintDismiss').addEventListener('click', () => {
  installHint.classList.add('hidden');
  prefs.hintDismissed = true;
  savePrefs();
});
const updateBanner = $('#updateBanner');
let updateWaiting = false;
function showUpdateBanner() { updateBanner.classList.remove('hidden'); }
$('#updateBtn').addEventListener('click', async () => {
  updateWaiting = true;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
    else if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('SKIP_WAITING');
  } catch (e) { /* ignore */ }
});
$('#updateDismiss').addEventListener('click', () => updateBanner.classList.add('hidden'));
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.search.indexOf('nosew') !== -1) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
      });
    });
    setInterval(() => { reg.update().catch(() => {}); }, 60000);
  }).catch(() => { /* offline dev? */ });
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateWaiting && !window.__swReloading) {
      window.__swReloading = true;
      location.reload();
    }
  });
}

/* ================= الإعدادات والخلفيات المتحركة ================= */
const BG_MODES = ['none', 'galaxy', 'wave', 'bars'];
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fxOff = () => prefs.memSave || REDUCED_MOTION;
const FX_OFF = () => prefs.memSave || REDUCED_MOTION;
const bgCanvas = $('#bgCanvas');
const bgCtx = bgCanvas.getContext('2d');
let bgMode = 'none';
let bgRafId = 0;
let bgLastFrame = 0;
let bgW = 0, bgH = 0;
let stars = [];
let shooting = [];
let nextShootAt = 0;
let nebulaCanvas = null;
let audioCtx = null;
let analyser = null;
let timeData = null;
let freqData = null;
let wavePhase = 0;
let barsPhase = 0;
let lastPlayIconState = null;

function setBg(mode) {
  if (!BG_MODES.includes(mode)) mode = 'none';
  bgMode = mode;
  prefs.bg = mode;
  savePrefs();
  if (mode === 'none') {
    document.documentElement.removeAttribute('data-bg');
  } else {
    document.documentElement.setAttribute('data-bg', mode);
  }
  refreshBgOptionsUI();
  stopBgLoop();
  if (mode === 'none') return;
  sizeBgCanvas();
  if (mode === 'galaxy') {
    initStars();
    buildNebula();
  } else if (!fxOff()) {
    ensureAudioGraph();
  }
  if (fxOff()) {
    if (bgMode === 'galaxy') drawGalaxy(0, true);
    else if (bgMode === 'bars') drawBars(0, true);
    else drawWave(0, true);
    return;
  }
  bgLastFrame = 0;
  bgRafId = requestAnimationFrame(bgLoop);
}
function stopBgLoop() {
  if (bgRafId) { cancelAnimationFrame(bgRafId); bgRafId = 0; }
  bgLastFrame = 0;
}
function sizeBgCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  bgW = window.innerWidth;
  bgH = window.innerHeight;
  bgCanvas.width = Math.round(bgW * dpr);
  bgCanvas.height = Math.round(bgH * dpr);
  bgCanvas.style.width = bgW + 'px';
  bgCanvas.style.height = bgH + 'px';
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function initStars() {
  const count = clamp(Math.round(bgW * bgH / 9000), 60, 220);
  stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * bgW,
      y: Math.random() * bgH,
      z: 0.25 + Math.random() * 0.75,
      r: 0.6 + Math.random() * 1.7,
      tw: 0.5 + Math.random() * 2.2,
      ph: Math.random() * Math.PI * 2,
      tint: Math.random()
    });
  }
  shooting = [];
  nextShootAt = 800 + Math.random() * 2500;
}
function buildNebula() {
  nebulaCanvas = document.createElement('canvas');
  nebulaCanvas.width = bgW;
  nebulaCanvas.height = bgH;
  const nc = nebulaCanvas.getContext('2d');
  const blobs = [
    { x: bgW * 0.82, y: bgH * 0.12, r: bgH * 0.55, c: 'rgba(88,64,200,0.16)' },
    { x: bgW * 0.12, y: bgH * 0.82, r: bgH * 0.5, c: 'rgba(30,90,200,0.13)' },
    { x: bgW * 0.55, y: bgH * 0.45, r: bgH * 0.62, c: 'rgba(150,60,160,0.08)' }
  ];
  for (const b of blobs) {
    const g = nc.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, b.c);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    nc.fillStyle = g;
    nc.fillRect(0, 0, bgW, bgH);
  }
}
function starColor(tint) {
  if (tint < 0.7) return '255,255,255';
  if (tint < 0.9) return '188,215,255';
  return '255,217,168';
}
function drawGalaxy(now, staticFrame) {
  const ctx = bgCtx;
  ctx.clearRect(0, 0, bgW, bgH);
  if (nebulaCanvas) ctx.drawImage(nebulaCanvas, 0, 0, bgW, bgH);
  const t = now * 0.001;
  for (const s of stars) {
    const alpha = (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph))) * (0.35 + s.z * 0.65);
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * (0.75 + s.z * 0.5), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${starColor(s.tint)},${alpha.toFixed(3)})`;
    ctx.fill();
  }
  if (staticFrame) return;
  for (const s of stars) {
    s.x -= s.z * 0.06;
    s.y += s.z * 0.018;
    if (s.x < -4) s.x = bgW + 4;
    if (s.y > bgH + 4) s.y = -4;
  }
  if (now > nextShootAt) {
    const fromTop = Math.random() < 0.7;
    const speed = 320 + Math.random() * 380;
    const ang = Math.PI * (0.62 + Math.random() * 0.18);
    shooting.push({
      x: bgW * (0.35 + Math.random() * 0.6),
      y: fromTop ? -12 : Math.random() * bgH * 0.28,
      vx: -Math.cos(Math.PI - ang) * speed,
      vy: Math.abs(Math.sin(ang)) * speed * 0.55,
      born: now,
      life: 700 + Math.random() * 600,
      len: 90 + Math.random() * 90
    });
    nextShootAt = now + 2800 + Math.random() * 5200;
  }
  for (let i = shooting.length - 1; i >= 0; i--) {
    const sh = shooting[i];
    const p = (now - sh.born) / sh.life;
    if (p >= 1 || sh.x < -sh.len || sh.y > bgH + sh.len) { shooting.splice(i, 1); continue; }
    const alpha = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
    const tailX = sh.x - sh.vx * (sh.len / 400);
    const tailY = sh.y - sh.vy * (sh.len / 400);
    const grad = ctx.createLinearGradient(sh.x, sh.y, tailX, tailY);
    grad.addColorStop(0, `rgba(255,255,255,${(0.9 * alpha).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(160,200,255,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sh.x, sh.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sh.x, sh.y, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${(0.95 * alpha).toFixed(3)})`;
    ctx.fill();
  }
}
function ensureAudioGraph() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    audioCtx = new AC();
    const src = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    timeData = new Uint8Array(analyser.fftSize);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch (e) {
    audioCtx = null; analyser = null;
  }
}
let waveEnv = 0, waveLast = null, waveLastScale = 0.5;
function drawWave(now, staticFrame) {
  const ctx = bgCtx;
  ctx.clearRect(0, 0, bgW, bgH);
  const midY = bgH / 2;
  const N = 160;
  const playing = !audio.paused && analyser;
  waveEnv += ((playing ? 1 : 0) - waveEnv) * (playing ? 0.12 : 0.05);
  if (!playing && waveEnv < 0.004) waveEnv = 0;
  wavePhase += staticFrame ? 0 : 0.016;
  const idle = [];
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    idle.push(Math.sin(x * Math.PI * 4 + wavePhase) * 0.035 * (1 + Math.sin(wavePhase * 0.7 + x * 6)));
  }
  if (playing) {
    analyser.getByteTimeDomainData(timeData);
    const step = Math.floor(timeData.length / N);
    let peak = 0;
    const real = [];
    for (let i = 0; i < N; i++) {
      const v = (timeData[i * step] - 128) / 128;
      real.push(v);
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    waveLastScale = clamp(0.3 + peak * 1.1, 0.3, 0.58);
    waveLast = real;
  }
  let points;
  if (waveLast && waveEnv > 0) points = idle.map((iv, i) => iv + (waveLast[i] * waveLastScale - iv) * waveEnv);
  else points = idle;
  const ampY = midY * 0.64;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = (i / (points.length - 1)) * bgW;
    const y = midY + points[i] * ampY;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const px = ((i - 1) / (points.length - 1)) * bgW;
      const py = midY + points[i - 1] * ampY;
      ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
    }
  }
  ctx.strokeStyle = 'rgba(127,178,255,0.95)';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(79,141,255,0.85)';
  ctx.shadowBlur = 18;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(bgW, midY);
  ctx.stroke();
}
let barsEnv = 0, barsLast = null;
function drawBars(now, staticFrame) {
  const ctx = bgCtx;
  ctx.clearRect(0, 0, bgW, bgH);
  const N = 56;
  const gap = Math.max(3, bgW / 220);
  const padX = Math.max(10, bgW * 0.015);
  const bw = (bgW - padX * 2 - gap * (N - 1)) / N;
  const midY = bgH / 2;
  const maxH = midY * 0.45;
  const playing = !audio.paused && analyser && freqData;
  barsEnv += ((playing ? 1 : 0) - barsEnv) * (playing ? 0.12 : 0.05);
  if (!playing && barsEnv < 0.004) barsEnv = 0;
  barsPhase += staticFrame ? 0 : 0.02;
  const idle = [];
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    idle.push(0.12 + 0.10 * Math.sin(x * Math.PI * 5 + barsPhase) * Math.sin(barsPhase * 0.6 + x * 9));
  }
  if (playing) {
    analyser.getByteFrequencyData(freqData);
    const bins = analyser.frequencyBinCount;
    const real = new Array(N);
    for (let i = 0; i < N; i++) {
      const t0 = Math.floor(Math.pow(i / N, 1.6) * bins * 0.72);
      const t1 = Math.max(t0 + 1, Math.floor(Math.pow((i + 1) / N, 1.6) * bins * 0.72));
      let sum = 0;
      for (let j = t0; j < t1; j++) sum += freqData[j];
      real[i] = Math.pow((sum / (t1 - t0)) / 255, 0.85);
    }
    barsLast = real;
  }
  let vals;
  if (barsLast && barsEnv > 0) vals = idle.map((iv, i) => iv + (barsLast[i] - iv) * barsEnv);
  else vals = idle;
  for (let i = 0; i < N; i++) {
    const h = Math.max(4, vals[i] * maxH);
    const x = padX + i * (bw + gap);
    const grad = ctx.createLinearGradient(0, midY - h, 0, midY + h);
    grad.addColorStop(0, 'rgba(160,200,255,0.95)');
    grad.addColorStop(0.5, 'rgba(79,141,255,0.42)');
    grad.addColorStop(1, 'rgba(160,200,255,0.95)');
    ctx.fillStyle = grad;
    const r = Math.min(bw / 2, 4);
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, midY - h, bw, h * 2, r);
      ctx.fill();
    } else {
      ctx.fillRect(x, midY - h, bw, h * 2);
    }
  }
  ctx.fillStyle = 'rgba(127,178,255,0.18)';
  ctx.fillRect(0, midY - 0.75, bgW, 1.5);
}
function bgLoop(now) {
  bgRafId = 0;
  if (bgMode === 'none' || document.hidden) return;
  if (!bgLastFrame) bgLastFrame = now;
  if (now - bgLastFrame >= 30) {
    bgLastFrame = now;
    if (bgMode === 'galaxy') drawGalaxy(now);
    else if (bgMode === 'bars') drawBars(now);
    else drawWave(now);
  }
  bgRafId = requestAnimationFrame(bgLoop);
}
window.addEventListener('resize', () => {
  if (bgMode === 'none') return;
  sizeBgCanvas();
  if (bgMode === 'galaxy') { initStars(); buildNebula(); if (fxOff()) drawGalaxy(0, true); }
  else if (fxOff()) { if (bgMode === 'bars') drawBars(0, true); else drawWave(0, true); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && bgMode !== 'none' && !bgRafId && !fxOff()) {
    bgLastFrame = 0;
    bgRafId = requestAnimationFrame(bgLoop);
  }
});
audio.addEventListener('play', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
});

/* ورقة الإعدادات */
const settingsSheet = $('#settingsSheet'), settingsBackdrop = $('#settingsBackdrop');
const GLASS_LABELS = { clear: 'شفاف', soft: 'مصنّر خفيف', frost: 'مصنّر خالص' };
function applyGlass() {
  const g = ['clear', 'soft', 'frost'].includes(prefs.glass) ? prefs.glass : 'frost';
  document.documentElement.setAttribute('data-glass', g);
}
function applyMemSave() {
  if (prefs.memSave) document.documentElement.setAttribute('data-memsave', '');
  else document.documentElement.removeAttribute('data-memsave');
  artCache.setMax(prefs.memSave ? 80 : ART_CACHE_MAX);
  realArtUrls.setMax(prefs.memSave ? 80 : REAL_ART_MAX);
}
function refreshBgOptionsUI() {
  $$('#bgOptions .picker-row').forEach(b => {
    const on = b.dataset.bg === bgMode;
    b.classList.toggle('selected', on);
    const chk = b.querySelector('.sel-check');
    if (chk) chk.setAttribute('style', on ? 'background:var(--accent);border-color:var(--accent);color:#fff' : '');
  });
  const glassSec = $('#glassSec'), glassOpts = $('#glassOptions');
  if (glassSec && glassOpts) {
    const showGlass = bgMode !== 'none';
    glassSec.classList.toggle('hidden', !showGlass);
    glassOpts.classList.toggle('hidden', !showGlass);
    if (showGlass) {
      $$('#glassOptions .picker-row').forEach(b => {
        const on = b.dataset.glass === (prefs.glass || 'frost');
        b.classList.toggle('selected', on);
        const chk = b.querySelector('.sel-check');
        if (chk) chk.setAttribute('style', on ? 'background:var(--accent);border-color:var(--accent);color:#fff' : '');
      });
    }
  }
  const msr = $('#memSaveRow');
  if (msr) {
    msr.classList.toggle('selected', !!prefs.memSave);
    const chk = msr.querySelector('.sel-check');
    if (chk) chk.setAttribute('style', prefs.memSave ? 'background:var(--accent);border-color:var(--accent);color:#fff' : '');
  }
  $$('#themeOptions .picker-row').forEach(b => {
    const on = b.dataset.themeOpt === (document.documentElement.getAttribute('data-theme') || 'dark');
    b.classList.toggle('selected', on);
    const chk = b.querySelector('.sel-check');
    if (chk) chk.setAttribute('style', on ? 'background:var(--accent);border-color:var(--accent);color:#fff' : '');
  });
}
function openSettings() {
  refreshBgOptionsUI();
  settingsBackdrop.classList.add('open');
  settingsSheet.classList.add('open');
  settingsSheet.setAttribute('aria-hidden', 'false');
}
function closeSettings() {
  settingsBackdrop.classList.remove('open');
  settingsSheet.classList.remove('open');
  settingsSheet.setAttribute('aria-hidden', 'true');
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsClose').addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', closeSettings);
$$('#bgOptions .picker-row').forEach(b => b.addEventListener('click', () => {
  const m = b.dataset.bg;
  if (m === bgMode) { closeSettings(); return; }
  setBg(m);
  toast(m === 'none' ? 'أُغلفت الخلفية المتحركة' : m === 'galaxy' ? 'خلفية المجرة والنجوم' : m === 'bars' ? 'خلفية الأعمدة الصوتية' : 'خلفية الموجة الصوتية', 'success', 1500);
}));
$$('#glassOptions .picker-row').forEach(b => b.addEventListener('click', () => {
  prefs.glass = b.dataset.glass;
  savePrefs();
  applyGlass();
  refreshBgOptionsUI();
  toast('قوة الزجاج: ' + (GLASS_LABELS[prefs.glass] || 'مصنّر خالص'), 'success', 1400);
}));
$('#memSaveRow').addEventListener('click', () => {
  prefs.memSave = !prefs.memSave;
  savePrefs();
  applyMemSave();
  artCache.clear();
  realArtUrls.clear();
  if (bgMode !== 'none') setBg(prefs.bg);
  renderLibrary();
  renderPlaylistDetail();
  if (state.currentId) updateNowFields();
  refreshBgOptionsUI();
  toast(prefs.memSave ? 'وضع توفير الذاكرة: مُفعّل' : 'وضع توفير الذاكرة: مُعطّل', 'success', 1800);
});
$$('#themeOptions .picker-row').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.themeOpt;
  prefs.theme = t; savePrefs(); applyTheme(t);
  refreshBgOptionsUI();
}));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && settingsSheet.classList.contains('open')) closeSettings();
});

/* ================= Session restore ================= */
function restoreSession() {
  state.volume = clamp(prefs.volume, 0, 1);
  state.shuffle = !!prefs.shuffle;
  state.repeat = REPEATS.includes(prefs.repeat) ? prefs.repeat : 'off';
  $('#npShuffle').classList.toggle('active', state.shuffle);
  applyRepeatUI();
  applyVolume();
  if (prefs.lastSongId && getSong(prefs.lastSongId)) {
    state.ctx = (prefs.lastCtx === 'library' || getPlaylist(prefs.lastCtx)) ? prefs.lastCtx : 'library';
    const s = getSong(prefs.lastSongId);
    state.currentId = s.id;
    state.pendingSeek = prefs.lastPosition > 0 ? prefs.lastPosition : null;
    updateNowFields();
    updatePlayingHighlight();
    updateMediaSession(s);
    const url = URL.createObjectURL(s.blob);
    if (currentUrl) setTimeout(() => URL.revokeObjectURL(currentUrl), 400);
    currentUrl = url;
    audio.src = url;
    showMini(true);
  } else {
    document.body.classList.add('no-mini');
  }
}

/* ================= ترحيل استخراج الأغلفة للأغاني القديمة ================= */
let migrateRunning = false;
async function migrateCovers() {
  if (migrateRunning) return;
  migrateRunning = true;
  for (const s of state.songs) {
    if (s.art !== undefined) continue;
    if (!s.blob || !(s.blob instanceof Blob)) { s.art = null; continue; }
    const blob = await extractCoverArt(s.blob);
    s.art = blob;
    try { await dbPut('songs', s); } catch (e) { /* ignore */ }
    if (blob) {
      if (state.currentId === s.id) { updateNowFields(); updateMediaSession(s); }
      renderLibrary();
      if (activeViewPlaylist()) renderPlaylistDetail();
      await new Promise(r => setTimeout(r, 60));
    }
  }
  migrateRunning = false;
}

/* ================= Init ================= */
async function init() {
  loadPrefs();
  applyMemSave();
  applyTheme(prefs.theme === 'light' ? 'light' : 'dark');
  applyGlass();
  setBg(prefs.bg || 'none');
  document.body.classList.add('no-mini');
  try { await openDB(); } catch (e) {
    toast('تعذر فتح قاعدة البيانات المحلية. جرّب متصفحاً حديثاً.', 'error', 5000);
    return;
  }
  try {
    const results = await Promise.all([dbGetAll('songs'), dbGetAll('playlists')]);
    state.songs = (results[0] || []).filter(s => s && s.id && s.blob instanceof Blob);
    state.songs.sort((a, b) => a.order - b.order || (a.added || 0) - (b.added || 0));
    state.playlists = (results[1] || []).filter(Boolean).sort((a, b) => (a.created || 0) - (b.created || 0));
  } catch (e) {
    toast('خطأ أثناء قراءة بياناتك المخزنة', 'error', 4000);
  }
  renderLibrary();
  renderPlaylists();
  updateSortLibraryLabel();
  positionTabInk();
  bindChrome();
  restoreSession();
  updateStorageInfo();
  registerSW();
  migrateCovers();
}
function bindChrome() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
  positionTabInk();
  window.addEventListener('pagehide', () => { prefs.lastPosition = audio.currentTime || 0; savePrefs(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { prefs.lastPosition = audio.currentTime || 0; savePrefs(); }
    else { try { navigator.serviceWorker && navigator.serviceWorker.getRegistration && navigator.serviceWorker.getRegistration().then(r => r && r.update && r.update()); } catch (e) {} }
  });
  checkInstallAvailability();
}
function checkInstallAvailability() {
  if (isStandalone()) { installBtn.classList.add('hidden'); installHint.classList.add('hidden'); return; }
  if (!window.__bipFired && !prefs.hintDismissed) {
    setTimeout(() => { if (!window.__bipFired && !isStandalone()) installHint.classList.remove('hidden'); }, 3200);
  }
}
init().then(() => { window.__ready = true; });
window.__imusic = state;
