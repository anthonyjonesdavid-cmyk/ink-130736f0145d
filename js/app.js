import * as store from './store.js';
import { Editor } from './editor.js';
import { icon } from './icons.js';
import { openPdf, pageSizes } from './pdf.js';
import { $, $$, esc, h, toast, modal, promptText, confirmDialog, popover, closePopover } from './ui.js';
import { createPinPad } from './pin.js';
import * as throttle from './throttle.js';
import { initDrive, startDriveImport, preload as preloadDrive, importRemote as driveImportRemote, _test as driveTest } from './drive.js';
import {
  renderPageInto, PAPER_STYLES, PAPER_COLORS, PEN_COLORS, PEN_SIZES, HL_COLORS, HL_SIZES, ERASER_SIZES, drawPaper, isDark, hexToRgb, loadGrain, presetFor,
} from './render.js';

/* ---------------- settings ---------------- */
const DEFAULTS = {
  fingerDraw: false, pinchZoom: false, tool: 'pen',
  pen: { color: '#1c1c1e', size: 2.6 }, hl: { color: '#ffe24a', size: 16 }, eraser: { size: 24 },
  paper: { style: 'ruled', color: '#ffffff' },
  penTheme: { light: '#1c1c1e', dark: '#ffffff' },
};
const SETTINGS_KEY = 'inkwell.settings';
const PEN_SIZE_MIGRATION_KEY = 'inkwell.pen-size-default-v2';
function mergeSettings(s = {}) {
  return { ...DEFAULTS, ...s, pen: { ...DEFAULTS.pen, ...s.pen }, hl: { ...DEFAULTS.hl, ...s.hl }, eraser: { ...DEFAULTS.eraser, ...s.eraser }, paper: { ...DEFAULTS.paper, ...s.paper }, penTheme: { ...DEFAULTS.penTheme, ...s.penTheme } };
}
const settings = (() => {
  let saved = null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch {}
  const merged = mergeSettings(saved || {});
  // Existing installs get the new default once; later pen-size choices remain theirs.
  try {
    if (!localStorage.getItem(PEN_SIZE_MIGRATION_KEY)) {
      if (saved) {
        merged.pen.size = PEN_SIZES[2];
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
      }
      localStorage.setItem(PEN_SIZE_MIGRATION_KEY, '1');
    }
  } catch {}
  return merged;
})();
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

/* ---------------- state ---------------- */
let section = null; // null = "Notes" (root) or a folder id
let folders = [];
let selecting = false, shownIds = [], baseSub = ''; // select mode (batch move / delete)
const selected = new Set();
let current = null; // open document
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/* ---------------- static icons ---------------- */
for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));

/* ---------------- editor ---------------- */
const editor = new Editor({
  scroll: $('#docScroll'), wrap: $('#pagesWrap'), settings,
  onChange: () => { scheduleSave(); scheduleThumbRefresh(); applyPaperTheme(); },
  onPageChange: (i, n) => {
    $('#pageIndicator').textContent = `${i + 1} / ${n}`;
    $$('.thumb-item').forEach((t, k) => t.classList.toggle('current', k === i));
  },
  onZoomChange: (z) => { const b = $('#zoomBtn'); b.textContent = Math.round(z * 100) + '%'; if (!b.classList.contains('snap')) b.classList.toggle('hidden', Math.abs(z - 1) < 0.01); },
  // light cue when the zoom snaps/resets to 100%: the badge briefly shows "100%", then fades away
  onZoomSnap: () => {
    const b = $('#zoomBtn');
    b.textContent = '100%'; b.classList.remove('hidden', 'snap'); void b.offsetWidth; b.classList.add('snap');
    clearTimeout(b._snapT);
    b._snapT = setTimeout(() => { b.classList.remove('snap'); if (Math.abs(editor.zoom - 1) < 0.01) b.classList.add('hidden'); }, 900);
  },
  onHistoryChange: (u, r) => { $('#undoBtn').disabled = !u; $('#redoBtn').disabled = !r; },
});
window.__inkwell = { editor, store, settings, drive: { importRemote: (...a) => driveImportRemote(...a), test: driveTest } }; // handy for debugging / tests

/* ---------------- saving ---------------- */
let saveTimer = null, saveChain = Promise.resolve(), dirty = false, thumbStale = false;
function scheduleSave() {
  dirty = true; thumbStale = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || !current) return saveChain;
  dirty = false;
  const d = current;
  d.meta.updatedAt = Date.now();
  d.meta.pageCount = d.body.pages.length;
  saveChain = saveChain.then(() => store.saveDoc({ id: d.id, folderId: d.folderId, meta: d.meta, body: d.body }))
    .catch((e) => { console.error(e); toast('Could not save: ' + e.message); });
  return saveChain;
}

async function makeThumb(meta, body, pdfDoc) {
  const p = body.pages[0];
  if (!p) return null;
  const c = document.createElement('canvas');
  await renderPageInto(c, p, meta.paper, pdfDoc, 300 / p.w);
  const url = c.toDataURL('image/jpeg', 0.8);
  c.width = c.height = 0;
  return url;
}

/* ---------------- library ---------------- */
async function renderLibrary() {
  folders = await store.listFolders();
  if (section && !folders.some((f) => f.id === section)) section = null;
  const counts = await store.countDocs();
  const nav = $('#folderNav');
  const item = (id, name, ic, count, extra = '') => `<button class="nav-item ${section === id ? 'active' : ''}" data-section="${id || ''}">${icon(ic)}<span class="nav-name">${esc(name)}</span>${extra}<span class="nav-count">${count || ''}</span></button>`;
  nav.innerHTML = item(null, 'Notes', 'notes', counts.root)
    + `<div class="nav-label">Folders</div>`
    + (folders.length ? folders.map((f) => item(f.id, f.name, f.locked ? (store.isUnlocked(f.id) ? 'unlock' : 'lock') : 'folder', counts[f.id], f.locked ? '<span class="enc-dot" title="Encrypted"></span>' : '')).join('') : `<div class="nav-empty">No folders yet</div>`);

  const f = folders.find((x) => x.id === section);
  $('#sectionTitle').textContent = f ? f.name : 'Notes';
  $('#sectionIcon').innerHTML = icon(f ? (f.locked ? (store.isUnlocked(f.id) ? 'unlock' : 'lock') : 'folder') : 'notes');
  $('#folderMenuBtn').hidden = !f;
  const body = $('#libBody');
  const lockedClosed = f && f.locked && !store.isUnlocked(f.id);
  $('#newNoteBtn').disabled = $('#importPdfBtn').disabled = $('#selectBtn').disabled = !!lockedClosed;
  if (lockedClosed) { if (selecting) setSelecting(false); $('#sectionSub').textContent = 'Encrypted folder'; renderLockScreen(f); return; }

  let docs;
  try { docs = await store.listDocs(section); }
  catch (e) { if (e.locked) { renderLockScreen(f); return; } throw e; }
  baseSub = `${docs.length} ${docs.length === 1 ? 'note' : 'notes'}${f && f.locked ? ' · encrypted' : ''}`;
  $('#sectionSub').textContent = baseSub;
  body.innerHTML = '';
  const grid = h('<div class="grid"></div>');
  grid.appendChild(h(`<button class="card new-card" id="newCard"><div class="thumb">${icon('plus')}</div><div class="card-info"><div class="card-title">New Note</div><div class="card-meta">Blank notebook</div></div></button>`));
  for (const d of docs) {
    const card = h(`<div class="card" data-id="${d.id}">
      <button class="card-open" aria-label="Open ${esc(d.title)}"><div class="thumb ${d.thumb ? '' : 'empty'}">${d.thumb ? `<img src="${d.thumb}" alt="">` : icon(d.kind === 'pdf' ? 'pdf' : 'notes')}${d.kind === 'pdf' ? '<span class="badge">PDF</span>' : ''}</div></button>
      <div class="card-info"><div class="card-title">${esc(d.title)}</div><div class="card-meta">${fmtDate(d.updatedAt)} · ${d.pageCount || 1} ${d.pageCount === 1 ? 'page' : 'pages'}</div></div>
      <button class="card-more icon-btn sm" aria-label="More">${icon('more')}</button>
      <span class="sel-mark" aria-hidden="true">${icon('check')}</span>
    </div>`);
    if (selected.has(d.id)) card.classList.add('sel');
    grid.appendChild(card);
  }
  body.appendChild(grid);
  shownIds = docs.map((d) => d.id);
  for (const id of [...selected]) if (!shownIds.includes(id)) selected.delete(id);
  syncSelect();
  if (!docs.length) body.appendChild(h(`<div class="empty-hint">${icon('pen')}<p>${f ? 'This folder is empty.' : 'No notes yet.'} Create a notebook or import a PDF to start writing with Apple Pencil.</p></div>`));
}

