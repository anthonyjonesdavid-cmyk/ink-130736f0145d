// Automatic Google Drive backup.
// * Google Identity Services token client with the drive.file scope: Inkwell can only see and change files it created
//   itself (the "Inkwell Backups" folder and the backups in it), nothing else in Drive.
// * A backup is the same file as Settings → Export backup (locked folders stay encrypted inside it).
// * Home Screen apps can't run in the background, so "daily" means: when Inkwell is opened (or brought back) and the
//   last backup is more than 24 h old. If Google needs a tap to sign in again, a small bar asks for it.
// * Keeps the newest 7 backups; restore merges without overwriting newer notes on this device (store.mergeBackup).
// Google Cloud: same project / OAuth web client as Comic Shelf and Drive import (origin https://anthonyjonesdavid-cmyk.github.io).
import { $, esc, h, toast, modal, confirmDialog } from './ui.js';
import { icon } from './icons.js';
import * as store from './store.js';
import { GOOGLE_CLIENT_ID } from './drive.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const LOGIN_HINT = 'anthonyjonesdavid@gmail.com';
const API = window.__inkwellDriveApi || 'https://www.googleapis.com';
const FOLDER_NAME = 'Inkwell Backups';
const FOLDER_MT = 'application/vnd.google-apps.folder';
const KEEP = 7;
const DAY = 24 * 3600 * 1000;
const KEY = 'inkwell.driveBackup';

let tok = null, client = null, loadP = null, running = null;
const tokOK = () => tok && tok.exp > Date.now() + 60000;
export const state = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const save = (patch) => { const s = { ...state(), ...patch }; try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} listeners.forEach((f) => f(s)); return s; };
const listeners = new Set();
export const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const isDue = () => { const s = state(); return !!s.on && (!s.lastAt || Date.now() - s.lastAt > DAY); };
const fmtBytes = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

function load() {
  if (window.google?.accounts?.oauth2 && client) return Promise.resolve();
  if (!loadP) loadP = new Promise((res, rej) => {
    const done = () => { client = google.accounts.oauth2.initTokenClient({ client_id: GOOGLE_CLIENT_ID, scope: SCOPE, login_hint: LOGIN_HINT, callback: () => {}, error_callback: () => {} }); res(); };
    if (window.google?.accounts?.oauth2) return done();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = done; s.onerror = () => rej(new Error('Couldn’t reach Google'));
    document.head.appendChild(s);
  }).catch((e) => { loadP = null; throw e; });
  return loadP;
}
export function preload(force = false) { if (navigator.onLine && (force || state().on)) load().catch(() => {}); }

