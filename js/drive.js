// Import from Google Drive: Google Identity Services token client + Google Picker (drive.readonly).
// Same Google Cloud project as Comic Shelf. The access token is kept in memory only; files are downloaded
// straight from Google to this device and imported exactly like a local PDF. Nothing is ever uploaded.
//
// Google Cloud console requirements (project 183934120007):
//   * APIs enabled: Google Drive API, Google Picker API
//   * OAuth web client, Authorized JavaScript origins: https://anthonyjonesdavid-cmyk.github.io (+ http://localhost:8823)
//     -> enough for the normal pop-up sign-in on any path of that origin (Inkwell included).
//   * Authorized redirect URI https://anthonyjonesdavid-cmyk.github.io/ink-130736f0145d/ is only needed for the
//     same-window "Sign in here" fallback (Home Screen app when the pop-up can't report back). Flip REDIRECT_FALLBACK
//     to true once that URI is added (Google answers redirect_uri_mismatch until then).
import { $, esc, h, toast, modal } from './ui.js';
import { icon } from './icons.js';

export const GOOGLE_CLIENT_ID = '183934120007-49hgfavrkltjo02tr78tmn08mb7g3v3r.apps.googleusercontent.com';
export const GOOGLE_API_KEY = 'AIzaSyCsbQ40mGeh2FYmlrdK7i28MQvuxCEKRNs'; // browser key, referrer-restricted to the github.io origin + localhost:8823
const GOOGLE_APP_ID = '183934120007';          // Cloud project number (Picker setAppId)
const LOGIN_HINT = 'anthonyjonesdavid@gmail.com';
const REDIRECT_FALLBACK = false;               // see header: needs the Inkwell URL as an authorized redirect URI
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = window.__inkwellDriveApi || 'https://www.googleapis.com';   // tests point this at a local mock
const STALL_MS = window.__inkwellDriveStallMs || 30000;  // no bytes for this long -> drop the connection and resume
const RETRIES = 4;                                        // automatic resumes per file (Range request from the last byte)
const BACKOFF = window.__inkwellDriveBackoff || [1000, 2500, 5000, 8000];  // ms before each resume
const MAX_ITEMS = 200;                                   // Picker multi-select cap (bigger batches: pick the folder)
const FOLDER = 'application/vnd.google-apps.folder';
const ZIPS = ['application/zip', 'application/x-zip-compressed']; // Notability exports (PDF + audio)
const MAX_DEPTH = 4;                                     // subfolder levels listed under a picked folder
const REDIRECT = new URL('./', location.href).href.split('#')[0].split('?')[0];

const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'; // only to create the “Inkwell Inbox” folder
const TOK_KEY = 'inkwell.driveTok';
// {t, exp, inbox}. Kept in localStorage until it expires (≤ 1 h) so reopening Inkwell can check the Inbox without a pop-up.
let tok = (() => { try { const v = JSON.parse(localStorage.getItem(TOK_KEY)); return v && v.exp > Date.now() + 60000 ? v : null; } catch { return null; } })();
const keepTok = () => { try { tok ? localStorage.setItem(TOK_KEY, JSON.stringify(tok)) : localStorage.removeItem(TOK_KEY); } catch {} };
let tokenClient = null, loadP = null, pickerReady = false, afterToken = null;
let host = null; // { importBytes(bytes, name, folderId, driveId) -> id, folderId(), folderName(id), folderLocked(id), ensureFolder(name) -> id, importedDriveIds() -> Set, done(ids, n) }
let busy = false;
const tokOK = () => tok && tok.exp > Date.now() + 60000;
const fmtBytes = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : (n | 0) + ' B';
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Cancelled', 'AbortError')); }, { once: true });
});