function renderLockScreen(f) {
  const body = $('#libBody');
  body.innerHTML = `<div class="lockscreen">
    <div class="lock-ic">${icon('lock')}</div>
    <h2>“${esc(f.name)}” is locked</h2>
    <p>The notes in this folder are encrypted on this device.</p>
    ${f.encrypting ? `<p class="enc-pending warn">${icon('shield')}<span><b>Encryption didn’t finish.</b> Unlock to finish encrypting the remaining notes. Until then, some notes in this folder are still stored unencrypted.</span></p>` : ''}
    <div class="unlock-slot"></div>
    <p class="fine">${icon('shield')} AES-256 encryption · There is no passcode reset. If you forget it, these notes can't be recovered.</p>
  </div>`;
  $('.unlock-slot', body).appendChild(buildUnlock(f, async () => { await resumeEncryptionIfNeeded(f.id); renderLibrary(); }));
}

// Passcode / password entry with escalating lockout. Used by the lock screen and the "Move to" dialog.
function buildUnlock(f, onUnlocked, { compact = false } = {}) {
  let mode = f.secretKind === 'pin' ? 'pin' : 'password';
  const wrap = h(`<div class="unlock"><div class="unlock-body"></div><p class="unlock-msg"></p><button type="button" class="linkbtn unlock-toggle"></button></div>`);
  const body = $('.unlock-body', wrap), msgEl = $('.unlock-msg', wrap), toggleBtn = $('.unlock-toggle', wrap);
  let pad = null, timer = null, busy = false;
  const msg = (t, cls = 'err') => { msgEl.textContent = t; msgEl.className = 'unlock-msg ' + cls; };
  const setLocked = (v) => {
    pad?.setDisabled(v);
    for (const el of $$('.unlock-field, .unlock-btn', wrap)) el.disabled = v;
  };
  const applyThrottle = () => {
    clearInterval(timer);
    const tick = () => {
      if (!wrap.isConnected && timer) { clearInterval(timer); return; }
      const ms = throttle.remainingMs(f.id);
      if (!ms) { clearInterval(timer); setLocked(false); msg(''); return; }
      setLocked(true);
      msg(`Too many wrong attempts. Try again in ${throttle.fmtWait(ms)}.`, 'warn');
    };
    tick();
    timer = setInterval(tick, 500);
  };
  async function attempt(secret) {
    if (busy || !secret) return;
    if (throttle.remainingMs(f.id)) { applyThrottle(); return; }
    busy = true; setLocked(true); msg('Unlocking…', 'info');
    try {
      await store.unlockFolder(f.id, secret);
      throttle.recordSuccess(f.id);
      clearInterval(timer);
      msg('');
      onUnlocked();
    } catch (e) {
      setLocked(false);
      if (e.message !== 'Wrong password') { msg(e.message); return; }
      const s = throttle.recordFailure(f.id);
      pad?.shake(); pad?.clear();
      const fld = $('.unlock-field', wrap); if (fld) { fld.select(); fld.classList.add('shake'); setTimeout(() => fld.classList.remove('shake'), 400); }
      if (s.until) applyThrottle();
      else {
        const left = throttle.triesLeft(f.id), word = mode === 'pin' ? 'passcode' : 'password';
        msg(`Wrong ${word}.` + (left <= 3 ? ` ${left} ${left === 1 ? 'try' : 'tries'} left before a 30-second wait.` : ' Try again.'));
      }
    } finally { busy = false; }
  }
  function render() {
    body.innerHTML = '';
    pad = null;
    if (mode === 'pin') {
      pad = createPinPad({ label: 'Enter passcode', onComplete: attempt, compact });
      body.appendChild(pad.el);
      toggleBtn.textContent = 'Use a password instead';
    } else {
      const form = h(`<form class="unlock-form" autocomplete="off">
        <input class="field unlock-field" type="password" placeholder="Folder password" autocomplete="current-password" enterkeyhint="go">
        <button class="btn primary unlock-btn" type="submit">Unlock</button></form>`);
      form.addEventListener('submit', (e) => { e.preventDefault(); attempt($('.unlock-field', form).value); });
      body.appendChild(form);
      toggleBtn.textContent = 'Use a 4-digit passcode instead';
      setTimeout(() => { if (!throttle.remainingMs(f.id)) $('.unlock-field', form)?.focus(); }, 60);
    }
    if (throttle.remainingMs(f.id)) applyThrottle();
  }
  toggleBtn.addEventListener('click', () => { mode = mode === 'pin' ? 'password' : 'pin'; render(); if (!throttle.remainingMs(f.id)) msg(''); });
  render();
  return wrap;
}

function goSection(id) {
  closePopover();
  if (selecting) setSelecting(false);
  if (section && section !== id && store.isUnlocked(section)) store.lockFolder(section); // leaving relocks
  section = id || null;
  renderLibrary();
}

$('#navBtn').addEventListener('click', (e) => {
  popover(e.currentTarget, [
    { label: 'Notes', icon: 'notes', checked: section === null, onClick: () => goSection(null) },
    ...folders.map((f) => ({ label: f.name, icon: f.locked ? 'lock' : 'folder', checked: section === f.id, onClick: () => goSection(f.id) })),
    '-',
    { label: 'New Folder', icon: 'folderPlus', onClick: () => newFolder() },
  ], { align: 'start' });
});

$('#folderNav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (b) goSection(b.dataset.section || null);
});

$('#libBody').addEventListener('click', (e) => {
  if (e.target.closest('#newCard')) return selecting ? null : newNote();
  const card = e.target.closest('.card[data-id]');
  if (!card) return;
  const id = card.dataset.id;
  if (selecting) { toggleSelect(id, card); return; }
  if (e.target.closest('.card-more')) return docMenu(e.target.closest('.card-more'), id);
  openDoc(id);
});

