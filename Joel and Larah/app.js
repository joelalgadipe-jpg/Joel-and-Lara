'use strict';
/* =========================================================
   Joel & Lara — our little website (v2)
   Everything is saved inside this browser (IndexedDB + localStorage).
   ========================================================= */

/* ---------- helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
const fmtDate = d => d ? new Date(d + 'T00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
const fmtTs = ts => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const fmtShort = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const norm = s => String(s || '').trim().toLowerCase();

const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
};

let toastTimer;
function toast(msg, sticky = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function burst(x, y, set = ['💖', '💕', '✨', '💗', '🌸']) {
  try {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (let i = 0; i < 12; i++) {
      const s = document.createElement('span');
      s.className = 'burst';
      s.textContent = set[i % set.length];
      s.style.left = x + 'px'; s.style.top = y + 'px';
      document.body.appendChild(s);
      if (!s.animate) { s.remove(); continue; }
      const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 70;
      const anim = s.animate([
        { transform: 'translate(-50%,-50%) scale(.5)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d - 30}px)) scale(1.3)`, opacity: 0 }
      ], { duration: 800 + Math.random() * 400, easing: 'ease-out' });
      anim.onfinish = () => s.remove();
    }
  } catch { /* decoration only */ }
}
const burstAt = el => { const r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2); };

/* ---------- IndexedDB (big storage for photos) ---------- */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('joel-lara-db', 2);
  r.onupgradeneeded = () => {
    const d = r.result;
    ['photos', 'stories', 'images'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
    if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
function run(store, mode, fn) {
  return dbp.then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const dbAll = s => run(s, 'readonly', o => o.getAll());
const dbGet = (s, k) => run(s, 'readonly', o => o.get(k));
const dbPut = (s, v, k) => run(s, 'readwrite', o => (k === undefined ? o.put(v) : o.put(v, k)));
const dbDel = (s, k) => run(s, 'readwrite', o => o.delete(k));
const kvGet = async (k, d) => { const v = await dbGet('kv', k); return v === undefined ? d : v; };
const kvSet = (k, v) => dbPut('kv', v, k);

/* ---------- shared state ---------- */
let photos = [];            // gallery photos
let view = [];              // photos currently shown (after filter/sort)
let stories = [];
let favs = defaultFavs();
let avatars = {};
let notes = [];
let bucket = [];
const images = new Map();   // small photos used by favorites / avatars / story chapters
const urlCache = new Map(); // gallery object URLs

/* ---------- floating hearts ---------- */
function floatHearts() {
  const box = $('#hearts');
  const em = ['💗', '💖', '💕', '🤍', '✨'];
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('span');
    s.textContent = em[i % em.length];
    s.style.cssText = `left:${Math.random() * 100}%;font-size:${12 + Math.random() * 18}px;animation-duration:${14 + Math.random() * 16}s;animation-delay:${-Math.random() * 20}s`;
    box.appendChild(s);
  }
}

/* =========================================================
   IMAGES (resized copies for favorites, avatars, story photos)
   ========================================================= */
async function makeThumb(file, max = 700, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * sc));
    c.height = Math.max(1, Math.round(bmp.height * sc));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  } catch { return null; }
}
async function saveImage(src) {
  const blob = (await makeThumb(src, 1000, 0.85)) || src;
  const rec = { id: uid(), blob };
  await dbPut('images', rec);
  images.set(rec.id, rec);
  return rec.id;
}
function imgSrc(id) {
  const r = id && images.get(id);
  if (!r) return '';
  if (!r.url) r.url = URL.createObjectURL(r.blob);
  return r.url;
}
async function dropImage(id) {
  if (!id) return;
  const r = images.get(id);
  if (r && r.url) URL.revokeObjectURL(r.url);
  images.delete(id);
  try { await dbDel('images', id); } catch { /* ignore */ }
}
function slot(id, attrs, label = 'Add photo', cls = '') {
  const src = imgSrc(id);
  return src
    ? `<button type="button" class="slot has ${cls}" ${attrs} aria-label="Change photo"><img src="${src}" alt=""><span class="slot-edit">✏️</span></button>`
    : `<button type="button" class="slot ${cls}" ${attrs}><span class="slot-ic">📷</span><small>${esc(label)}</small></button>`;
}

/* ---------- photo picker modal ---------- */
let pickerOpts = null;
function openPicker(opts) {
  pickerOpts = opts;
  $('#pickerTitle').textContent = opts.title || 'Choose a photo';
  $('#pickerRemove').hidden = !opts.hasCurrent;
  $('#pickerGrid').innerHTML = photos.length
    ? photos.map((p, i) => `<button type="button" data-i="${i}"><img src="${urlsFor(p).thumb}" alt="" loading="lazy"></button>`).join('')
    : '<p class="muted small-text">No gallery photos yet. Upload one above 💗</p>';
  $('#picker').hidden = false;
  document.body.classList.add('noscroll');
}
function closePicker() {
  $('#picker').hidden = true;
  pickerOpts = null;
  if ($('#lightbox').hidden) document.body.classList.remove('noscroll');
}
async function withSaving(fn) {
  try { toast('Saving photo…', true); await fn(); toast('Saved 💖'); }
  catch { toast("Couldn't save that photo 😢"); }
}
$('#pickerGrid').addEventListener('click', async e => {
  const b = e.target.closest('button[data-i]');
  if (!b || !pickerOpts) return;
  const o = pickerOpts, src = photos[+b.dataset.i].blob;
  closePicker();
  await withSaving(() => o.onPick(src));
});
$('#pickerFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !pickerOpts) return;
  const o = pickerOpts;
  closePicker();
  await withSaving(() => o.onPick(f));
});
$('#pickerRemove').addEventListener('click', async () => {
  const o = pickerOpts;
  if (!o) return;
  closePicker();
  await withSaving(() => o.onRemove());
});
$('#pickerClose').addEventListener('click', closePicker);
$('#picker').addEventListener('click', e => { if (e.target.id === 'picker') closePicker(); });