// token returned by the same-window (redirect) fallback: pick it up, strip it from the URL, then reopen the Picker
let resume = false;
(() => {
  const hsh = location.hash;
  if (!/[#&](access_token|error)=/.test(hsh)) return;
  const p = new URLSearchParams(hsh.slice(1));
  let want = null;
  try { want = sessionStorage.getItem('inkwell.oauthState'); sessionStorage.removeItem('inkwell.oauthState'); } catch {}
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  if (p.get('access_token') && want && p.get('state') === want) { tok = { t: p.get('access_token'), exp: Date.now() + (+p.get('expires_in') || 3600) * 1000 }; resume = true; }
  else if (p.get('error')) setTimeout(() => toast(p.get('error') === 'access_denied' ? 'Google sign-in was cancelled' : 'Google sign-in failed: ' + p.get('error'), 4000), 600);
})();

function script(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
function load() {
  if (!loadP) loadP = Promise.all([
    script('https://accounts.google.com/gsi/client').then(() => {
      tokenClient = google.accounts.oauth2.initTokenClient({ client_id: GOOGLE_CLIENT_ID, scope: SCOPE, login_hint: LOGIN_HINT, callback: () => {}, error_callback: () => {} });
    }),
    script('https://apis.google.com/js/api.js')
      .then(() => new Promise((res, rej) => gapi.load('picker', { callback: res, onerror: () => rej(new Error('Picker failed to load')) })))
      .then(() => { pickerReady = true; }),
  ]).catch((e) => { loadP = null; throw e; });
  return loadP;
}
const ready = () => !!(tokenClient && pickerReady);
export function preload() { if (navigator.onLine) load().catch(() => {}); }

export function initDrive(h) {
  host = h;
  if (resume) {
    const go = () => load().then(showPicker).catch((e) => toast("Couldn't load Google Picker: " + e.message, 4000));
    if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
  }
}

// entry point: runs synchronously inside the tap so the Google sign-in pop-up isn't blocked
export function startDriveImport() {
  if (busy) { toast('Already importing from Google Drive…'); return; }
  if (!navigator.onLine) { toast("You're offline. Connect to the internet to import from Google Drive.", 3500); return; }
  afterToken = showPicker;
  if (tokOK()) { (ready() ? Promise.resolve() : load()).then(showPicker).catch((e) => toast("Couldn't load Google Picker: " + e.message, 4000)); return; }
  if (ready()) { requestToken(); return; }
  // scripts still loading: a sheet whose Continue button gives us a fresh tap for the pop-up
  modal({
    title: 'Google Drive', cls: 'drive-sheet',
    body: '<p id="dConnMsg">Connecting to Google…</p>',
    actions: [{ label: 'Cancel', value: null }, { label: 'Continue', value: 'go', kind: 'primary' }],
    onOpen: (w, close) => {
      const btns = w.querySelectorAll('.modal-actions .btn');
      const go = btns[btns.length - 1]; go.id = 'dConnGo'; go.disabled = true;
      go.addEventListener('click', () => requestToken(), { capture: true });
      load().then(() => {
        if (!w.isConnected) return;
        $('#dConnMsg', w).textContent = 'Ready. Sign in with Google to choose PDFs from your Drive.';
        go.disabled = false;
      }).catch(() => { if (w.isConnected) $('#dConnMsg', w).textContent = "Couldn't reach Google. Check your connection and try again."; });
    },
  });
}

function requestToken() {
  tokenClient.callback = (r) => {
    if (r.error) { signInHelp(r.error === 'access_denied' ? 'cancelled' : 'error', r.error_description || r.error); return; }
    if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) { signInHelp('scope'); return; }
    tok = { t: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000, inbox: wantInbox && google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE, FILE_SCOPE) };
    keepTok();
    (afterToken || showPicker)();
  };
  tokenClient.error_callback = (e) => signInHelp((e && e.type) || 'unknown');
  try { tokenClient.requestAccessToken({ prompt: '', login_hint: LOGIN_HINT, ...(wantInbox ? { scope: SCOPE + ' ' + FILE_SCOPE, include_granted_scopes: true } : {}) }); } catch { signInHelp('popup_failed_to_open'); }
}

// pop-ups are unreliable in iPad Home Screen apps: explain, offer Try Again (+ same-window sign-in once allowed)
function signInHelp(kind, detail) {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const msg = kind === 'popup_failed_to_open' ? "The Google sign-in window couldn't open (it may have been blocked as a pop-up)."
    : kind === 'popup_closed' ? 'The Google sign-in window was closed before sign-in finished.'
    : kind === 'cancelled' ? 'Google sign-in was cancelled.'
    : kind === 'scope' ? "Drive access wasn't granted. Tick the Google Drive permission when signing in."
    : 'Google sign-in failed' + (detail ? `: ${detail}` : '.');
  const tip = REDIRECT_FALLBACK
    ? (standalone ? "In the Home Screen app the sign-in window sometimes can't report back. Use <b>Sign in here</b> to sign in in this window; you'll come straight back." : 'Try again, or use <b>Sign in here</b> to sign in in this window.')
    : (standalone ? "In the Home Screen app the Google sign-in window sometimes can't report back. Try again; if it keeps failing, use <b>Import PDF → From Files</b>, which also reaches Google Drive." : 'Try again. If pop-ups are blocked, allow them for this site in Settings → Safari.');
  const actions = [{ label: 'Cancel', value: null }, { label: 'Try Again', value: 'retry', kind: REDIRECT_FALLBACK ? 'secondary' : 'primary' }];
  if (REDIRECT_FALLBACK) actions.push({ label: 'Sign in here', value: 'redirect', kind: 'primary' });
  modal({ title: 'Sign in to Google Drive', cls: 'drive-sheet', body: `<p>${esc(msg)}</p><p class="drive-tip">${tip}</p>`, actions,
    onOpen: (w) => {
      // keep the tap's user activation for the pop-up: act in the click itself, not after the modal promise resolves
      const btns = [...w.querySelectorAll('.modal-actions .btn')];
      btns[1].id = 'dRetry'; btns[1].addEventListener('click', () => requestToken(), { capture: true });
      if (btns[2]) { btns[2].id = 'dRedirect'; btns[2].addEventListener('click', redirectSignIn, { capture: true }); }
    } });
}
function redirectSignIn() {
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  try { sessionStorage.setItem('inkwell.oauthState', state); } catch {}
  const q = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'token', scope: SCOPE, state, include_granted_scopes: 'true', login_hint: LOGIN_HINT });
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q);
}