function docMenu(anchor, id) {
  popover(anchor, [
    { label: 'Open', icon: 'notes', onClick: () => openDoc(id) },
    { label: 'Rename', icon: 'edit', onClick: () => renameDoc(id) },
    { label: 'Move to…', icon: 'move', onClick: () => moveDoc(id) },
    { label: 'Export as PDF', icon: 'download', onClick: () => exportPdfById(id) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteDoc(id) },
  ]);
}

async function renameDoc(id) {
  const d = await store.loadDoc(id);
  const t = await promptText('Rename note', d.meta.title);
  if (!t) return;
  d.meta.title = t;
  await store.saveMeta(id, d.folderId, d.meta);
  renderLibrary();
}

async function deleteDoc(id) {
  const d = await store.loadDoc(id);
  if (!(await confirmDialog('Delete note?', `“${d.meta.title}” will be permanently deleted from this device.`))) return;
  await store.deleteDoc(id);
  toast('Note deleted');
  renderLibrary();
}

async function moveDoc(id) {
  const d = await store.loadDoc(id);
  const dests = [{ id: null, name: 'Notes', locked: false }, ...folders].filter((f) => (f.id || null) !== (d.folderId || null));
  if (!dests.length) return toast('Create a folder first');
  const list = h(`<div class="dest-list">${dests.map((f) => `<button class="dest" data-id="${f.id || ''}">${icon(f.id ? (f.locked ? 'lock' : 'folder') : 'notes')}<span>${esc(f.name)}</span>${f.locked ? '<em>encrypted</em>' : ''}</button>`).join('')}</div>`);
  const target = await modal({
    title: `Move “${d.meta.title}”`, body: list, actions: [{ label: 'Cancel', value: undefined }],
    onOpen: (w, close) => list.addEventListener('click', (e) => { const b = e.target.closest('.dest'); if (b) close(b.dataset.id || null); }),
  });
  if (target === undefined) return;
  const f = folders.find((x) => x.id === target);
  let tempUnlock = false;
  if (f && f.locked && !store.isUnlocked(f.id)) {
    const ok = await askFolderPassword(f);
    if (!ok) return;
    tempUnlock = true;
  }
  try {
    await store.moveDoc(id, target);
    toast(f && f.locked ? `Moved and encrypted into “${f.name}”` : `Moved to “${f ? f.name : 'Notes'}”`);
  } catch (e) { toast(e.message); }
  if (tempUnlock) store.lockFolder(target);
  renderLibrary();
}

async function askFolderPassword(f) {
  return modal({
    title: `Unlock “${f.name}”`, body: '<div class="unlock-slot"></div>', actions: [{ label: 'Cancel', value: false }],
    onOpen: (w, close) => $('.unlock-slot', w).appendChild(buildUnlock(f, () => close(true), { compact: true })),
  }).then(async (ok) => { if (ok) await resumeEncryptionIfNeeded(f.id); return ok; });
}

/* ---------------- folders ---------------- */
$('#newFolderBtn').addEventListener('click', newFolder);
// Passcode setup (4-digit keypad, or a longer password) + the no-recovery warning. Used by New Folder and Lock Folder.
function secretSetup() {
  const el = h(`<div class="secret-setup">
      <div class="pw-left"><div id="fSecret"></div>
      <button type="button" class="linkbtn" id="fMode">Use a longer password instead</button></div>
      <div class="pw-right"><div class="warn">${icon('shield')}<div><b>There is no way to recover a forgotten passcode.</b> Everything in this folder is encrypted with it (AES-256, key derived with PBKDF2, 600,000 rounds). If you forget it, the notes are gone for good — backups stay encrypted with it too.</div></div>
      <label class="ack"><input type="checkbox" id="fAck"> I understand that a forgotten passcode means these notes cannot be recovered.</label></div>
  </div>`);
  // keep direct references: callers move these nodes into their own dialog markup
  const secretBox = $('#fSecret', el), modeBtn = $('#fMode', el), ackBox = $('#fAck', el);
  let mode = 'pin', pin1 = null, pinOK = null;
  const renderSecret = () => {
    const box = secretBox;
    box.innerHTML = '';
    modeBtn.textContent = mode === 'pin' ? 'Use a longer password instead' : 'Use a 4-digit passcode instead';
    if (mode === 'pin') {
      if (pinOK) {
        box.appendChild(h(`<div class="pin-set">${icon('check')}<span>Passcode set</span><button type="button" class="linkbtn" id="fRedo">Change</button></div>`));
        $('#fRedo', box).addEventListener('click', () => { pinOK = pin1 = null; renderSecret(); });
        return;
      }
      const pad = createPinPad({
        label: 'Choose a 4-digit passcode', compact: true,
        onComplete: (v) => {
          if (!pin1) { pin1 = v; pad.clear(); pad.setLabel('Enter it again to confirm'); }
          else if (v === pin1) { pinOK = v; const e = document.getElementById('fErr'); if (e) e.textContent = ''; renderSecret(); }
          else { pin1 = null; pad.shake(); pad.clear(); pad.setLabel('Didn’t match — choose a 4-digit passcode', 'bad'); }
        },
      });
      box.appendChild(pad.el);
    } else {
      box.appendChild(h(`<div class="pw-fields">
        <input class="field" id="fPw" type="password" placeholder="Password (at least 4 characters)" autocomplete="new-password">
        <input class="field" id="fPw2" type="password" placeholder="Confirm password" autocomplete="new-password"></div>`));
    }
  };
  modeBtn.addEventListener('click', () => { mode = mode === 'pin' ? 'password' : 'pin'; pin1 = pinOK = null; renderSecret(); });
  renderSecret();
  // returns {secret, mode} or calls err(msg) and returns null
  const read = (err) => {
    let secret;
    if (mode === 'pin') { if (!pinOK) return err('Choose and confirm a 4-digit passcode.'), null; secret = pinOK; }
    else {
      const p1 = $('#fPw', secretBox).value, p2 = $('#fPw2', secretBox).value;
      if (p1.length < 4) return err('Password must be at least 4 characters.'), null;
      if (p1 !== p2) return err('Passwords don’t match.'), null;
      secret = p1;
    }
    if (!ackBox.checked) return err('Please confirm you understand the passcode can’t be recovered.'), null;
    return { secret, mode };
  };
  return { el, read };
}

async function newFolder({ navigate = true } = {}) {
  const sec = secretSetup();
  const body = h(`<div class="form">
    <label class="lbl">Name</label>
    <input class="field" id="fName" type="text" placeholder="e.g. Biology, Journal" maxlength="60">
    <label class="switch-row"><span>${icon('lock')} Protect with passcode</span><input type="checkbox" id="fLock"><span class="switch"></span></label>
    <div id="fPwBox" class="pw-box" hidden></div>
    <p class="err" id="fErr"></p>
  </div>`);
  $('#fPwBox', body).append(...sec.el.children);
  $('#fLock', body).addEventListener('change', (e) => { $('#fPwBox', body).hidden = !e.target.checked; });
  const res = await modal({
    title: 'New Folder', body, cls: 'wide',
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Create', kind: 'primary',
      validate: async (w, b) => {
        const name = $('#fName', w).value.trim(), lock = $('#fLock', w).checked;
        const err = (m) => { $('#fErr', w).textContent = m; return false; };
        if (!name) return err('Give the folder a name.');
        let secret = null, mode = 'pin';
        if (lock) { const r = sec.read(err); if (!r) return false; ({ secret, mode } = r); }
        b.disabled = true; b.textContent = lock ? 'Encrypting…' : 'Creating…';
        try { w._folder = await store.createFolder(name, secret, mode); }
        catch (e) { b.disabled = false; b.textContent = 'Create'; return err(e.message); }
        return true;
      },
      value: (w) => w._folder,
    }],
    onOpen: (w) => setTimeout(() => $('#fName', w).focus(), 60),
  });
  if (res && navigate) { goSection(res.id); toast(res.locked ? 'Encrypted folder created' : 'Folder created'); }
  return res;
}