/* =========================================================
   LOGIN
   Note: this is a front-end only lock. It keeps casual visitors out,
   but it is not bank-level security.
   ========================================================= */
async function sha(text) {
  if (window.crypto && crypto.subtle) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381;
  for (const ch of text) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return 'f' + h;
}
const hashPw = (pw, salt) => sha(`${salt}:${pw}:joel-lara`);
const sessionOK = () => sessionStorage.getItem('jl-ok') === '1' || localStorage.getItem('jl-ok') === '1';

function setupLogin() {
  const first = !LS.get('jl-auth');
  $('#pw2').hidden = !first;
  $('#pw2').required = first;
  $('#loginBtn').textContent = first ? 'Create password & enter 💕' : 'Enter 💕';
  $('#loginSub').textContent = first
    ? 'First time here! Choose who you are and make a password only the two of you know.'
    : 'Our little corner of the world';
  $('#pw').autocomplete = first ? 'new-password' : 'current-password';

  const lastWho = LS.get('jl-who');
  if (lastWho) { const r = $(`input[name=who][value="${lastWho}"]`); if (r) r.checked = true; }

  const msg = t => { $('#loginMsg').textContent = t; };
  const fail = t => {
    msg(t);
    const c = $('.login-card'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake');
  };

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    msg('');
    const who = ($('input[name=who]:checked') || {}).value;
    if (!who) return fail('Pick first: Joel or Lara 💕');
    const pw = $('#pw').value;
    let auth = LS.get('jl-auth');

    if (!auth) {                                   // first-time setup
      if (pw.length < 4) return fail('Password should be at least 4 characters');
      if (pw !== $('#pw2').value) return fail("Passwords don't match 🥺");
      const salt = uid();
      auth = { salt, hash: await hashPw(pw, salt) };
      LS.set('jl-auth', auth);
    } else if (await hashPw(pw, auth.salt) !== auth.hash) {
      return fail('Wrong password, try again 🥺');
    }

    LS.set('jl-who', who);
    sessionStorage.setItem('jl-ok', '1');
    if ($('#keep').checked) localStorage.setItem('jl-ok', '1'); else localStorage.removeItem('jl-ok');
    $('#pw').value = ''; $('#pw2').value = '';
    burst(innerWidth / 2, innerHeight / 2);
    enterApp();
  });
}

$('#logout').addEventListener('click', () => {
  sessionStorage.removeItem('jl-ok');
  localStorage.removeItem('jl-ok');
  location.hash = '';
  location.reload();
});

/* =========================================================
   NAVIGATION
   ========================================================= */
const PAGES = ['home', 'gallery', 'story', 'favorites', 'bucket'];
function showPage(name) {
  if (!PAGES.includes(name)) name = 'home';
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  window.scrollTo({ top: 0 });
}
$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-page]');
  if (b) { location.hash = b.dataset.page; showPage(b.dataset.page); }
});
window.addEventListener('hashchange', () => { if (!$('#app').hidden) showPage(location.hash.slice(1)); });
const goTo = name => { location.hash = name; showPage(name); };

/* =========================================================
   HOME
   ========================================================= */
const QUOTES = [
  'Sa dami ng tao sa mundo, ikaw pa rin ang pinipili ko. 💕',
  'Home is wherever you are. 🏡',
  "Our story isn't perfect, but it's ours, and that's what makes it my favorite. 💗",
  'Ikaw at ako, kahit anong mangyari. 🤍',
  'Thank you for being my favorite person. 🌷',
  'Every day with you is my favorite day. ✨',
  'Mas gaganda pa ang bukas, basta magkasama tayo. 🌅'
];

function diffYMD(from, to) {
  let y = to.getFullYear() - from.getFullYear();
  let m = to.getMonth() - from.getMonth();
  let d = to.getDate() - from.getDate();
  if (d < 0) { m--; d += new Date(to.getFullYear(), to.getMonth(), 0).getDate(); }
  if (m < 0) { y--; m += 12; }
  return { y, m, d };
}
function addClamped(from, months, years) {
  const total = from.getMonth() + months + years * 12;
  const y = from.getFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(from.getDate(), last));
}
function nextOcc(from, unit) {
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let n = 0, d;
  do { n++; d = addClamped(from, unit === 'month' ? n : 0, unit === 'year' ? n : 0); } while (d < t0 && n < 5000);
  return { date: d, n, t0 };
}