// Must be called from inside a tap: the Google window can only open on a user gesture.
// Resolves with a token. prompt '' = no account chooser / consent screen when already granted (it often closes by itself).
function signIn() {
  return new Promise((resolve, reject) => {
    if (tokOK()) return resolve(tok.t);
    if (!client) { load().catch(() => {}); return reject(new Error('Still connecting to Google — tap again in a moment')); }
    client.callback = (r) => {
      if (r.error) return reject(new Error(r.error === 'access_denied' ? 'Google sign-in was cancelled' : r.error_description || r.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return reject(new Error('Drive access wasn’t granted'));
      tok = { t: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000 };
      resolve(tok.t);
    };
    client.error_callback = (e) => reject(new Error(e && e.type === 'popup_closed' ? 'The Google window was closed' : e && e.type === 'popup_failed_to_open' ? 'The Google window couldn’t open (pop-up blocked)' : 'Google sign-in failed'));
    try { client.requestAccessToken({ prompt: state().granted ? '' : 'consent', login_hint: LOGIN_HINT }); }
    catch (e) { reject(e); }
  });
}

async function api(path, opts = {}) {
  const r = await fetch(path.startsWith('http') ? path : API + path, { ...opts, headers: { Authorization: 'Bearer ' + tok.t, ...(opts.headers || {}) } });
  if (r.status === 401) { tok = null; const e = new Error('Google sign-in expired'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(`Google Drive error ${r.status}`);
  return r;
}
const q = (s) => encodeURIComponent(s);

async function folderId() {
  const s = state();
  if (s.folderId) {
    try {
      const f = await (await api(`/drive/v3/files/${s.folderId}?fields=id,trashed`)).json();
      if (f && f.id && !f.trashed) return f.id;
    } catch (e) { if (e.auth) throw e; }
  }
  const found = await (await api(`/drive/v3/files?q=${q(`name='${FOLDER_NAME}' and mimeType='${FOLDER_MT}' and trashed=false`)}&fields=files(id,name)&spaces=drive`)).json();
  let id = found.files && found.files[0] && found.files[0].id;
  if (!id) {
    const made = await (await api('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MT }) })).json();
    id = made.id;
  }
  save({ folderId: id });
  return id;
}
export async function listBackups() {
  const fid = await folderId();
  const r = await (await api(`/drive/v3/files?q=${q(`'${fid}' in parents and trashed=false`)}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)&pageSize=100`)).json();
  return (r.files || []).sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

// the actual upload (needs a token already)
async function upload() {
  const fid = await folderId();
  const text = await store.exportBackup();
  const blob = new Blob([text], { type: 'application/json' });
  const meta = { name: `Inkwell backup ${stamp()}.json`, parents: [fid], mimeType: 'application/json', description: 'Inkwell backup (inkwell-backup v1). Locked folders stay encrypted.' };
  // resumable upload: works for backups of any size
  const start = await api('/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(blob.size) }, body: JSON.stringify(meta),
  });
  const loc = start.headers.get('Location');
  if (!loc) throw new Error('Google Drive didn’t accept the upload');
  await api(loc, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: blob });
  // keep the newest KEEP
  const all = await listBackups();
  for (const f of all.slice(KEEP)) { try { await api(`/drive/v3/files/${f.id}`, { method: 'DELETE' }); } catch (e) { if (e.auth) throw e; } }
  return blob.size;
}

// run a backup. interactive = called from a tap (may open the Google window); otherwise only with a live token.
export function backupNow({ interactive = true } = {}) {
  if (running) return running;
  if (!navigator.onLine) { save({ lastStatus: 'offline', lastTry: Date.now() }); if (interactive) toast('You’re offline — Inkwell will back up next time'); return Promise.resolve(false); }
  const getTok = interactive ? signIn() : (tokOK() ? Promise.resolve(tok.t) : Promise.reject(Object.assign(new Error('sign-in needed'), { auth: true })));
  running = getTok.then(async () => {
    save({ on: true, granted: true, lastStatus: 'running', lastTry: Date.now() });
    const size = await upload();
    save({ lastAt: Date.now(), lastStatus: 'ok', lastSize: size, lastError: null });
    hideNag();
    if (interactive) toast('Backed up to Google Drive');
    return true;
  }).catch((e) => {
    const needTap = !!e.auth;
    save({ lastStatus: needTap ? 'signin' : 'error', lastError: needTap ? null : e.message, lastTry: Date.now() });
    if (needTap && state().on) showNag();
    else if (interactive) toast('Backup failed: ' + e.message, 4000);
    return false;
  }).finally(() => { running = null; });
  return running;
}

export function turnOff() {
  const t = tok && tok.t;
  save({ on: false, lastStatus: null }); tok = null; hideNag();
  try { if (t) google.accounts.oauth2.revoke(t, () => {}); } catch {}
}
// app going to the background: only a quick try if we still hold a token (iPadOS may suspend us any moment)
export function onHidden() { if (isDue() && tokOK()) backupNow({ interactive: false }); }

// app opened / brought back: back up if due (silently with a live token, else a small "tap to back up" bar)
export function maybeAuto() {
  if (!isDue()) return;
  if (tokOK()) backupNow({ interactive: false });
  else { load().catch(() => {}); showNag(); }
}
function showNag() {
  const n = $('#backupNag');
  if (!n || !state().on || !isDue()) return;
  n.innerHTML = `${icon('cloud')}<span>Daily Google Drive backup is due</span><button type="button" class="btn primary" id="nagGo">Back up</button><button type="button" class="icon-btn" id="nagX" aria-label="Not now">${icon('x')}</button>`;
  n.hidden = false;
  $('#nagGo', n).addEventListener('click', () => backupNow({ interactive: true }));
  $('#nagX', n).addEventListener('click', () => { n.hidden = true; });
}
function hideNag() { const n = $('#backupNag'); if (n) n.hidden = true; }

export function statusText(s = state()) {
  if (!s.on) return 'Off';
  const when = s.lastAt ? new Date(s.lastAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  const st = s.lastStatus === 'running' ? 'Backing up…'
    : s.lastStatus === 'error' ? `<span class="err">Last try failed: ${esc(s.lastError || 'error')}</span>`
    : s.lastStatus === 'signin' ? '<span class="err">Needs a tap to sign in to Google again</span>'
    : s.lastStatus === 'offline' ? '<span class="err">Was offline — will retry</span>'
    : s.lastAt ? 'OK' : '';
  return `Last backup: <b>${when}</b>${s.lastSize ? ` (${fmtBytes(s.lastSize)})` : ''}${st ? ' · ' + st : ''}`;
}

// Settings → Restore from Google Drive (call from a tap)
export async function restoreFlow(onDone) {
  let list;
  try { await signIn(); list = await listBackups(); }
  catch (e) { toast(e.message, 4000); return; }
  if (!list.length) { toast('No backups in “Inkwell Backups” yet'); return; }
  const body = h(`<div><p>Choose a backup. Restoring <b>adds</b> notes and folders that aren’t on this iPad and updates notes only where the backup copy is newer. Nothing here is deleted or replaced with an older copy.</p>
    <div class="bk-list">${list.map((f) => `<button type="button" class="bk-item" data-id="${f.id}"><span>${esc(new Date(f.createdTime).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span><small>${f.size ? fmtBytes(+f.size) : ''}</small></button>`).join('')}</div></div>`);
  const id = await modal({ title: 'Restore from Google Drive', cls: 'restore-sheet', body, actions: [{ label: 'Cancel', value: null }],
    onOpen: (w, close) => body.addEventListener('click', (e) => { const b = e.target.closest('.bk-item'); if (b) close(b.dataset.id); }) });
  if (!id) return;
  const f = list.find((x) => x.id === id);
  if (!(await confirmDialog('Restore this backup?', `Backup from ${new Date(f.createdTime).toLocaleString()}. Missing notes will be added; newer notes on this iPad are kept.`, 'Restore', 'primary'))) return;
  try {
    toast('Downloading backup…', 15000);
    const text = await (await api(`/drive/v3/files/${id}?alt=media`)).text();
    const r = await store.mergeBackup(text);
    toast(`Restored: ${r.added} added, ${r.updated} updated, ${r.kept} kept${r.skipped ? `, ${r.skipped} skipped` : ''}${r.folders ? `, ${r.folders} folders` : ''}`, 5000);
    onDone?.(r);
  } catch (e) { toast('Restore failed: ' + e.message, 4000); }
}
export const _test = { setToken: (t, exp = 3600) => { tok = { t, exp: Date.now() + exp * 1000 }; }, clearToken: () => { tok = null; }, signIn, upload };