/* ---------------- progress sheet (moves, encryption) ---------------- */
function progressSheet(title) {
  const back = h(`<div class="modal-back drive-back"><div class="modal prog-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><div class="dl-head"><h2 class="ps-title">${esc(title)}</h2><div class="dl-sub ps-sub">Starting…</div></div></div>
    <div class="dl-all ps-bar"><i></i></div>
    <div class="modal-body ps-msg" hidden></div>
    <div class="modal-actions"><button class="btn primary ps-close" hidden>Done</button></div></div></div>`);
  $('#modalRoot').appendChild(back);
  requestAnimationFrame(() => back.classList.add('show'));
  const close = () => { back.classList.remove('show'); setTimeout(() => back.remove(), 180); };
  $('.ps-close', back).addEventListener('click', close);
  return {
    el: back, close,
    set(done, total, sub) { $('.ps-bar i', back).style.width = (total ? (done / total) * 100 : 100).toFixed(1) + '%'; $('.ps-sub', back).textContent = sub; },
    finish(titleText, sub, msg, { auto = false } = {}) {
      $('.ps-title', back).textContent = titleText; $('.ps-sub', back).textContent = sub;
      if (msg) { const m = $('.ps-msg', back); m.hidden = false; m.innerHTML = msg; }
      $('.ps-close', back).hidden = false;
      if (auto) setTimeout(() => back.isConnected && close(), 900);
    },
  };
}

/* ---------------- encrypt an existing folder ---------------- */
async function lockFolderFlow(f) {
  const n = (await store.countDocs())[f.id] || 0;
  const sec = secretSetup();
  const body = h(`<div class="form lock-form">
    <p class="lock-intro">${n ? `The ${n} ${n === 1 ? 'note' : 'notes'} in this folder (handwriting, titles, thumbnails and PDFs) will be encrypted on this iPad.` : 'Notes you add to this folder will be encrypted on this iPad.'} You’ll need the passcode to open the folder.</p>
    <div class="pw-box"></div>
    <p class="err" id="fErr"></p>
  </div>`);
  $('.pw-box', body).append(...sec.el.children);
  const ok = await modal({
    title: `Lock “${f.name}”`, body, cls: 'wide lock-modal',
    actions: [{ label: 'Cancel', value: false }, {
      label: 'Lock & Encrypt', kind: 'primary',
      validate: async (w, b) => {
        const err = (m) => { $('#fErr', w).textContent = m; return false; };
        const r = sec.read(err); if (!r) return false;
        b.disabled = true; b.textContent = 'Preparing…';
        try { await store.lockExistingFolder(f.id, r.secret, r.mode); }
        catch (e) { b.disabled = false; b.textContent = 'Lock & Encrypt'; return err(e.message); }
        throttle.recordSuccess(f.id);
        return true;
      },
      value: true,
    }],
  });
  if (!ok) return;
  await runEncryption(f.id, f.name);
  renderLibrary();
}
async function runEncryption(id, name) {
  const ps = progressSheet(`Encrypting “${name}”`);
  try {
    const done = await store.finishEncryption(id, (d, t) => ps.set(d, t, t ? `${d} of ${t} ${t === 1 ? 'note' : 'notes'} encrypted` : 'Nothing to encrypt'));
    ps.set(1, 1, '');
    ps.finish(`“${name}” is encrypted`, `${done} ${done === 1 ? 'note' : 'notes'} encrypted · the folder now needs its passcode`, '', { auto: true });
    return true;
  } catch (e) {
    console.error(e);
    ps.finish('Encryption paused', e.message, 'Nothing was lost: notes that weren’t encrypted yet are still stored as they were. Unlock the folder again to finish.');
    return false;
  }
}
async function resumeEncryptionIfNeeded(id) {
  const f = (await store.listFolders()).find((x) => x.id === id);
  if (f && f.encrypting && store.isUnlocked(id)) await runEncryption(id, f.name);
}

/* ---------------- select mode: batch move / delete ---------------- */
function setSelecting(on) {
  selecting = on; selected.clear();
  $('#libBody').classList.toggle('selecting', on);
  $('#libActions').hidden = on; $('#selActions').hidden = !on;
  $$('#libBody .card.sel').forEach((c) => c.classList.remove('sel'));
  syncSelect();
}
function syncSelect() {
  const s = $('#sectionSub');
  if (!selecting) { if (baseSub && shownIds.length >= 0 && !$('#libBody .lockscreen')) s.textContent = baseSub; return; }
  const n = selected.size;
  s.textContent = n ? `${n} selected` : 'Tap notes to select them';
  const all = shownIds.length > 0 && n === shownIds.length;
  $('#selAllBtn').textContent = all ? 'Deselect All' : 'Select All';
  $('#selAllBtn').disabled = !shownIds.length;
  $('#selMoveBtn').disabled = $('#selDeleteBtn').disabled = !n;
}
function toggleSelect(id, card) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  card.classList.toggle('sel', selected.has(id));
  syncSelect();
}
$('#selectBtn').addEventListener('click', () => setSelecting(true));
$('#selDoneBtn').addEventListener('click', () => setSelecting(false));
$('#selAllBtn').addEventListener('click', () => {
  const all = selected.size === shownIds.length;
  selected.clear(); if (!all) shownIds.forEach((id) => selected.add(id));
  $$('#libBody .card[data-id]').forEach((c) => c.classList.toggle('sel', selected.has(c.dataset.id)));
  syncSelect();
});
$('#selDeleteBtn').addEventListener('click', async () => {
  const ids = [...selected]; if (!ids.length) return;
  if (!(await confirmDialog(`Delete ${ids.length} ${ids.length === 1 ? 'note' : 'notes'}?`, `${ids.length === 1 ? 'This note' : `These ${ids.length} notes`} will be permanently deleted from this device. This can’t be undone.`))) return;
  for (const id of ids) await store.deleteDoc(id);
  toast(`${ids.length} ${ids.length === 1 ? 'note' : 'notes'} deleted`);
  setSelecting(false); renderLibrary();
});
$('#selMoveBtn').addEventListener('click', async () => {
  const ids = [...selected]; if (!ids.length) return;
  const from = section;
  const dests = [{ id: null, name: 'Notes', locked: false }, ...folders].filter((f) => (f.id || null) !== (from || null));
  const list = h(`<div class="dest-list">${dests.map((f) => `<button class="dest" data-id="${f.id || ''}">${icon(f.id ? (f.locked ? 'lock' : 'folder') : 'notes')}<span>${esc(f.name)}</span>${f.locked ? `<em>${store.isUnlocked(f.id) ? 'encrypted' : 'encrypted · passcode'}</em>` : ''}</button>`).join('')}
    <button class="dest dest-new" data-new="1">${icon('folderPlus')}<span>New Folder…</span></button></div>`);
  let target = await modal({
    title: `Move ${ids.length} ${ids.length === 1 ? 'note' : 'notes'} to…`, body: list, cls: 'move-sheet', actions: [{ label: 'Cancel', value: undefined }],
    onOpen: (w, close) => list.addEventListener('click', (e) => { const b = e.target.closest('.dest'); if (b) close(b.dataset.new ? 'new' : (b.dataset.id || null)); }),
  });
  if (target === undefined) return;
  let tempUnlock = false;
  if (target === 'new') {
    const nf = await newFolder({ navigate: false });
    if (!nf) return;
    folders = await store.listFolders();
    target = nf.id; tempUnlock = !!nf.locked; // a new locked folder comes back unlocked; relock after the move
  }
  const f = folders.find((x) => x.id === target);
  if (f && f.locked && !store.isUnlocked(f.id)) {
    if (!(await askFolderPassword(f))) return;
    tempUnlock = true;
  }
  let srcKey, dstKey;
  try { srcKey = await store.folderKeyNow(from); dstKey = await store.folderKeyNow(target); }
  catch (e) { toast(e.locked ? 'Unlock the folder first' : e.message, 3500); return; }
  const where = f ? `“${f.name}”` : 'Notes';
  const ps = ids.length > 2 ? progressSheet(`Moving to ${where}`) : null;
  let ok = 0; const failed = [];
  for (const id of ids) {
    ps?.set(ok + failed.length, ids.length, `${ok + failed.length + 1} of ${ids.length}${dstKey ? ' · encrypting' : srcKey ? ' · decrypting' : ''}`);
    try { await store.moveDocWithKeys(id, target, srcKey, dstKey); ok++; }
    catch (e) { console.error('move failed', id, e); failed.push(e.message); }
  }
  if (tempUnlock && target) store.lockFolder(target);
  const verb = dstKey ? 'moved and encrypted' : srcKey ? 'moved and decrypted' : 'moved';
  const summary = `${ok} ${ok === 1 ? 'note' : 'notes'} ${verb} into ${where}`;
  if (ps) { ps.set(1, 1, ''); ps.finish(failed.length ? 'Move finished with problems' : 'Move complete', summary + (failed.length ? ` · ${failed.length} not moved` : ''), failed.length ? `Notes that couldn’t be moved stayed where they were. ${esc(failed[0])}` : '', { auto: !failed.length }); }
  else toast(failed.length ? `${summary}; ${failed.length} not moved (${failed[0]})` : summary[0].toUpperCase() + summary.slice(1), 3500);
  setSelecting(false); renderLibrary();
});