function renderHome() {
  $('#hello').textContent = `Hi, ${LS.get('jl-who', 'love')} 💕`;
  renderAvatars();
  const a = LS.get('jl-anniv');
  $('#annivInput').value = a || '';
  const box = $('#counter');
  const from = a ? new Date(a + 'T00:00') : null;
  const now = new Date();
  if (!from) {
    box.innerHTML = '<p class="muted">Set the day you two became a couple to start the counter 💞</p>';
  } else if (from > now) {
    box.innerHTML = '<p class="muted">That date is in the future 😅 pick the day you got together!</p>';
  } else {
    const d = diffYMD(from, now);
    const days = Math.floor((now - from) / 864e5);
    box.innerHTML = `<div class="count">
      <div><b>${d.y}</b><span>Years</span></div>
      <div><b>${d.m}</b><span>Months</span></div>
      <div><b>${d.d}</b><span>Days</span></div>
    </div><p class="total">💗 ${days.toLocaleString()} days together and counting</p>`;
  }
  renderCountdowns();
  const dayIdx = Math.floor(Date.now() / 864e5);
  $('#quote').textContent = QUOTES[dayIdx % QUOTES.length];
  renderMotd();
  renderNotes();
  renderBackupInfo();
  updateStats();
}

function renderCountdowns() {
  const a = LS.get('jl-anniv');
  const box = $('#countdowns');
  const from = a ? new Date(a + 'T00:00') : null;
  if (!from || from > new Date()) { box.innerHTML = ''; return; }
  const long = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const mk = (icon, title, o, sub) => {
    const days = Math.round((o.date - o.t0) / 864e5);
    const when = days === 0 ? 'Today! 🎉' : days === 1 ? 'Tomorrow!' : `in ${days} days`;
    return `<div class="card cd"><span class="cd-ic">${icon}</span><div><b>${when}</b><span>${title}</span><small>${sub}</small></div></div>`;
  };
  const m = nextOcc(from, 'month'), y = nextOcc(from, 'year');
  box.innerHTML = mk('🌙', 'Next monthsary', m, `Month ${m.n} · ${long(m.date)}`) + mk('🎂', 'Next anniversary', y, `Year ${y.n} · ${long(y.date)}`);
}

function renderMotd() {
  const box = $('#motd');
  if (!photos.length) { box.hidden = true; box.innerHTML = ''; return; }
  const p = photos[Math.floor(Date.now() / 864e5) % photos.length];
  box.hidden = false;
  box.innerHTML = `<h3>Memory of the day ✨</h3>
    <figure class="polaroid" data-go="gallery" style="--r:-1.5deg">
      <img src="${urlsFor(p).thumb}" alt="${esc(p.caption || 'Our photo')}">
      <figcaption>${esc(p.caption || '')}</figcaption></figure>
    <button class="btn ghost small" type="button" data-go="gallery">Open gallery</button>`;
}
$('#motd').addEventListener('click', e => { if (e.target.closest('[data-go]')) goTo('gallery'); });

function updateStats() {
  $('#statPhotos').textContent = photos.length;
  $('#statStories').textContent = stories.length;
  let n = 0;
  favs.rows.forEach(r => { if (norm(r.joel) || norm(r.lara) || r.joelImg || r.laraImg) n++; });
  favs.together.forEach(t => { if (norm(t.value) || t.img) n++; });
  $('#statFavs').textContent = n;
  $('#statBucket').textContent = `${bucket.filter(b => b.done).length}/${bucket.length}`;
}

$('#annivInput').addEventListener('change', e => {
  LS.set('jl-anniv', e.target.value || null);
  renderHome();
  toast('Saved 💞');
});

/* avatars */
function renderAvatars() {
  $$('.avatar').forEach(b => {
    const w = b.dataset.who, src = imgSrc(avatars[w]);
    b.innerHTML = src ? `<img src="${src}" alt="${w}">` : w[0];
  });
}
$$('.avatar').forEach(b => b.addEventListener('click', () => {
  const w = b.dataset.who;
  openPicker({
    title: `${w}'s photo`, hasCurrent: !!avatars[w],
    onPick: async src => {
      const id = await saveImage(src), old = avatars[w];
      avatars[w] = id; await dropImage(old); await kvSet('avatars', avatars); renderAvatars();
    },
    onRemove: async () => {
      const old = avatars[w]; delete avatars[w];
      await dropImage(old); await kvSet('avatars', avatars); renderAvatars();
    }
  });
}));

/* love notes */
const NOTE_COLORS = ['#fff3b0', '#ffd6e2', '#d6ecff', '#e4d9ff', '#d3f5e5'];
function renderNotes() {
  $('#notes').innerHTML = notes.length ? notes.map(n => {
    const h = parseInt(n.id.slice(-3), 36) || 0;
    return `<div class="note" style="--r:${(h % 7) - 3};background:${NOTE_COLORS[h % NOTE_COLORS.length]}">
      <button class="x" data-del="${n.id}" aria-label="Delete note">✕</button>
      <p>${esc(n.text)}</p><small>— ${esc(n.by)} · ${esc(fmtShort(n.ts))}</small></div>`;
  }).join('') : '<p class="muted small-text">No notes yet. Leave a little sweet message for each other 💕</p>';
}
$('#noteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#noteText').value.trim();
  if (!text) return;
  notes.unshift({ id: uid(), text, by: LS.get('jl-who', 'Someone'), ts: Date.now() });
  $('#noteText').value = '';
  renderNotes();
  burstAt($('#noteForm button'));
  try { await kvSet('notes', notes); } catch { toast("Couldn't save the note 😢"); }
});
$('#notes').addEventListener('click', async e => {
  const b = e.target.closest('button[data-del]');
  if (!b || !confirm('Delete this note?')) return;
  notes = notes.filter(n => n.id !== b.dataset.del);
  renderNotes();
  await kvSet('notes', notes);
});