function showPicker() {
  const P = google.picker;
  // PDFs and folders; a folder can itself be selected (-> checklist of its PDFs). Multi-select is on.
  const view = new P.DocsView(P.ViewId.DOCS).setMimeTypes('application/pdf,application/zip,application/x-zip-compressed,application/octet-stream,' + FOLDER).setIncludeFolders(true).setSelectFolderEnabled(true).setMode(P.DocsViewMode.LIST);
  const b = new P.PickerBuilder().addView(view).enableFeature(P.Feature.MULTISELECT_ENABLED)
    .setOAuthToken(tok.t).setDeveloperKey(GOOGLE_API_KEY).setAppId(GOOGLE_APP_ID)
    .setTitle('Select PDFs or a whole folder (you can select several)').setMaxItems(MAX_ITEMS).setCallback(onPicked);
  try { b.setOrigin(location.origin); } catch {}
  b.build().setVisible(true);
  keepPickerBelowStatusBar();
}
// Picker positions itself; in the Home Screen app make sure it never slides under the status bar
function keepPickerBelowStatusBar() {
  const minTop = ($('#topBand')?.offsetHeight || 0) + 6;
  if (minTop <= 6) return;
  let n = 0;
  const t = setInterval(() => {
    const d = document.querySelector('.picker-dialog');
    if (d && d.getBoundingClientRect().top < minTop) d.style.top = minTop + 'px';
    if (++n > 40) clearInterval(t);
  }, 100);
}
function onPicked(d) {
  const P = google.picker;
  if (d[P.Response.ACTION] !== P.Action.PICKED) return;
  const docs = d[P.Response.DOCUMENTS] || [];
  const folders = [], files = [];
  for (const x of docs) {
    const mt = x[P.Document.MIME_TYPE] || 'application/pdf', id = x[P.Document.ID], name = x[P.Document.NAME] || 'Untitled';
    const rk = x.resourceKey || '';
    if (mt === FOLDER) folders.push({ id, name, keys: rk ? [`${id}/${rk}`] : [] });
    else if (mt === 'application/pdf' || ZIPS.includes(mt) || /\.(zip|note)$/i.test(name)) files.push({ id, name, size: +(x.sizeBytes || x[P.Document.SIZE_BYTES] || 0), keys: rk ? [`${id}/${rk}`] : [] });
  }
  if (!folders.length && !files.length) { toast('No PDFs in that selection'); return; }
  if (!folders.length && files.length === 1) { importRemote(files); return; }  // one file: straight in, like before
  checklist({ files, folders });
}