$('#folderMenuBtn').addEventListener('click', (e) => {
  const f = folders.find((x) => x.id === section);
  if (!f) return;
  const items = [{ label: 'Rename folder', icon: 'edit', onClick: async () => { const n = await promptText('Rename folder', f.name); if (n) { await store.renameFolder(f.id, n); renderLibrary(); } } }];
  if (f.locked && store.isUnlocked(f.id)) items.push({ label: 'Lock now', icon: 'lock', onClick: () => { store.lockFolder(f.id); renderLibrary(); } });
  if (!f.locked) items.push({ label: 'Lock Folder…', icon: 'lock', onClick: () => lockFolderFlow(f) });
  items.push('-', {
    label: 'Delete folder', icon: 'trash', danger: true, onClick: async () => {
      if (f.locked && !store.isUnlocked(f.id)) return toast('Unlock the folder first');
      if (!(await confirmDialog('Delete folder?', `“${f.name}” and every note in it will be permanently deleted.`))) return;
      await store.deleteFolder(f.id);
      section = null; renderLibrary();
    },
  });
  popover(e.currentTarget, items);
});

/* ---------------- create / import ---------------- */
$('#newNoteBtn').addEventListener('click', () => newNote());
async function newNote() {
  const now = Date.now();
  const doc = {
    id: store.uid(), folderId: section,
    meta: { title: `Note ${fmtDate(now)}`, kind: 'notebook', paper: { ...settings.paper }, createdAt: now, updatedAt: now, pageCount: 1, thumb: null },
    body: { pages: [{ id: store.uid(), kind: 'paper', w: 612, h: 792, strokes: [] }] },
  };
  doc.meta.thumb = await makeThumb(doc.meta, doc.body, null);
  await store.saveDoc(doc);
  await openDoc(doc.id);
}

// Import PDF -> small menu: From Files (system picker) / From Google Drive (Picker + streamed download)
$('#importPdfBtn').addEventListener('click', (e) => {
  preloadDrive();
  const pop = popover(e.currentTarget, [
    { label: 'From Files', icon: 'fileUp', onClick: () => $('#pdfInput').click() },
    { label: 'From Google Drive', icon: 'drive', onClick: () => startDriveImport() },
  ]);
  pop.classList.add('import-menu');
  const [a, b] = pop.querySelectorAll('.menu-item'); a.id = 'miFiles'; b.id = 'miDrive';
  b.querySelector('span').insertAdjacentHTML('beforeend', '<small>PDFs or a whole folder</small>');
});
$('#pdfInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let lastId = null;
  for (const file of files) {
    try { toast(`Importing ${file.name}…`, 10000); lastId = await importPdf(new Uint8Array(await file.arrayBuffer()), file.name, section); toast(`Imported “${file.name.replace(/\.pdf$/i, '')}”`); }
    catch (err) {
      console.error(err);
      toast(err && err.name === 'PasswordException' ? `“${file.name}” is password-protected; unlock it first.` : `Couldn’t import “${file.name}”`, 4000);
    }
  }
  if (files.length === 1 && lastId) openDoc(lastId); else renderLibrary();
});

// shared by Files and Google Drive imports: one PDF -> one document in the given folder
async function importPdf(bytes, name, folderId, driveId) {
  const pdfDoc = await openPdf(bytes);
  try {
    const sizes = await pageSizes(pdfDoc);
    const now = Date.now();
    const doc = {
      id: store.uid(), folderId,
      meta: { title: name.replace(/\.pdf$/i, ''), kind: 'pdf', paper: { ...settings.paper }, createdAt: now, updatedAt: now, pageCount: sizes.length, thumb: null },
      body: { pages: sizes.map((s, i) => ({ id: store.uid(), kind: 'pdf', pdfIndex: i, w: s.w, h: s.h, strokes: [] })) },
    };
    if (driveId) doc.meta.driveId = driveId; // lets Drive imports spot files already imported
    doc.meta.thumb = await makeThumb(doc.meta, doc.body, pdfDoc);
    await store.saveDoc(doc, { pdfBytes: bytes });
    return doc.id;
  } finally { pdfDoc.destroy(); }
}

initDrive({
  folderId: () => section,
  folderName: (id) => { const f = folders.find((x) => x.id === id); return f ? `“${f.name}”` : 'Notes'; },
  folderLocked: (id) => !!folders.find((x) => x.id === id && x.locked),
  // Drive folder -> Inkwell folder: reuse a plain folder with the same name, else create one
  ensureFolder: async (name) => {
    const all = await store.listFolders();
    const hit = all.find((f) => !f.locked && f.name.trim().toLowerCase() === name.trim().toLowerCase());
    const id = hit ? hit.id : (await store.createFolder(name.slice(0, 120))).id;
    folders = await store.listFolders();
    return id;
  },
  // Drive file ids already in the library (unlocked folders only), so re-imports start unchecked
  importedDriveIds: async () => {
    const ids = new Set();
    for (const fid of [null, ...folders.filter((f) => !f.locked || store.isUnlocked(f.id)).map((f) => f.id)]) {
      try { for (const d of await store.listDocs(fid)) if (d.driveId) ids.add(d.driveId); } catch {}
    }
    return ids;
  },
  importBytes: async (bytes, name, folderId, driveId) => { const id = await importPdf(bytes, name, folderId, driveId); if (!current) renderLibrary(); return id; },
  done: (ids, n) => { if (ids.length === 1 && n === 1 && !current) openDoc(ids[0]); else if (!current) renderLibrary(); },
});