/* theme */
function markTheme() {
  const t = document.documentElement.dataset.theme || 'rose';
  $$('#themes button').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
}
$('#themes').addEventListener('click', e => {
  const b = e.target.closest('button[data-theme]');
  if (!b) return;
  document.documentElement.dataset.theme = b.dataset.theme;
  LS.set('jl-theme', b.dataset.theme);
  markTheme();
});

/* change password */
$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const a = LS.get('jl-auth');
  const cur = $('#curPw').value, np = $('#newPw').value;
  if (await hashPw(cur, a.salt) !== a.hash) return toast('Current password is wrong');
  if (np.length < 4) return toast('At least 4 characters please');
  const salt = uid();
  LS.set('jl-auth', { salt, hash: await hashPw(np, salt) });
  e.target.reset();
  toast('Password changed 🔐');
});

/* backup / restore */
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

function renderBackupInfo() {
  const last = LS.get('jl-lastbackup');
  $('#lastBackup').textContent = last ? `Last backup: ${fmtTs(last)}` : 'No backup yet.';
  const hasContent = photos.length || stories.length || images.size;
  const ref = last || LS.get('jl-since') || Date.now();
  const limit = (last ? 30 : 7) * 864e5;
  $('#backupNudge').hidden = !(hasContent && Date.now() - ref > limit);
}

