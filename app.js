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
const artCache = new Map();

const PKEY = 'imusic-prefs';
const prefs = { theme: 'dark', volume: 1, shuffle: false, repeat: 'off', lastSongId: '', lastPosition: 0, lastCtx: 'library', hintDismissed: false };
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PKEY);
    if (raw) Object.assign(prefs, JSON.parse(raw));
  } catch (e) { /* ignore */ }
  prefs.volume = clamp(Number(prefs.volume) || 1, 0, 1);
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
  const ctx = canvas.getContext('2d');
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
  if (!artCache.has(key)) {
    const c = document.createElement('canvas');
    drawArtCanvas(c, song.name, px);
    artCache.set(key, c.toDataURL('image/jpeg', 0.88));
  }
  return artCache.get(key);
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

/* ================= Data access ================= */
const getSong = id => state.songs.find(s => s.id === id) || null;
function getPlaylist(id) { return state.playlists.find(p => p.id === id) || null; }
function ctxLabel(id) {
  if (id === 'library') return 'المكتبة الكاملة';
  const p = getPlaylist(id);
  return p ? p.name : 'المكتبة الكاملة';
}
function ctxIds(id) {
  if (id === 'library') return state.songs.map(s => s.id);
  const p = getPlaylist(id);
  if (!p) return state.songs.map(s => s.id);
  return p.order.filter(sid => getSong(sid));
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
function openModal(inner) {
  modalEl.innerHTML = inner;
  modalRoot.hidden = false;
  const first = modalEl.querySelector('.modal-input, button');
  setTimeout(() => { if (first) first.focus({ preventScroll: true }); }, 60);
  return modalEl;
}
function closeModal() {
  modalRoot.hidden = true;
  modalEl.innerHTML = '';
}
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
    const done = v => { if (settled) return; settled = true; document.removeEventListener('keydown', escHandler); closeModal(); resolve(v); };
    const escHandler = ev => { if (ev.key === 'Escape') done(false); };
    document.addEventListener('keydown', escHandler);
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
      document.removeEventListener('keydown', escHandler);
      closeModal(); resolve(v);
    };
    const escHandler = ev => { if (ev.key === 'Escape') done(null); };
    document.addEventListener('keydown', escHandler);
    $('[data-ok]', modalEl).onclick = () => { const v = field.value.trim(); done(v ? v : null); };
    $('[data-no]', modalEl).onclick = () => done(null);
    $('[data-x]', modalEl).onclick = () => done(null);
    $('#modalBackdrop').onclick = () => done(null);
    field.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = field.value.trim(); done(v ? v : null); } });
  });
}