/* ---------------- open / close a note ---------------- */
async function openDoc(id) {
  closePopover();
  try {
    const d = await store.loadDoc(id);
    if (d.meta.kind === 'pdf') {
      d.pdfBytes = await store.loadPdf(id);
      d.pdfDoc = await openPdf(d.pdfBytes);
    }
    current = d;
    dirty = false; thumbStale = false;
    $('#library').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    $('#thumbs').classList.add('hidden');
    $('#pagesBtn').classList.remove('on');
    updateChrome();
    editor.open(d);
  } catch (e) {
    console.error(e);
    toast(e.locked ? 'This folder is locked' : 'Couldn’t open note: ' + e.message);
  }
}

async function closeDoc({ fast = false } = {}) {
  if (!current) return;
  const d = current;
  editor.cancelActive();
  if (!fast && thumbStale) {
    try { d.meta.thumb = await makeThumb(d.meta, d.body, d.pdfDoc); dirty = true; } catch {}
  }
  thumbStale = false;
  await flushSave();
  editor.close();
  try { d.pdfDoc?.destroy(); } catch {}
  current = null;
  $('#editor').classList.add('hidden');
  $('#library').classList.remove('hidden');
  $('#thumbs').innerHTML = '';
  if (!fast) await renderLibrary();
}
$('#backBtn').addEventListener('click', () => closeDoc());

function updateChrome() {
  if (!current) return;
  $('#lockBadge').innerHTML = current.encrypted ? icon('lock') : '';
  applyPaperTheme(true);
  updateToolbar();
}

// (theme-color stays white: the status bar is the opaque system 'default' bar.)
// Paper-dependent chrome: opaque pills switch dark/light, desk colour, and the pen
// switches to the colour last used on dark (default white) or light (default black) paper.
const paperTheme = () => (current && current.meta.kind !== 'pdf' && isDark(current.meta.paper.color) ? 'dark' : 'light');
let lastTheme = null;
function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
function applyPaperTheme(force = false) {
  if (!current) return;
  const t = paperTheme();
  const ed = $('#editor');
  const paper = current.meta.kind === 'pdf' ? '#ffffff' : current.meta.paper.color;
  ed.classList.toggle('paper-dark', t === 'dark');
  ed.style.setProperty('--paper', paper);
  ed.style.setProperty('--desk', t === 'dark' ? shade(paper, 0.12) : shade(paper, -0.1));
  if (force || t !== lastTheme) {
    lastTheme = t;
    if (settings.pen.color !== settings.penTheme[t]) { settings.pen.color = settings.penTheme[t]; saveSettings(); updateToolbar(); }
  }
}