async function exportBackup() {
  try {
    toast('Preparing your backup…', true);
    const ph = [];
    for (const p of photos) ph.push({ id: p.id, name: p.name, caption: p.caption, added: p.added, taken: p.taken, love: !!p.love, data: await blobToDataURL(p.blob) });
    const im = [];
    for (const r of images.values()) im.push({ id: r.id, data: await blobToDataURL(r.blob) });
    const data = {
      app: 'joel-lara', v: 2, anniversary: LS.get('jl-anniv'), theme: LS.get('jl-theme'),
      favs, stories, photos: ph, images: im, avatars, notes, bucket
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `joel-and-lara-backup-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    LS.set('jl-lastbackup', Date.now());
    renderBackupInfo();
    toast('Backup downloaded 💾');
  } catch { toast('Backup failed 😢 (too many photos for one file?)'); }
}
$('#exportBtn').addEventListener('click', exportBackup);
$('#nudgeBtn').addEventListener('click', exportBackup);

$('#importInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    toast('Restoring…', true);
    const data = JSON.parse(await f.text());
    if (data.app !== 'joel-lara') throw new Error('bad file');
    for (const p of data.photos || []) {
      const blob = await (await fetch(p.data)).blob();
      await dbPut('photos', { id: p.id, blob, thumb: await makeThumb(blob), name: p.name, caption: p.caption || '', added: p.added, taken: p.taken, love: !!p.love });
    }
    for (const im of data.images || []) await dbPut('images', { id: im.id, blob: await (await fetch(im.data)).blob() });
    for (const s of data.stories || []) await dbPut('stories', s);
    if (data.favs) await kvSet('favs', data.favs);
    if (data.avatars) await kvSet('avatars', data.avatars);
    if (data.notes) await kvSet('notes', data.notes);
    if (data.bucket) await kvSet('bucket', data.bucket);
    if (data.anniversary) LS.set('jl-anniv', data.anniversary);
    if (data.theme) { LS.set('jl-theme', data.theme); document.documentElement.dataset.theme = data.theme; markTheme(); }
    await loadAll();
    renderAll();
    toast('Backup restored 💖');
  } catch { toast("That doesn't look like a Joel & Lara backup 🤔"); }
});

/* =========================================================
   GALLERY
   ========================================================= */
const gal = { q: '', sort: 'new', love: false };

async function loadPhotos() { photos = await dbAll('photos'); }
function urlsFor(p) {
  let u = urlCache.get(p.id);
  if (!u) {
    u = { thumb: URL.createObjectURL(p.thumb || p.blob), full: URL.createObjectURL(p.blob) };
    urlCache.set(p.id, u);
  }
  return u;
}

function computeView() {
  let v = photos.slice();
  if (gal.love) v = v.filter(p => p.love);
  if (gal.q) { const q = gal.q.toLowerCase(); v = v.filter(p => (p.caption || '').toLowerCase().includes(q)); }
  if (gal.sort === 'old') v.sort((a, b) => a.added - b.added);
  else if (gal.sort === 'taken') v.sort((a, b) => (b.taken || b.added) - (a.taken || a.added));
  else v.sort((a, b) => b.added - a.added);
  view = v;
}

function renderGallery() {
  computeView();
  const loved = photos.filter(p => p.love).length;
  $('#photoCount').textContent = photos.length + (photos.length === 1 ? ' memory' : ' memories') + (loved ? ` · ❤️ ${loved} loved` : '');
  const empty = $('#emptyGallery');
  empty.hidden = view.length > 0;
  empty.textContent = photos.length ? 'No photos match. Try another search or filter 🔍' : 'No photos yet. Upload your first memory together ✨';
  $('#grid').innerHTML = view.map((p, i) => {
    const u = urlsFor(p);
    const r = (((i * 37) % 5) - 2) * 0.6;
    return `<figure class="polaroid" data-i="${i}" style="--r:${r}deg">
      <img src="${u.thumb}" alt="${esc(p.caption || 'Our photo')}" loading="lazy">
      <button class="heart ${p.love ? 'on' : ''}" data-heart type="button" aria-label="Love this photo">♥</button>
      <figcaption>${esc(p.caption || '')}</figcaption></figure>`;
  }).join('');
}

async function addFiles(files) {
  const imgs = [...files].filter(f => f.type.startsWith('image/'));
  if (!imgs.length) return toast('Please choose pictures only 📷');
  let n = 0;
  try {
    for (const f of imgs) {
      toast(`Saving ${++n} of ${imgs.length}…`, true);
      const thumb = await makeThumb(f);
      await dbPut('photos', { id: uid(), blob: f, thumb, name: f.name, caption: '', added: Date.now() + n, taken: f.lastModified || null, love: false });
    }
    await loadPhotos(); renderGallery(); renderMotd(); updateStats(); renderBackupInfo();
    toast(`Added ${imgs.length} photo${imgs.length > 1 ? 's' : ''} 💖`);
  } catch {
    toast("Couldn't save. Is your device storage full? 😢");
  }
}

$('#fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
const dz = $('#dropzone');
dz.addEventListener('click', () => $('#fileInput').click());
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
$('#page-gallery').addEventListener('dragover', e => e.preventDefault());
$('#page-gallery').addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

/* filters */
let searchTimer;
$('#gSearch').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { gal.q = e.target.value.trim(); renderGallery(); }, 200); });
$('#gSort').addEventListener('change', e => { gal.sort = e.target.value; renderGallery(); });
$('#gChips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  gal.love = b.dataset.f === 'love';
  $$('#gChips .chip').forEach(c => c.classList.toggle('active', c === b));
  renderGallery();
});

async function toggleLove(p, btn) {
  p.love = !p.love;
  await dbPut('photos', p);
  if (btn) { btn.classList.toggle('on', p.love); if (p.love) burstAt(btn); }
}

/* lightbox */
let cur = -1, slideT = null;
function openLB(i) {
  cur = i;
  const p = view[i];
  $('#lbImg').src = urlsFor(p).full;
  $('#lbImg').alt = p.caption || 'Our photo';
  $('#lbCap').value = p.caption || '';
  $('#lbDate').textContent = p.taken ? '📅 ' + fmtTs(p.taken) : 'Added ' + fmtTs(p.added);
  $('#lbCount').textContent = `${i + 1} / ${view.length}`;
  $('#lbLove').classList.toggle('on', !!p.love);
  $('#lightbox').hidden = false;
  document.body.classList.add('noscroll');
  const multi = view.length > 1;
  $('#lbPrev').hidden = !multi; $('#lbNext').hidden = !multi; $('#lbPlay').hidden = !multi;
}
function stopSlide() {
  if (slideT) { clearInterval(slideT); slideT = null; }
  $('#lbPlay').textContent = '▶ Play';
}
function closeLB() {
  stopSlide();
  $('#lightbox').hidden = true;
  if ($('#picker').hidden) document.body.classList.remove('noscroll');
  cur = -1;
  renderGallery();
  renderMotd();
  updateStats();
}
async function saveCaption() {
  if (cur < 0 || !view[cur]) return;
  const p = view[cur];
  const v = $('#lbCap').value.trim();
  if (v === (p.caption || '')) return;
  p.caption = v;
  await dbPut('photos', p);
}
async function stepLB(d) {
  await saveCaption();
  if (!view.length) return;
  openLB((cur + d + view.length) % view.length);
}
$('#grid').addEventListener('click', async e => {
  const f = e.target.closest('.polaroid');
  if (!f) return;
  const p = view[+f.dataset.i];
  const h = e.target.closest('[data-heart]');
  if (h) {
    await toggleLove(p, h);
    if (gal.love) renderGallery();
    else $('#photoCount').textContent = photos.length + (photos.length === 1 ? ' memory' : ' memories') + (photos.some(x => x.love) ? ` · ❤️ ${photos.filter(x => x.love).length} loved` : '');
    return;
  }
  openLB(+f.dataset.i);
});
$('#lbCap').addEventListener('change', saveCaption);
$('#lbLove').addEventListener('click', async e => { const p = view[cur]; if (p) await toggleLove(p, e.currentTarget); });
$('#lbClose').addEventListener('click', async () => { await saveCaption(); closeLB(); });
$('#lbPrev').addEventListener('click', () => stepLB(-1));
$('#lbNext').addEventListener('click', () => stepLB(1));
$('#lbPlay').addEventListener('click', () => {
  if (slideT) return stopSlide();
  slideT = setInterval(() => stepLB(1), 3500);
  $('#lbPlay').textContent = '⏸ Pause';
});
$('#lbDown').addEventListener('click', () => {
  const p = view[cur];
  const a = document.createElement('a');
  a.href = urlsFor(p).full; a.download = p.name || 'photo.jpg';
  document.body.appendChild(a); a.click(); a.remove();
});
$('#lbDel').addEventListener('click', async () => {
  if (!confirm('Delete this photo? This cannot be undone.')) return;
  stopSlide();
  const p = view[cur];
  await dbDel('photos', p.id);
  const u = urlCache.get(p.id);
  if (u) { URL.revokeObjectURL(u.thumb); URL.revokeObjectURL(u.full); urlCache.delete(p.id); }
  photos = photos.filter(x => x.id !== p.id);
  view.splice(cur, 1);
  updateStats();
  if (!view.length) return closeLB();
  openLB(Math.min(cur, view.length - 1));
  toast('Photo deleted');
});
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('#lbClose').click(); });
let swipeX = null;
$('#lbImg').addEventListener('touchstart', e => { swipeX = e.touches[0].clientX; }, { passive: true });
$('#lbImg').addEventListener('touchend', e => {
  if (swipeX === null) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) > 50 && view.length > 1) stepLB(dx < 0 ? 1 : -1);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#picker').hidden) return closePicker();
  if ($('#lightbox').hidden) return;
  if (e.target.id === 'lbCap' && e.key !== 'Escape') return;
  if (e.key === 'Escape') $('#lbClose').click();
  if (e.key === 'ArrowLeft' && view.length > 1) stepLB(-1);
  if (e.key === 'ArrowRight' && view.length > 1) stepLB(1);
});

/* =========================================================
   OUR STORY
   ========================================================= */
let storyImgId = '', storyImgOrig = '';

async function loadStories() {
  stories = (await dbAll('stories')).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.updated - a.updated);
}

function renderStories() {
  $('#storyEmpty').hidden = stories.length > 0;
  $('#storyList').innerHTML = stories.map(s => {
    const src = imgSrc(s.img);
    return `<article class="story-card" data-id="${s.id}">
      ${src ? `<img class="story-photo" src="${src}" alt="">` : ''}
      <div class="story-meta"><span>📅 ${esc(fmtDate(s.date))}</span>${s.mood ? `<span class="mood">${esc(s.mood)}</span>` : ''}${s.author ? `<span>✍️ ${esc(s.author)}</span>` : ''}</div>
      ${s.title ? `<h3>${esc(s.title)}</h3>` : ''}
      <p>${esc(s.text)}</p>
      <div class="actions">
        <button class="btn ghost small" data-act="edit" type="button">✏️ Edit</button>
        <button class="btn danger small" data-act="del" type="button">🗑 Delete</button>
      </div></article>`;
  }).join('');
}

function renderStorySlot() {
  $('#storySlot').innerHTML = slot(storyImgId, 'data-story="1"', 'Add a photo to this chapter', 'wide');
}
function setMood(m) {
  $('#storyMood').value = m || '';
  $$('#moods button').forEach(b => b.classList.toggle('active', b.dataset.m === m));
}
$('#moods').addEventListener('click', e => {
  const b = e.target.closest('button[data-m]');
  if (b) setMood($('#storyMood').value === b.dataset.m ? '' : b.dataset.m);
});

async function resetStoryForm(discardPending = false) {
  if (discardPending && storyImgId && storyImgId !== storyImgOrig) await dropImage(storyImgId);
  storyImgId = ''; storyImgOrig = '';
  $('#storyForm').reset();
  $('#storyId').value = '';
  $('#storyDate').value = today();
  setMood('');
  renderStorySlot();
  $('#storyFormTitle').textContent = 'Write a new chapter';
  $('#storySave').textContent = 'Save to our story 💌';
  $('#storyCancel').hidden = true;
  $('#draftNote').hidden = true;
}

$('#storySlot').addEventListener('click', e => {
  if (!e.target.closest('.slot')) return;
  openPicker({
    title: 'Photo for this chapter', hasCurrent: !!storyImgId,
    onPick: async src => {
      const id = await saveImage(src);
      if (storyImgId && storyImgId !== storyImgOrig) await dropImage(storyImgId);
      storyImgId = id; renderStorySlot();
    },
    onRemove: async () => {
      if (storyImgId && storyImgId !== storyImgOrig) await dropImage(storyImgId);
      storyImgId = ''; renderStorySlot();
    }
  });
});

$('#storyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#storyText').value.trim();
  if (!text) return toast('Write something first 💭');
  const id = $('#storyId').value || uid();
  const old = stories.find(s => s.id === id);
  const rec = {
    id, title: $('#storyTitle').value.trim(), date: $('#storyDate').value || today(), text,
    mood: $('#storyMood').value, img: storyImgId,
    author: old ? old.author : LS.get('jl-who'), updated: Date.now()
  };
  await dbPut('stories', rec);
  if (storyImgOrig && storyImgOrig !== storyImgId) await dropImage(storyImgOrig);
  await loadStories();
  await resetStoryForm(false);
  renderStories(); updateStats(); renderBackupInfo();
  try { localStorage.removeItem('jl-draft'); } catch { /* ignore */ }
  toast('Saved to our story 💌');
  burstAt($('#storySave'));
});

$('#storyCancel').addEventListener('click', () => resetStoryForm(true));

$('#storyList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.story-card').dataset.id;
  const s = stories.find(x => x.id === id);
  if (btn.dataset.act === 'edit') {
    await resetStoryForm(true);
    $('#storyId').value = s.id;
    $('#storyTitle').value = s.title || '';
    $('#storyDate').value = s.date || today();
    $('#storyText').value = s.text;
    setMood(s.mood || '');
    storyImgId = s.img || ''; storyImgOrig = s.img || '';
    renderStorySlot();
    $('#storyFormTitle').textContent = 'Edit this chapter';
    $('#storySave').textContent = 'Save changes 💌';
    $('#storyCancel').hidden = false;
    $('#storyForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (confirm('Delete this story entry?')) {
    await dbDel('stories', id);
    await dropImage(s.img);
    await loadStories(); renderStories(); updateStats();
    toast('Deleted');
  }
});

/* autosave a text draft so nothing is lost */
$('#storyForm').addEventListener('input', () => {
  if ($('#storyId').value) return;
  LS.set('jl-draft', { t: $('#storyTitle').value, d: $('#storyDate').value, x: $('#storyText').value });
});
async function restoreDraft() {
  await resetStoryForm(false);
  const d = LS.get('jl-draft');
  if (d && (d.t || d.x)) {
    $('#storyTitle').value = d.t || '';
    if (d.d) $('#storyDate').value = d.d;
    $('#storyText').value = d.x || '';
    $('#draftNote').hidden = false;
  }
}

/* =========================================================
   FAVORITES
   ========================================================= */
function defaultFavs() {
  const row = (id, emoji, label, color = false) => ({ id, emoji, label, color, joel: '', lara: '', joelColor: '#a0c4ff', laraColor: '#ffb3c8', joelImg: '', laraImg: '' });
  return {
    rows: [
      row('color', '🎨', 'Favorite color', true),
      row('food', '🍜', 'Favorite food'),
      row('drink', '🧋', 'Favorite drink'),
      row('snack', '🍫', 'Favorite snack'),
      row('movie', '🎬', 'Favorite movie / series'),
      row('song', '🎵', 'Favorite song'),
      row('place', '📍', 'Favorite place'),
      row('animal', '🐶', 'Favorite animal'),
      row('flower', '🌷', 'Favorite flower'),
      row('season', '🌦️', 'Favorite season / weather'),
      row('hobby', '🎮', 'Favorite hobby'),
      row('nickname', '💌', 'Nickname for each other')
    ],
    together: [
      { emoji: '🎶', label: 'Our song', value: '', img: '' },
      { emoji: '🌹', label: 'Our first date', value: '', img: '' },
      { emoji: '🍽️', label: 'Our favorite place to eat together', value: '', img: '' },
      { emoji: '💞', label: 'Our favorite thing to do together', value: '', img: '' },
      { emoji: '✈️', label: 'Dream trip together', value: '', img: '' },
      { emoji: '🏡', label: 'Our someday dream', value: '', img: '' }
    ]
  };
}

async function loadFavs() {
  const saved = await kvGet('favs', null);
  favs = saved && saved.rows && saved.together ? saved : defaultFavs();
}

function renderFavs() {
  const person = (r, i, k, name) => {
    const c = r[k + 'Color'] || '#cccccc';
    const top = r.color
      ? `<label class="swatch" style="background:${esc(c)}"><input type="color" data-sec="rows" data-i="${i}" data-k="${k}Color" value="${esc(c)}" aria-label="${name} color"><small>Tap to pick</small></label>`
      : slot(r[k + 'Img'], `data-sec="rows" data-i="${i}" data-k="${k}Img"`);
    return `<div class="fav-person ${k}"><span class="tag">${name}</span>${top}
      <input class="in" type="text" data-sec="rows" data-i="${i}" data-k="${k}" value="${esc(r[k])}" placeholder="${r.color ? 'e.g. baby blue' : 'Write here…'}" maxlength="120"></div>`;
  };

  $('#favGrid').innerHTML = favs.rows.map((r, i) => `
    <div class="fav-card" data-row="${i}">
      <div class="fav-head"><span class="emo">${esc(r.emoji)}</span><h3>${esc(r.label)}</h3>
        <span class="match" hidden>💞 Same!</span>
        ${r.custom ? `<button class="x" data-del="${i}" type="button" title="Remove" aria-label="Remove">✕</button>` : ''}</div>
      <div class="fav-pair">${person(r, i, 'joel', 'Joel')}${person(r, i, 'lara', 'Lara')}</div>
    </div>`).join('');

  $('#togetherGrid').innerHTML = favs.together.map((t, i) => `
    <div class="fav-card wide">
      <div class="fav-head"><span class="emo">${esc(t.emoji)}</span><h3>${esc(t.label)}</h3></div>
      ${slot(t.img, `data-sec="together" data-i="${i}" data-k="img"`, 'Add a photo of us', 'wide')}
      <input class="in" type="text" data-sec="together" data-i="${i}" data-k="value" value="${esc(t.value)}" placeholder="Write it here…" maxlength="200">
    </div>`).join('');

  updateMatches();
}

function updateMatches() {
  let n = 0;
  $$('.fav-card[data-row]').forEach(c => {
    const r = favs.rows[+c.dataset.row];
    const m = !!norm(r.joel) && norm(r.joel) === norm(r.lara);
    if (m) n++;
    c.querySelector('.match').hidden = !m;
  });
  const b = $('#matchBanner');
  b.hidden = n === 0;
  b.textContent = `💞 You two match on ${n} favorite${n > 1 ? 's' : ''}!`;
}

let favTimer;
function queueSaveFavs() {
  const s = $('#saveState');
  s.textContent = 'Saving…'; s.classList.remove('ok');
  clearTimeout(favTimer);
  favTimer = setTimeout(async () => {
    try { await kvSet('favs', favs); s.textContent = 'All saved ✓'; s.classList.add('ok'); updateStats(); }
    catch { s.textContent = "Couldn't save 😢"; }
  }, 450);
}

$('#page-favorites').addEventListener('input', e => {
  const t = e.target;
  if (!t.dataset.sec || t.type === 'file') return;
  const i = +t.dataset.i;
  if (t.dataset.sec === 'rows') favs.rows[i][t.dataset.k] = t.value;
  else favs.together[i][t.dataset.k] = t.value;
  if (t.type === 'color') { const sw = t.closest('.swatch'); if (sw) sw.style.background = t.value; }
  if (t.dataset.sec === 'rows') updateMatches();
  queueSaveFavs();
});

$('#page-favorites').addEventListener('click', e => {
  const s = e.target.closest('.slot');
  if (s && s.dataset.sec) {
    const obj = s.dataset.sec === 'rows' ? favs.rows[+s.dataset.i] : favs.together[+s.dataset.i];
    const key = s.dataset.k;
    openPicker({
      title: `Photo for “${obj.label}”`, hasCurrent: !!obj[key],
      onPick: async src => {
        const id = await saveImage(src), old = obj[key];
        obj[key] = id; await dropImage(old); renderFavs(); queueSaveFavs();
      },
      onRemove: async () => {
        const old = obj[key]; obj[key] = '';
        await dropImage(old); renderFavs(); queueSaveFavs();
      }
    });
    return;
  }
  const b = e.target.closest('button[data-del]');
  if (b && b.closest('#favGrid')) {
    const i = +b.dataset.del, r = favs.rows[i];
    if (!confirm(`Remove "${r.label}"?`)) return;
    dropImage(r.joelImg); dropImage(r.laraImg);
    favs.rows.splice(i, 1);
    renderFavs(); queueSaveFavs();
  }
});

$('#addFavForm').addEventListener('submit', e => {
  e.preventDefault();
  const label = $('#favLabel').value.trim();
  if (!label) return;
  favs.rows.push({
    id: uid(), emoji: $('#favEmoji').value.trim() || '💗', label, custom: true, color: false,
    joel: '', lara: '', joelColor: '#a0c4ff', laraColor: '#ffb3c8', joelImg: '', laraImg: ''
  });
  $('#favLabel').value = '';
  renderFavs(); queueSaveFavs();
  toast('Added ✨');
});

/* =========================================================
   BUCKET LIST
   ========================================================= */
const BK_IDEAS = ['✈️ Travel abroad together', '🌅 Watch a sunrise', '🍳 Cook dinner together', '⛺ Go camping', '🎡 Ride a ferris wheel', '📸 Take couple photos', '🏖️ Beach day', '🎬 Movie marathon night'];

function renderBucket() {
  const done = bucket.filter(b => b.done).length, total = bucket.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  $('#bkText').textContent = `${done} of ${total} done`;
  $('#bkPct').textContent = pct + '%';
  $('#bkBar').style.setProperty('--p', pct + '%');
  $('#bkEmpty').hidden = total > 0;
  const sorted = [...bucket].sort((a, b) => (a.done - b.done) || (b.ts - a.ts));
  $('#bkList').innerHTML = sorted.map(b => `
    <li class="bk ${b.done ? 'done' : ''}" data-id="${b.id}">
      <button class="ck" type="button" data-act="toggle" aria-label="${b.done ? 'Mark as not done' : 'Mark as done'}">${b.done ? '✓' : ''}</button>
      <span class="bk-text">${esc(b.text)}</span>
      ${b.done && b.doneOn ? `<small>✅ ${esc(fmtShort(b.doneOn))}</small>` : ''}
      <button class="x" type="button" data-act="del" aria-label="Delete">✕</button>
    </li>`).join('');
  const have = new Set(bucket.map(b => norm(b.text)));
  $('#bkIdeas').innerHTML = BK_IDEAS.filter(t => !have.has(norm(t))).map(t => `<button type="button" class="chip" data-idea="${esc(t)}">＋ ${esc(t)}</button>`).join('');
  updateStats();
}
async function saveBucket() { try { await kvSet('bucket', bucket); } catch { toast("Couldn't save 😢"); } }

$('#bkForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#bkInput').value.trim();
  if (!text) return;
  bucket.push({ id: uid(), text, done: false, ts: Date.now() });
  $('#bkInput').value = '';
  renderBucket(); await saveBucket();
});
$('#bkIdeas').addEventListener('click', async e => {
  const b = e.target.closest('[data-idea]');
  if (!b) return;
  bucket.push({ id: uid(), text: b.dataset.idea, done: false, ts: Date.now() });
  renderBucket(); await saveBucket();
});
$('#bkList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.bk').dataset.id;
  const item = bucket.find(b => b.id === id);
  if (btn.dataset.act === 'toggle') {
    item.done = !item.done;
    item.doneOn = item.done ? Date.now() : null;
    if (item.done) burstAt(btn);
    renderBucket(); await saveBucket();
    if (item.done) toast('Yay! One more dream done 🎉');
  } else if (confirm('Remove this from the list?')) {
    bucket = bucket.filter(b => b.id !== id);
    renderBucket(); await saveBucket();
  }
});

/* =========================================================
   START
   ========================================================= */
async function loadAll() {
  await Promise.all([loadPhotos(), loadStories(), loadFavs()]);
  images.forEach(r => { if (r.url) URL.revokeObjectURL(r.url); });
  images.clear();
  (await dbAll('images')).forEach(r => images.set(r.id, r));
  [avatars, notes, bucket] = await Promise.all([kvGet('avatars', {}), kvGet('notes', []), kvGet('bucket', [])]);
}
function renderAll() {
  renderHome(); renderGallery(); renderStories(); renderFavs(); renderBucket(); renderStorySlot(); markTheme();
}

async function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (!LS.get('jl-since')) LS.set('jl-since', Date.now());
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
  try { await loadAll(); }
  catch { toast("Couldn't open storage. Try a normal (non-private) browser window 🙏"); }
  renderAll();
  await restoreDraft();
  showPage(location.hash.slice(1));
}

(function init() {
  floatHearts();
  setupLogin();
  markTheme();
  if (sessionOK() && LS.get('jl-auth')) enterApp();
})();