/* ================= Row templates ================= */
function artImg(song, px, cls) {
  return `<img class="${cls}" src="${songArt(song, px)}" alt="" draggable="false">`;
}
function rowLibraryHTML(song) {
  const sub = 'مخزنة محلياً · ' + fmtBytes(song.size);
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
function rowPlaylistHTML(song, i) {
  return `
    <span class="drag-handle" data-drag role="separator" aria-label="اسحب لإعادة الترتيب"><svg class="icon"><use href="#i-drag"/></svg></span>
    <span class="art-wrap">${artImg(song, 96, 'art-thumb')}<span class="num-badge">${i + 1}</span>
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    </span>
    <span class="row-main">
      <span class="row-title">${esc(song.name)}</span>
      <span class="row-sub">اسحب للترتيب أو استخدم الأسهم</span>
    </span>
    <span class="row-side">
      <span class="side-time">${fmtTime(song.duration)}</span>
      <button class="icon-btn row-up" data-up aria-label="تحريك للأعلى"><svg class="icon"><use href="#i-up"/></svg></button>
      <button class="icon-btn row-down" data-down aria-label="تحريك للأسفل"><svg class="icon"><use href="#i-down"/></svg></button>
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
function renderLibrary(enterId) {
  libraryList.innerHTML = state.songs.map(s => {
    const isCur = s.id === state.currentId && state.ctx === 'library';
    return `<li class="song-row ${isCur ? 'playing' : ''} ${state.selected.has(s.id) ? 'selected' : ''} ${s.id === enterId ? 'enter' : ''}" data-id="${s.id}" role="button" tabindex="0" aria-label="تشغيل ${esc(s.name)}">
      ${rowLibraryHTML(s)}
    </li>`;
  }).join('');
  $('#libraryEmpty').classList.toggle('hidden', state.songs.length > 0);
  $('#clearAllBtn').classList.toggle('hidden', state.songs.length === 0);
  $('#selectModeBtn').classList.toggle('hidden', state.songs.length === 0 || !!state.openPlaylistId === false);
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
  $('#playlistsEmpty').classList.toggle('hidden', state.playlists.length > 0);
}
function renderPlaylistDetail(enterId) {
  const p = getPlaylist(state.openPlaylistId);
  if (!p) return;
  const ids = p.order.filter(id => getSong(id));
  playlistListEl.innerHTML = ids.map((sid, i) => {
    const s = getSong(sid);
    const isCur = s.id === state.currentId && state.ctx === p.id;
    return `<li class="song-row ${isCur ? 'playing' : ''} ${s.id === enterId ? 'enter' : ''}" data-id="${s.id}" role="button" tabindex="0" aria-label="تشغيل ${esc(s.name)}">
      ${rowPlaylistHTML(s, i)}
    </li>`;
  }).join('');
  const total = ids.reduce((a, id) => { const s = getSong(id); return a + (s ? s.duration : 0); }, 0);
  $('#playlistEmpty').classList.toggle('hidden', ids.length > 0);
  $('#detailTitle').textContent = p.name;
  $('#detailMeta').textContent = `${ids.length} ${ids.length === 1 ? 'أغنية' : 'أغانٍ'} · ${fmtTime(total)}`;
  $('#detailPlayBtn').classList.toggle('hidden', ids.length === 0);
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
    if (use) use.setAttribute('href', ic);
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
  miniArt.src = songArt(s, 96);
  npArtImg.src = songArt(s, 320);
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
function currentSongArtUrl() { return massArtUrl; }
function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  const apply = (art) => {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.name,
        artist: 'iMusic',
        album: ctxLabel(state.ctx),
        artwork: art ? [{ src: art, sizes: '384x384', type: 'image/png' }] : []
      });
    } catch (e) { /* ignore */ }
  };
  if (massArtUrl) { apply(massArtUrl); }
  else {
    songArtBlobUrl(song, 384).then(url => {
      if (!url || state.currentId !== song.id) { if (url && state.currentId !== song.id) URL.revokeObjectURL(url); return; }
      massArtUrl = url;
      apply(massArtUrl);
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
      blob: f
    };
    const ok = await dbQuotaSafePut('songs', song);
    if (!ok) break;
    state.songs.push(song);
    renderLibrary(song.id);
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
  artCache.clear();
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
        <button class="picker-row" data-a="remove" style="color:var(--danger)"><span class="picker-icon" style="background:var(--danger-soft);color:var(--danger)"><svg class="icon"><use href="#i-trash"/></svg></span><span class="picker-main"><span class="picker-title">إزالة من المكتبة</span></span></button>
      </div>
    </div>`);
  $('[data-x]', modalEl).onclick = closeModal;
  $('#modalBackdrop').onclick = closeModal;
  const map = {
    play: () => { closeModal(); playSong(id, 'library'); },
    add: () => { closeModal(); choosePlaylistAndAdd([id]); },
    remove: () => { closeModal(); removeSong(id); }
  };
  $$('[data-a]', modalEl).forEach(b => b.onclick = map[b.dataset.a]);
  const escH = ev => { if (ev.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escH); } };
  document.addEventListener('keydown', escH);
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
  const row = e.target.closest('.song-row');
  if (!row || e.key !== 'Enter') return;
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
playlistsList.addEventListener('click', e => {
  const card = e.target.closest('.playlist-card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('[data-play]')) { startPlaylist(id); return; }
  if (e.target.closest('[data-menu]')) { playlistMenu(id); return; }
  openPlaylist(id);
});
$$('[data-empty]').forEach(b => b.addEventListener('click', () => {
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
$('#updateBtn').addEventListener('click', () => {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  updateWaiting = true;
  navigator.serviceWorker.controller.postMessage('SKIP_WAITING');
});
$('#updateDismiss').addEventListener('click', () => updateBanner.classList.add('hidden'));
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.search.indexOf('nosew') !== -1) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
    reg.addEventListener('updatefound', () => { reg.update(); });
    setInterval(() => { reg.update().catch(() => {}); }, 60000);
  }).catch(() => { /* offline dev? */ });
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && updateWaiting) location.reload();
  });
}

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

/* ================= Init ================= */
async function init() {
  loadPrefs();
  applyTheme(prefs.theme === 'light' ? 'light' : 'dark');
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
  positionTabInk();
  bindChrome();
  restoreSession();
  updateStorageInfo();
  registerSW();
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