function updateToolbar() {
  $$('#toolSeg [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === settings.tool));
  $('#fingerBtn').classList.toggle('on', !!settings.fingerDraw);
  $('#docScroll').classList.toggle('finger-draw', !!settings.fingerDraw);
  const sw = $('#swatches'), sz = $('#sizes');
  const t = settings.tool;
  if (t === 'eraser') {
    sw.innerHTML = '<span class="tool-note">Stroke eraser — touch a stroke to remove it</span>';
  } else {
    const colors = t === 'hl' ? HL_COLORS : PEN_COLORS;
    const cur = settings[t].color;
    const custom = !colors.includes(cur);
    sw.innerHTML = colors.map((c) => `<button class="swatch ${t === 'hl' ? 'hl' : ''} ${c === cur ? 'on' : ''}" data-color="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join('')
      + `<label class="swatch custom ${custom ? 'on' : ''}" style="--c:${custom ? cur : 'transparent'}" aria-label="Custom colour"><input type="color" value="${cur}"></label>`;
  }
  const sizes = t === 'hl' ? HL_SIZES : t === 'eraser' ? ERASER_SIZES : PEN_SIZES;
  const maxS = sizes[sizes.length - 1];
  sz.innerHTML = sizes.map((s) => {
    const d = t === 'eraser' ? (s === sizes[0] ? 10 : 20) : Math.max(3, Math.round(4 + (s / maxS) * 16));
    return `<button class="size ${settings[t].size === s ? 'on' : ''}" data-size="${s}" aria-label="Size ${s}"><span style="width:${d}px;height:${d}px;${t === 'hl' ? `border-radius:3px;height:${Math.round(d * 0.7)}px;` : ''}"></span></button>`;
  }).join('');
}

$('#toolSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (!b) return;
  settings.tool = b.dataset.tool; saveSettings(); updateToolbar();
});
$('#swatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  setToolColor(b.dataset.color); updateToolbar();
});
function setToolColor(c) {
  settings[settings.tool].color = c;
  if (settings.tool === 'pen') settings.penTheme[paperTheme()] = c;
  saveSettings();
}
$('#swatches').addEventListener('input', (e) => {
  if (e.target.type !== 'color') return;
  setToolColor(e.target.value);
  e.target.parentElement.style.setProperty('--c', e.target.value);
});
$('#swatches').addEventListener('change', (e) => { if (e.target.type === 'color') updateToolbar(); });
$('#sizes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]');
  if (!b) return;
  settings[settings.tool].size = parseFloat(b.dataset.size); saveSettings(); updateToolbar();
});
$('#fingerBtn').addEventListener('click', () => {
  settings.fingerDraw = !settings.fingerDraw; saveSettings(); updateToolbar();
  toast(settings.fingerDraw ? 'Finger drawing on — two fingers scroll' + (settings.pinchZoom ? ' and zoom' : '') : 'Pencil only — fingers scroll' + (settings.pinchZoom ? ' and pinch-zoom' : ''));
});
$('#undoBtn').addEventListener('click', () => editor.undo());
$('#redoBtn').addEventListener('click', () => editor.redo());
$('#zoomBtn').addEventListener('click', () => editor.resetZoom());

const ZOOM_STOPS = [0.75, 1, 1.25, 1.5, 2];
function applyZoom(z) {
  editor.setZoom(z);
  const read = document.getElementById('zoomReadout');
  if (read) read.textContent = Math.round(editor.zoom * 100) + '%';
  document.querySelectorAll('.zoom-stop').forEach((b) => b.classList.toggle('on', Math.abs(parseFloat(b.dataset.z) - editor.zoom) < 0.011));
}
$('#zoomAdjustBtn').addEventListener('click', (e) => {
  const pop = h(`<div class="zoom-pop">
    <div class="pop-title">Zoom</div>
    <div class="zoom-row">
      <button type="button" class="btn secondary" id="zoomOut" aria-label="Zoom out">−</button>
      <span id="zoomReadout">${Math.round(editor.zoom * 100)}%</span>
      <button type="button" class="btn secondary" id="zoomIn" aria-label="Zoom in">+</button>
    </div>
    <div class="zoom-stops">
      ${ZOOM_STOPS.map((z) => `<button type="button" class="zoom-stop ${Math.abs(z - editor.zoom) < 0.011 ? 'on' : ''}" data-z="${z}">${Math.round(z * 100)}%</button>`).join('')}
    </div>
    <label class="switch-row"><span>Pinch to zoom<small>Off by default so writing doesn’t zoom the page. Use this button instead.</small></span><input type="checkbox" id="pinchZoomToggle" ${settings.pinchZoom ? 'checked' : ''}><span class="switch"></span></label>
  </div>`);
  const opened = popover(e.currentTarget, pop, { align: 'end', width: 280 });
  $('#zoomOut', opened).addEventListener('click', (ev) => { ev.stopPropagation(); applyZoom(Math.round((editor.zoom - 0.25) * 100) / 100); });
  $('#zoomIn', opened).addEventListener('click', (ev) => { ev.stopPropagation(); applyZoom(Math.round((editor.zoom + 0.25) * 100) / 100); });
  opened.addEventListener('click', (ev) => {
    const b = ev.target.closest('.zoom-stop');
    if (!b) return;
    ev.stopPropagation();
    applyZoom(parseFloat(b.dataset.z));
  });
  $('#pinchZoomToggle', opened).addEventListener('change', (ev) => {
    settings.pinchZoom = ev.target.checked;
    saveSettings();
    toast(settings.pinchZoom ? 'Pinch zoom on' : 'Pinch zoom off — page stays at the zoom you set');
  });
});
$('#addPageBtn').addEventListener('click', () => { editor.addPage(); refreshThumbs(); toast('Page added'); });
async function renameCurrent() {
  const t = await promptText('Rename note', current.meta.title);
  if (t) { current.meta.title = t; updateChrome(); dirty = true; flushSave(); }
}
$('#shareBtn').addEventListener('click', () => exportCurrentPdf());

document.addEventListener('keydown', (e) => {
  if (!current || e.target.closest('input,textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); }
});

/* ---------------- paper picker ---------------- */
$('#paperBtn').addEventListener('click', (e) => {
  const paper = current.meta.paper;
  const pop = h(`<div class="paper-pop">
    <div class="pop-title">Page style</div>
    <div class="paper-styles">${PAPER_STYLES.map((s) => `<button class="paper-style ${paper.style === s.id ? 'on' : ''}" data-style="${s.id}"><canvas width="96" height="120"></canvas><span>${s.name}</span></button>`).join('')}</div>
    <div class="pop-title">Page colour</div>
    <div class="paper-colors">${PAPER_COLORS.map((c) => `<button class="pcolor ${paper.color === c.c ? 'on' : ''}" data-color="${c.c}" style="--c:${c.c}" title="${c.name}" aria-label="${c.name}"></button>`).join('')}
      <label class="pcolor custom ${PAPER_COLORS.some((c) => c.c === paper.color) ? '' : 'on'}" title="Custom" style="--c:${paper.color}"><input type="color" value="${paper.color}"></label></div>
    <label class="switch-row grain-row"><span>Paper grain<small>Subtle real-paper texture under the lines and ink.</small></span><input type="checkbox" id="grainToggle" ${paper.grain ? 'checked' : ''}><span class="switch"></span></label>
    ${current.meta.kind === 'pdf' ? '<p class="pop-note">Applies to blank pages you add. PDF pages keep their own look.</p>' : ''}
  </div>`);
  const drawPrev = () => $$('.paper-style canvas', pop).forEach((c, i) => {
    const ctx = c.getContext('2d'); const s = 96 / 612 * 2.2;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, 612, 792);
    drawPaper(ctx, 612 / 2.2, 792 / 2.2, { style: PAPER_STYLES[i].id, color: current.meta.paper.color, grain: !!current.meta.paper.grain }, s);
  });
  const apply = (p) => {
    editor.setPaper(p); settings.paper = { ...p }; saveSettings();
    $$('.paper-style', pop).forEach((b) => b.classList.toggle('on', b.dataset.style === p.style));
    $$('.pcolor[data-color]', pop).forEach((b) => b.classList.toggle('on', b.dataset.color === p.color));
    $('#grainToggle', pop).checked = !!p.grain;
    drawPrev();
  };
  pop.addEventListener('click', (ev) => {
    const s = ev.target.closest('[data-style]'), c = ev.target.closest('[data-color]');
    if (s) apply({ ...current.meta.paper, style: s.dataset.style });
    // presets that come with grain (Sage) switch it on; other colours keep the current grain setting
    if (c) apply({ ...current.meta.paper, color: c.dataset.color, ...(presetFor(c.dataset.color)?.grain ? { grain: true } : {}) });
  });
  pop.addEventListener('change', (ev) => {
    if (ev.target.type === 'color') apply({ ...current.meta.paper, color: ev.target.value });
    if (ev.target.id === 'grainToggle') apply({ ...current.meta.paper, grain: ev.target.checked });
  });
  popover(e.currentTarget, pop, { width: 520 });
  drawPrev();
});

/* ---------------- page thumbnails ---------------- */
$('#pagesBtn').addEventListener('click', () => {
  const t = $('#thumbs');
  const show = t.classList.contains('hidden');
  t.classList.toggle('hidden', !show);
  $('#pagesBtn').classList.toggle('on', show);
  if (show) refreshThumbs(true);
});
let thumbTimer;
function scheduleThumbRefresh() { clearTimeout(thumbTimer); thumbTimer = setTimeout(() => refreshThumbs(), 900); }
async function refreshThumbs(full = false) {
  const t = $('#thumbs');
  if (!current || t.classList.contains('hidden')) return;
  const pages = current.body.pages;
  if (full || t.children.length !== pages.length) {
    t.innerHTML = pages.map((p, i) => `<div class="thumb-item" data-i="${i}"><button class="thumb-btn"><canvas></canvas></button><div class="thumb-foot"><span>${i + 1}</span>${pages.length > 1 ? `<button class="icon-btn xs thumb-del" aria-label="Delete page">${icon('trash')}</button>` : ''}</div></div>`).join('')
      + `<button class="thumb-add">${icon('plus')}<span>Add page</span></button>`;
  }
  const items = $$('.thumb-item', t);
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('current', i === editor.currentIndex);
    const c = $('canvas', items[i]);
    const p = pages[i];
    const v = p.strokes.length + ':' + p.strokes.map((s) => s.id.slice(0, 4)).join('').length + ':' + current.meta.paper.style + current.meta.paper.color + (current.meta.paper.grain ? 'g' : '') + p.id;
    if (c._v === v && !full) continue;
    c._v = v;
    const tmp = document.createElement('canvas');
    await renderPageInto(tmp, p, current.meta.paper, current.pdfDoc, (128 * 2) / p.w);
    if (!current) return;
    c.width = tmp.width; c.height = tmp.height;
    c.getContext('2d').drawImage(tmp, 0, 0);
    tmp.width = tmp.height = 0;
  }
}
$('#thumbs').addEventListener('click', async (e) => {
  if (e.target.closest('.thumb-add')) { editor.addPage(current.body.pages.length - 1); refreshThumbs(); return; }
  const item = e.target.closest('.thumb-item');
  if (!item) return;
  const i = +item.dataset.i;
  if (e.target.closest('.thumb-del')) {
    if (await confirmDialog('Delete page?', `Page ${i + 1} and its ink will be removed. You can undo this.`)) { editor.deletePage(i); refreshThumbs(true); }
    return;
  }
  editor.scrollToPage(i);
});

/* ---------------- editor "more" menu ---------------- */
$('#edMoreBtn').addEventListener('click', (e) => {
  popover(e.currentTarget, [
    { label: current.meta.title, icon: current.encrypted ? 'lock' : 'notes', onClick: () => renameCurrent() },
    '-',
    { label: 'Export as PDF', icon: 'download', onClick: () => exportCurrentPdf() },
    { label: 'Rename…', icon: 'edit', onClick: () => renameCurrent() },
    { label: 'Draw with finger', icon: 'hand', checked: !!settings.fingerDraw, onClick: () => $('#fingerBtn').click() },
    '-',
    { label: 'Delete note', icon: 'trash', danger: true, onClick: async () => {
      if (!(await confirmDialog('Delete note?', `“${current.meta.title}” will be permanently deleted.`))) return;
      const id = current.id; dirty = false;
      await closeDoc({ fast: true }); await store.deleteDoc(id); renderLibrary();
    } },
  ]);
});

/* ---------------- export / share files ---------------- */
async function deliverFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.share && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    try {
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (e.name === 'NotAllowedError') {
        // lost the user gesture while generating the file: ask for one more tap
        await modal({ title: 'File ready', body: `<p>${esc(filename)} is ready.</p>`, actions: [{ label: 'Cancel', value: null }, { label: 'Save / Share', kind: 'primary', value: true, validate: async () => { try { await navigator.share({ files: [file] }); } catch {} return true; } }] });
        return;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const safeName = (s) => (s || 'note').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

async function exportPdfFor(d) {
  toast('Preparing PDF…', 10000);
  const { exportNoteAsPdf } = await import('./exportpdf.js');
  const bytes = await exportNoteAsPdf(d);
  toast('PDF ready');
  await deliverFile(new Blob([bytes], { type: 'application/pdf' }), safeName(d.meta.title) + '.pdf');
}
async function exportCurrentPdf() {
  try { await flushSave(); await exportPdfFor(current); } catch (e) { console.error(e); toast('Export failed: ' + e.message, 4000); }
}
async function exportPdfById(id) {
  try {
    const d = await store.loadDoc(id);
    if (d.meta.kind === 'pdf') { d.pdfBytes = await store.loadPdf(id); d.pdfDoc = await openPdf(d.pdfBytes); }
    await exportPdfFor(d);
    d.pdfDoc?.destroy();
  } catch (e) { console.error(e); toast('Export failed: ' + e.message, 4000); }
}

/* ---------------- settings, storage, backup ---------------- */
async function storageStatus() {
  const out = { persisted: null, usage: null, quota: null };
  try { if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted(); } catch {}
  try { if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; } } catch {}
  return out;
}
const mb = (b) => (b == null ? '?' : b < 1e6 ? Math.max(1, Math.round(b / 1e3)) + ' KB' : (b / 1e6).toFixed(1) + ' MB');

async function updateStorageInfo() {
  const s = await storageStatus();
  $('#storageInfo').innerHTML = `${icon('shield', s.persisted ? 'ok' : 'warnic')}<span>${s.persisted ? 'Storage protected' : 'Storage not yet protected'}<br><small>${mb(s.usage)} used on this device</small></span>`;
}

let persistAsked = false;
async function requestPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  try { const ok = await navigator.storage.persist(); updateStorageInfo(); return ok; } catch {}
}
window.addEventListener('pointerdown', requestPersist, { once: true });

$('#settingsBtn').addEventListener('click', openSettings);
async function openSettings() {
  const s = await storageStatus();
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const body = h(`<div class="settings">
    <label class="switch-row"><span>${icon('hand')} Draw with finger<small>Off: only Apple Pencil draws; fingers scroll.</small></span><input type="checkbox" id="sFinger" ${settings.fingerDraw ? 'checked' : ''}><span class="switch"></span></label>
    <label class="switch-row"><span>${icon('zoom')} Pinch to zoom<small>Off by default so a resting hand doesn’t zoom the page. Use the zoom button to change size.</small></span><input type="checkbox" id="sPinch" ${settings.pinchZoom ? 'checked' : ''}><span class="switch"></span></label>
    <div class="set-group">
      <div class="set-title">Storage</div>
      <p>Notes are stored only on this device (IndexedDB). <b>${s.persisted ? 'Persistent storage is granted.' : 'Persistent storage not granted yet.'}</b> ${mb(s.usage)} used.</p>
      ${standalone ? '' : '<p class="note">Tip: add Inkwell to your Home Screen (Share → Add to Home Screen). Safari may clear website data that isn’t on the Home Screen after weeks of not visiting.</p>'}
      <button class="btn secondary" id="sPersist">${icon('shield')} Request persistent storage</button>
    </div>
    <div class="set-group">
      <div class="set-title">Backup</div>
      <p>Save everything to a single file (Files, iCloud Drive, AirDrop…). Encrypted folders stay encrypted inside the backup — you’ll need their passwords after restoring.</p>
      <div class="row"><button class="btn primary" id="sExport">${icon('download')} Export backup</button><button class="btn secondary" id="sImport">${icon('upload')} Import backup</button></div>
    </div>
    <p class="fine">Inkwell works offline. Nothing is uploaded anywhere.</p>
  </div>`);
  $('#sFinger', body).addEventListener('change', (e) => { settings.fingerDraw = e.target.checked; saveSettings(); updateToolbar(); });
  $('#sPinch', body).addEventListener('change', (e) => { settings.pinchZoom = e.target.checked; saveSettings(); toast(settings.pinchZoom ? 'Pinch zoom on' : 'Pinch zoom off'); });
  $('#sPersist', body).addEventListener('click', async () => {
    persistAsked = false;
    const ok = await requestPersist();
    toast(ok ? 'Persistent storage granted' : 'Safari declined for now — adding to Home Screen helps');
  });
  $('#sExport', body).addEventListener('click', exportBackup);
  $('#sImport', body).addEventListener('click', () => $('#backupInput').click());
  modal({ title: 'Settings', body, actions: [{ label: 'Done', value: true, kind: 'primary' }] });
}

async function exportBackup() {
  try {
    await flushSave();
    const json = await store.exportBackup();
    const d = new Date();
    const name = `inkwell-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
    await deliverFile(new Blob([json], { type: 'application/json' }), name);
    toast('Backup exported');
  } catch (e) { console.error(e); toast('Backup failed: ' + e.message, 4000); }
}
$('#backupInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = await store.importBackup(await f.text());
    toast(`Restored ${r.docs} notes, ${r.folders} folders`, 3500);
    $$('.modal-back').forEach((m) => m.remove());
    renderLibrary(); updateStorageInfo();
  } catch (err) { toast(err.message, 4000); }
});

/* ---------------- auto-relock ---------------- */
async function relockAll() {
  const anyKeys = store.unlockedIds().length > 0;
  if (current && current.encrypted) {
    document.body.classList.add('privacy'); // hide content from the app switcher snapshot
    await closeDoc({ fast: true });
  } else await flushSave();
  if (anyKeys) {
    store.lockAll();
    $('#libBody').innerHTML = '';
    await renderLibrary();
  }
  document.body.classList.remove('privacy');
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') relockAll(); });
window.addEventListener('pagehide', () => relockAll());

/* ---------------- misc platform glue ---------------- */
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) requestPersist();

// paper grain tile (vendored, precached): repaint open pages once it has decoded
loadGrain().then((t) => { if (t && current) editor.rerenderAll(); });

renderLibrary();
updateStorageInfo();