/* ---------- folder listing (files.list, paginated, optional subfolders) ---------- */
const keyHeader = (keys) => { const v = [...new Set((keys || []).filter(Boolean))].join(','); return v ? { 'X-Goog-Drive-Resource-Keys': v } : {}; };
async function listFolder(folder, { deep, onCount, onSub, signal }, depth = 0, path = '') {
  let out = [], page = '';
  do {
    const q = new URLSearchParams({ q: `'${folder.id}' in parents and trashed=false and (mimeType='application/pdf' or mimeType='application/zip' or mimeType='application/x-zip-compressed' or name contains '.note' or mimeType='${FOLDER}')`,
      fields: 'nextPageToken,files(id,name,size,mimeType,resourceKey)', pageSize: '1000', orderBy: 'folder,name_natural',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (page) q.set('pageToken', page);
    const r = await fetch(`${API}/drive/v3/files?${q}`, { headers: { Authorization: 'Bearer ' + tok.t, ...keyHeader(folder.keys) }, signal });
    if (r.status === 401) { tok = null; throw new HttpError(401, 'Google session expired'); }
    if (!r.ok) throw new HttpError(r.status, r.status === 404 ? `Folder not found or no access (HTTP 404)` : `Google Drive error (HTTP ${r.status})`);
    const j = await r.json();
    const subs = [];
    for (const f of j.files || []) {
      const keys = f.resourceKey ? folder.keys.concat(`${f.id}/${f.resourceKey}`) : folder.keys;
      if (f.mimeType === FOLDER) subs.push({ id: f.id, name: f.name, keys });
      else out.push({ id: f.id, name: f.name, size: +f.size || 0, keys, path });
    }
    onCount?.(out.length);
    if (subs.length) onSub?.();
    if (deep && depth < MAX_DEPTH) for (const sf of subs) out = out.concat(await listFolder(sf, { deep, signal, onSub, onCount: (n) => onCount?.(out.length + n) }, depth + 1, path ? `${path} / ${sf.name}` : sf.name));
    else if (subs.length) out.subCount = (out.subCount || 0) + subs.length;
    page = j.nextPageToken || '';
  } while (page);
  return out;
}

/* ---------- checklist sheet: after a folder pick or a multi-file pick ---------- */
async function checklist({ files, folders }) {
  const one = folders.length === 1 && !files.length ? folders[0] : null;
  const title = one ? one.name : folders.length ? `${folders.length + files.length} items selected` : `${files.length} PDFs selected`;
  const curName = host.folderName(host.folderId());
  const curLocked = host.folderLocked(host.folderId());
  const back = h(`<div class="modal-back drive-back"><div class="modal drive-ck" role="dialog" aria-modal="true" aria-label="Choose PDFs to import">
    <div class="ck-top">
      <div class="modal-head"><div class="dl-head"><h2 id="ckTitle">${esc(title)}</h2><div class="dl-sub" id="ckSub">${folders.length ? 'Listing PDFs…' : ''}</div></div></div>
      <div class="ck-bar"><button class="btn secondary sm" id="ckAll">Select All</button><button class="btn secondary sm" id="ckNone">Select None</button></div>
      ${folders.length ? `<label class="switch-row ck-opt" id="ckDeepRow"><span>Include subfolders</span><input type="checkbox" id="ckDeep" checked><span class="switch"></span></label>
      <label class="switch-row ck-opt"><span>${one ? `Create folder “${esc(one.name)}”` : 'Create a folder for each Drive folder'}<small id="ckDestNote"></small></span><input type="checkbox" id="ckMk" checked><span class="switch"></span></label>` : ''}
    </div>
    <div class="modal-body ck-list" id="ckList">${folders.length ? '<div class="ck-empty">Listing…</div>' : ''}</div>
    <div class="modal-actions"><button class="btn secondary" id="ckCancel">Cancel</button><button class="btn primary" id="ckGo" disabled>Import</button></div>
  </div></div>`);
  $('#modalRoot').appendChild(back);
  requestAnimationFrame(() => back.classList.add('show'));
  const ctl = new AbortController();
  const close = () => { ctl.abort(); back.classList.remove('show'); setTimeout(() => back.remove(), 180); };
  $('#ckCancel', back).onclick = close;
  let items = [], imported = new Set();
  try { imported = await host.importedDriveIds(); } catch {}
  const mk = () => $('#ckMk', back)?.checked;
  const sync = () => {
    const sel = items.filter((x) => x.on), T = sel.reduce((a, x) => a + (x.size || 0), 0), dup = items.filter((x) => x.dup).length;
    $('#ckSub', back).textContent = `${items.length} PDF${items.length === 1 ? '' : 's'}${dup ? ` · ${dup} already imported` : ''} · ${sel.length} selected${T ? ` (${fmtBytes(T)})` : ''}`;
    const go = $('#ckGo', back); go.textContent = sel.length ? `Import ${sel.length}` : 'Import'; go.disabled = !sel.length;
    $('#ckAll', back).disabled = !items.length || sel.length === items.length; $('#ckNone', back).disabled = !sel.length;
    const note = $('#ckDestNote', back);
    if (note) note.textContent = mk() ? (files.length ? `Loose files go into ${curName}.` : '') + ' New folders aren’t passcode-protected.' : `Everything goes into ${curName}${curLocked ? ' (encrypted)' : ''}.`;
  };
  const render = () => {
    const list = $('#ckList', back);
    if (!items.length) { list.innerHTML = `<div class="ck-empty">No PDFs found${folders.length && !$('#ckDeep', back)?.checked && items.subCount ? ' (turn on Include subfolders)' : ''}.</div>`; sync(); return; }
    let html = '', grp = null;
    for (const it of items) {
      const g = it.top ? (it.path ? `${it.top} / ${it.path}` : (folders.length > 1 || files.length ? it.top : '')) : (folders.length ? 'Selected files' : '');
      if (g !== grp) { grp = g; if (g) html += `<div class="ck-grp">${icon('folder')}<span>${esc(g)}</span></div>`; }
      html += `<label class="ck-row${it.dup ? ' dup' : ''}"><input type="checkbox" data-k="${it.k}" ${it.on ? 'checked' : ''}><span class="ck-t"><b>${esc(it.name.replace(/\.pdf$/i, ''))}</b><small>${[it.size ? fmtBytes(it.size) : '', it.dup ? 'Already imported' : ''].filter(Boolean).join(' · ')}</small></span></label>`;
    }
    list.innerHTML = html; sync();
  };
  const load = async () => {
    const deep = $('#ckDeep', back) ? $('#ckDeep', back).checked : true;
    $('#ckGo', back).disabled = true;
    let all = files.map((f) => ({ ...f, top: '', path: '' })), subCount = 0, sawSub = false;
    try {
      for (const fo of folders) {
        const got = await listFolder(fo, { deep, signal: ctl.signal, onSub: () => { sawSub = true; }, onCount: (n) => { $('#ckSub', back).textContent = `Listing “${fo.name}”… ${all.length + n} PDFs`; } });
        subCount += got.subCount || 0;
        all = all.concat(got.map((x) => ({ ...x, top: fo.name, folder: fo })));
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      $('#ckSub', back).textContent = '';
      $('#ckList', back).innerHTML = `<div class="ck-empty err">Couldn't list the folder: ${esc(e.message)}${e.status === 401 ? '. Close this and choose From Google Drive again to sign in.' : ''}</div>`;
      return;
    }
    const prev = new Map(items.map((x) => [x.id, x.on]));
    items = all.map((x, k) => { const dup = imported.has(x.id); return { ...x, k, dup, on: prev.has(x.id) ? prev.get(x.id) : !dup }; });
    items.subCount = subCount;
    const dr = $('#ckDeepRow', back); if (dr) dr.hidden = !sawSub;   // no subfolders: hide the switch
    render();
  };
  back.addEventListener('change', (e) => {
    const c = e.target.closest('input[data-k]');
    if (c) { items[+c.dataset.k].on = c.checked; sync(); return; }
    if (e.target.id === 'ckDeep') load();
    if (e.target.id === 'ckMk') sync();
  });
  const setAll = (v) => { items.forEach((x) => { x.on = v; }); back.querySelectorAll('input[data-k]').forEach((c) => { c.checked = v; }); sync(); };
  $('#ckAll', back).onclick = () => setAll(true);
  $('#ckNone', back).onclick = () => setAll(false);
  $('#ckGo', back).onclick = async () => {
    const sel = items.filter((x) => x.on); if (!sel.length) return;
    $('#ckGo', back).disabled = true;
    const dest = new Map(); // Drive folder id -> Inkwell folder id
    try {
      if (mk()) for (const fo of folders) if (sel.some((x) => x.folder === fo)) dest.set(fo.id, await host.ensureFolder(fo.name));
    } catch (e) { toast("Couldn't create the folder: " + e.message, 4000); $('#ckGo', back).disabled = false; return; }
    const cur = host.folderId();
    close();
    importRemote(sel.map((x) => ({ id: x.id, name: x.name, size: x.size, keys: x.keys, folderId: x.folder && dest.has(x.folder.id) ? dest.get(x.folder.id) : cur })), { openSingle: false });
  };
  if (folders.length) load(); else { items = files.map((x, k) => ({ ...x, top: '', path: '', k, dup: imported.has(x.id), on: !imported.has(x.id) })); render(); }
}

/* ---------- download: streamed, stall watchdog, automatic Range resume ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function download(r, signal, onProg) {
  const parts = []; let got = 0, attempt = 0;
  for (;;) {
    const ctl = new AbortController();
    const kill = () => ctl.abort();
    signal.addEventListener('abort', kill, { once: true });
    let timer = null, stalled = false;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ctl.abort(); }, STALL_MS); };
    try {
      arm();
      const headers = { Authorization: 'Bearer ' + tok.t };
      Object.assign(headers, keyHeader(r.keys));
      if (got) headers.Range = `bytes=${got}-`;
      const resp = await fetch(`${API}/drive/v3/files/${encodeURIComponent(r.id)}?alt=media&supportsAllDrives=true`, { headers, signal: ctl.signal, cache: 'no-store' });
      if (!resp.ok) {
        if (resp.status === 401) { tok = null; throw new HttpError(401, 'Google session expired'); }
        if (resp.status === 403 || resp.status === 404) throw new HttpError(resp.status, `No access to this file (HTTP ${resp.status})`);
        throw new HttpError(resp.status, 'Google Drive error (HTTP ' + resp.status + ')');
      }
      if (got && resp.status !== 206) { parts.length = 0; got = 0; } // server ignored Range: start over
      if (!r.size) { const cl = +resp.headers.get('content-length') || 0; r.size = cl ? cl + got : 0; }
      if (resp.body && resp.body.getReader) {
        const rd = resp.body.getReader();
        try {
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            parts.push(value); got += value.length; arm(); onProg(got, null);
          }
        } catch (e) { try { rd.cancel().catch(() => {}); } catch {} throw e; }
      } else { const ab = new Uint8Array(await resp.arrayBuffer()); parts.push(ab); got += ab.length; onProg(got, null); }
      if (r.size && got < r.size) throw new Error('Connection dropped');
      clearTimeout(timer); signal.removeEventListener('abort', kill);
      break;
    } catch (e) {
      clearTimeout(timer); signal.removeEventListener('abort', kill);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const retryable = !(e instanceof HttpError) || e.status === 429 || e.status >= 500;
      if (!retryable || attempt >= RETRIES) {
        if (stalled) throw new Error('Download stalled (no data for ' + Math.round(STALL_MS / 1000) + ' s)');
        throw e instanceof HttpError ? e : new Error(e.message && !/abort/i.test(e.message) ? 'Network error: ' + e.message : 'Network error');
      }
      attempt++;
      const wait = BACKOFF[Math.min(attempt, BACKOFF.length) - 1];
      onProg(got, `${stalled ? 'Stalled' : 'Connection dropped'}, resuming${got ? ' at ' + fmtBytes(got) : ''} (retry ${attempt} of ${RETRIES})…`);
      await sleep(wait, signal);
    }
  }
  // one contiguous buffer for pdf.js / IndexedDB (same as a local import)
  const out = new Uint8Array(got); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  parts.length = 0;
  return out;
}

/* ---------- progress sheet ---------- */
export async function importRemote(items, { openSingle = true } = {}) {
  if (busy) { toast('Already importing…'); return; }
  busy = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}
  const here = host.folderId();
  const rows = items.map((it, k) => ({ ...it, folderId: it.folderId !== undefined ? it.folderId : here, k, got: 0, st: 'wait', msg: 'Waiting' }));
  const back = h(`<div class="modal-back drive-back"><div class="modal drive-dl" role="dialog" aria-modal="true" aria-label="Importing from Google Drive">
    <div class="modal-head"><div class="dl-head"><h2 id="dlHead">Importing from Google Drive</h2><div class="dl-sub" id="dlSub"></div></div></div>
    <div class="dl-all"><i id="dlAll"></i></div>
    <div class="modal-body dl-list">${rows.map((r) => `<div class="dl-row wait" data-k="${r.k}">
      <div class="dl-ic">${icon('pdf')}</div>
      <div class="dl-main"><div class="dl-t"><b>${esc(r.name.replace(/\.pdf$/i, ''))}</b><span class="dl-p"></span></div><div class="dl-bar"><i></i></div><div class="dl-s">Waiting</div></div>
      <button class="btn secondary dl-retry" hidden>Retry</button></div>`).join('')}</div>
    <div class="modal-actions"><button class="btn secondary" id="dlRetryAll" hidden>Retry failed</button><button class="btn secondary" id="dlCancel">Cancel</button></div>
  </div></div>`);
  $('#modalRoot').appendChild(back);
  requestAnimationFrame(() => back.classList.add('show'));
  const dests = [...new Set(rows.map((r) => r.folderId))];
  const where = dests.length === 1 ? host.folderName(dests[0]) : `${dests.length} folders`;
  let ctl = null, last = 0;
  const ids = [];
  const paint = (force) => {
    const now = performance.now(); if (!force && now - last < 90) return; last = now;
    for (const r of rows) {
      const el = back.querySelector(`.dl-row[data-k="${r.k}"]`);
      const p = r.st === 'done' ? 1 : r.size ? Math.min(1, r.got / r.size) : 0;
      el.className = 'dl-row ' + r.st;
      el.querySelector('.dl-bar i').style.width = (p * 100).toFixed(1) + '%';
      el.querySelector('.dl-p').textContent = r.st === 'dl' || r.st === 'proc' ? (r.size ? Math.round(p * 100) + '%' : fmtBytes(r.got)) : '';
      el.querySelector('.dl-s').textContent = r.msg;
      el.querySelector('.dl-retry').hidden = r.st !== 'fail';
    }
    const T = rows.reduce((a, r) => a + (r.size || 0), 0);
    const G = rows.reduce((a, r) => a + (r.st === 'done' ? (r.size || r.got) : Math.min(r.got, r.size || r.got)), 0);
    const fin = rows.filter((r) => /done|fail|cancel/.test(r.st)).length;
    $('#dlAll', back).style.width = (T ? Math.min(1, G / T) * 100 : (fin / rows.length) * 100).toFixed(1) + '%';
    if (ctl) $('#dlSub', back).textContent = `${Math.min(fin + 1, rows.length)} of ${rows.length}${T ? ` · ${fmtBytes(G)} of ${fmtBytes(T)}` : ''} · into ${where}`;
  };
  const finish = () => {
    const ok = rows.filter((r) => r.st === 'done').length, fail = rows.filter((r) => r.st === 'fail').length, cancelled = rows.some((r) => r.st === 'cancel');
    $('#dlHead', back).textContent = fail ? 'Import finished with problems' : cancelled ? 'Import cancelled' : 'Import complete';
    $('#dlSub', back).textContent = [ok && `${ok} imported into ${where}`, fail && `${fail} failed`, cancelled && 'cancelled'].filter(Boolean).join(' · ') || 'Nothing imported';
    const c = $('#dlCancel', back); c.textContent = 'Done'; c.className = 'btn primary';
    $('#dlRetryAll', back).hidden = !fail;
    if (ok && !fail && !cancelled) setTimeout(() => back.isConnected && done(), 900);
  };
  const done = () => { back.classList.remove('show'); setTimeout(() => back.remove(), 180); busy = false; host.done(ids, openSingle ? rows.length : 0); };

  async function run(list) {
    ctl = new AbortController(); const signal = ctl.signal;
    $('#dlCancel', back).textContent = 'Cancel'; $('#dlCancel', back).className = 'btn secondary'; $('#dlRetryAll', back).hidden = true;
    $('#dlHead', back).textContent = 'Importing from Google Drive';
    for (const r of list) { r.st = 'wait'; r.msg = 'Waiting'; r.got = 0; }
    paint(true);
    let wl = null; try { if (navigator.wakeLock) wl = await navigator.wakeLock.request('screen'); } catch {}
    for (const r of list) {
      if (signal.aborted) { r.st = 'cancel'; r.msg = 'Cancelled'; continue; }
      r.st = 'dl'; r.msg = 'Downloading…'; paint(true);
      try {
        if (!tokOK()) throw new HttpError(401, 'Google session expired');
        const bytes = await download(r, signal, (n, note) => { r.got = n; r.msg = note || `${fmtBytes(n)}${r.size ? ' of ' + fmtBytes(r.size) : ''}`; paint(!!note); });
        r.size = bytes.length; r.got = bytes.length; r.st = 'proc'; r.msg = 'Preparing pages…'; paint(true);
        const id = await host.importBytes(bytes, r.name, r.folderId, r.id);
        ids.push(id); r.st = 'done'; r.msg = `Imported · ${fmtBytes(bytes.length)}`;
      } catch (err) {
        if (signal.aborted || err.name === 'AbortError') { r.st = 'cancel'; r.msg = 'Cancelled'; }
        else {
          console.warn('drive import failed', r.name, err);
          r.st = 'fail';
          const m = err && err.message || '';
          r.msg = err.name === 'PasswordException' ? 'Password-protected PDF; unlock it first'
            : err.name === 'InvalidPDFException' || /Invalid PDF|PDF header/i.test(m) ? 'Not a valid PDF'
            : err.name === 'QuotaExceededError' || /quota/i.test(m) ? 'Out of storage space on this iPad'
            : err.locked ? 'The folder was locked. Unlock it, then tap Retry'
            : err.status === 401 ? 'Google session expired. Tap Retry to sign in again'
            : (m || 'Download failed');
        }
      }
      paint(true);
    }
    ctl = null; try { wl && wl.release(); } catch {}
    finish(); paint(true);
  }
  // Retry needs a fresh token if it expired: the Retry tap itself opens the sign-in pop-up
  const retry = (list) => {
    if (ctl) return;
    if (tokOK()) { run(list); return; }
    afterToken = () => run(list);
    if (ready()) requestToken(); else load().then(requestToken).catch(() => toast("Couldn't reach Google. Try again.", 3500));
  };
  back.addEventListener('click', (e) => {
    const b = e.target.closest('.dl-retry'); if (!b) return;
    retry([rows[+b.closest('.dl-row').dataset.k]]);
  });
  $('#dlRetryAll', back).addEventListener('click', () => retry(rows.filter((r) => r.st === 'fail')));
  $('#dlCancel', back).addEventListener('click', () => { if (ctl) ctl.abort(); else done(); });
  await run(rows);
}

/* ---------- Inkwell Inbox ----------
   A Drive folder “Inkwell Inbox”. Files saved into it from other apps (iOS Files, Drive app) are NOT visible with
   drive.file (that scope only covers files Inkwell created / the user picked), so the inbox is listed with drive.readonly
   — the same scope Import from Google Drive already uses. drive.file is added only so Inkwell can create the folder.
   Imported file ids are remembered on this device; files are never moved or deleted (read-only access). */
const INBOX_NAME = 'Inkwell Inbox';
const INBOX_KEY = 'inkwell.inbox';
const INBOX_TYPES = ['application/pdf', ...ZIPS, 'application/octet-stream', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/gif'];
const INBOX_EXT = /\.(pdf|zip|note|jpe?g|png|heic|heif|webp|gif)$/i;
let wantInbox = false;
export const inboxState = () => { try { return JSON.parse(localStorage.getItem(INBOX_KEY)) || {}; } catch { return {}; } };
const saveInbox = (p) => { const s = { ...inboxState(), ...p }; try { localStorage.setItem(INBOX_KEY, JSON.stringify(s)); } catch {} return s; };
export const inboxUrl = () => inboxState().folderId ? `https://drive.google.com/drive/folders/${inboxState().folderId}` : 'https://drive.google.com/drive/my-drive';
export function markInboxImported(id) { if (!id) return; const s = inboxState(); const done = new Set(s.done || []); done.add(id); saveInbox({ done: [...done].slice(-2000) }); }
export const inboxHasToken = () => !!(tokOK() && tok.inbox);
async function gapiJson(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: 'Bearer ' + tok.t, ...(opts.headers || {}) } });
  if (r.status === 401) { tok = null; keepTok(); throw new HttpError(401, 'Google session expired'); }
  if (!r.ok) throw new HttpError(r.status, 'Google Drive error ' + r.status);
  return r.json();
}
const qq = (s) => encodeURIComponent(s);
async function inboxFolder() {
  const s = inboxState();
  if (s.folderId) {
    try { const f = await gapiJson(`/drive/v3/files/${s.folderId}?fields=id,trashed`); if (f.id && !f.trashed) return f.id; } catch (e) { if (e.status === 401) throw e; }
  }
  const found = await gapiJson(`/drive/v3/files?q=${qq(`name='${INBOX_NAME}' and mimeType='${FOLDER}' and trashed=false and 'root' in parents`)}&fields=files(id)&spaces=drive`);
  let id = found.files && found.files[0] && found.files[0].id;
  if (!id) id = (await gapiJson('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: INBOX_NAME, mimeType: FOLDER }) })).id;
  saveInbox({ folderId: id, on: true });
  return id;
}
async function listNew() {
  const fid = await inboxFolder();
  const files = [];
  let page = '';
  do {
    const r = await gapiJson(`/drive/v3/files?q=${qq(`'${fid}' in parents and trashed=false and mimeType != '${FOLDER}'`)}&fields=nextPageToken,files(id,name,mimeType,size,createdTime)&pageSize=200&orderBy=createdTime${page ? '&pageToken=' + page : ''}`);
    files.push(...(r.files || [])); page = r.nextPageToken || '';
  } while (page);
  const done = new Set(inboxState().done || []);
  const have = await host.importedDriveIds();
  saveInbox({ lastCheck: Date.now() });
  return files.filter((f) => (INBOX_TYPES.includes(f.mimeType) || INBOX_EXT.test(f.name)) && !done.has(f.id) && !have.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: +f.size || 0 }));
}
// interactive: from a tap (may open the Google window). Silent (app open): only with a live token.
export async function checkInbox({ interactive = false } = {}) {
  if (!navigator.onLine) { if (interactive) toast("You're offline. Connect to check the Inbox.", 3500); return null; }
  if (!inboxHasToken()) {
    if (!interactive) return null;
    wantInbox = true;
    return new Promise((res) => {
      afterToken = async () => { wantInbox = false; afterToken = null; res(await checkInbox({ interactive: true })); };
      if (ready()) requestToken(); else load().then(requestToken).catch(() => { toast("Couldn't reach Google. Try again.", 3500); res(null); });
    });
  }
  try {
    const items = await listNew();
    host.inboxFound(items, { interactive });
    return items;
  } catch (e) {
    console.warn('inbox', e);
    if (interactive) toast(e.status === 401 ? 'Google session expired — tap Check Inbox again' : 'Couldn’t check the Inbox: ' + e.message, 4000);
    return null;
  }
}
export function importInbox(items, folderId) { return importRemote(items.map((it) => ({ ...it, folderId })), { openSingle: false }); }

export const _test = { setToken: (t, inbox = false) => { tok = t ? { t, exp: Date.now() + 3600e3, inbox } : null; keepTok(); }, get busy() { return busy; }, REDIRECT, SCOPE };
