// Voice recordings synced to ink (Notability-style).
// * Record: MediaRecorder (AAC in MP4 on iOS Safari; Opus/WebM elsewhere). Every stroke written while recording gets
//   {rec, at} (recording id + ms from its start), done in editor.js.
// * Recordings are stored one record each in IndexedDB ('audio' store, encrypted with the folder key in locked folders);
//   the note body lists them: body.recordings = [{id, startedAt, dur, mime, size}].
// * Playback bar: play/pause/scrub. While it is open, ink written after the playhead is dimmed and tapping a stroke
//   jumps the audio to the moment it was written.
// * iPadOS stops the microphone when Inkwell leaves the screen, so recording stops and is saved on visibilitychange /
//   pagehide; a screen wake lock keeps the iPad awake while recording.
import { $, esc, h, toast, modal, confirmDialog, popover } from './ui.js';
import { icon } from './icons.js';
import * as store from './store.js';

const MIMES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
let A = null; // host: { editor, current(), changed(), deliverFile(blob, name) }
let rec = null;   // active recording
let play = null;  // { audio, url, id, raf }

export const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
const ext = (mime) => (/mp4|aac/.test(mime || '') ? 'm4a' : /ogg/.test(mime || '') ? 'ogg' : 'webm');
const recs = () => (A.current()?.body.recordings || []);
const label = (r, i) => r.title || `Recording ${i + 1}`;

export function initAudio(host) {
  A = host;
  A.editor.onSeekStroke = (st) => seekToStroke(st);
  $('#recBtn').addEventListener('click', () => (rec ? stopRecording() : startRecording()));
  $('#playBtn').addEventListener('click', () => (play ? closePlayer() : openPlayer()));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && rec && !wakeLock) lockScreen(); });
}
export const isRecording = () => !!rec;

// called when a note opens / closes
export function onOpen() { closePlayer(); updateButtons(); }
export async function onClose() { await stopRecording(); closePlayer(); }

export function updateButtons() {
  const cur = A.current();
  const b = $('#recBtn');
  b.classList.toggle('recording', !!rec);
  b.setAttribute('aria-label', rec ? 'Stop recording' : 'Record audio');
  $('#playBtn').hidden = !cur || !recs().length;
  $('#playBtn').classList.toggle('on', !!play);
}

/* ---------------- recording ---------------- */
function micHelp(kind) {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const body = kind === 'denied'
    ? `<p>Inkwell isn't allowed to use the microphone.</p><p class="drive-tip">To allow it: open the iPad <b>Settings → Apps → Safari → Microphone</b> and choose <b>Ask</b> or <b>Allow</b>${standalone ? ', then close and reopen Inkwell' : ''}. Your notes aren't affected.</p>`
    : kind === 'nomic' ? '<p>No microphone was found.</p>'
    : kind === 'unsupported' ? '<p>Audio recording isn\'t supported in this browser. On iPad, use Safari or the Home Screen app (iPadOS 14.5 or later).</p>'
    : `<p>The microphone couldn't start (${esc(kind)}). Try again in a moment.</p>`;
  modal({ title: 'Microphone', cls: 'mic-sheet', body, actions: [{ label: 'OK', value: true, kind: 'primary' }] });
}

let wakeLock = null;
async function lockScreen() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } catch { wakeLock = null; }
}

export async function startRecording() {
  const cur = A.current();
  if (!cur || rec) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { micHelp('unsupported'); return; }
  const docId = cur.id, folderId = cur.folderId || null;
  // capture the folder key now: an auto-relock (app backgrounded) mustn't stop us saving an encrypted recording
  let key;
  try { key = await store.folderKeyNow(folderId); } catch (e) { toast('Unlock the folder first'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { micHelp(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : e && e.name === 'NotFoundError' ? 'nomic' : (e && e.name) || 'error'); return; }
  if (A.current()?.id !== docId) { stream.getTracks().forEach((t) => t.stop()); return; }
  const mime = MIMES.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
  let mr;
  try { mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined); }
  catch { mr = new MediaRecorder(stream); }
  const r = { id: store.uid(), docId, folderId, key, stream, mr, chunks: [], t0: performance.now(), startedAt: Date.now(), mime: mr.mimeType || mime || 'audio/mp4' };
  mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
  r.stopped = new Promise((res) => { mr.onstop = res; mr.onerror = res; });
  mr.start(1000);
  rec = r;
  A.editor.recording = { id: r.id, clock: () => performance.now() - r.t0 };
  lockScreen();
  r.timer = setInterval(tick, 250); tick();
  updateButtons();
  toast('Recording — your writing is synced to the audio');
}
function tick() {
  const t = $('#recBtn .rec-time');
  if (t) t.textContent = rec ? fmt(performance.now() - rec.t0) : '';
}

// stops and saves (safe to call any time; resolves when the recording is in IndexedDB)
export async function stopRecording() {
  const r = rec;
  if (!r) return;
  if (r.saving) return r.saving;
  r.saving = (async () => {
    clearInterval(r.timer);
    A.editor.recording = null;
    const dur = Math.round(performance.now() - r.t0);
    try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch {}
    await Promise.race([r.stopped, new Promise((res) => setTimeout(res, 3000))]);
    r.stream.getTracks().forEach((t) => t.stop());
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
    rec = null; tick(); updateButtons();
    const blob = new Blob(r.chunks, { type: r.mime });
    if (!blob.size) { toast('Nothing was recorded'); return; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      await store.saveAudio({ id: r.id, docId: r.docId, folderId: r.folderId, mime: r.mime, bytes }, r.key);
    } catch (e) { console.error(e); toast('Couldn’t save the recording: ' + e.message, 4000); return; }
    const meta = { id: r.id, startedAt: r.startedAt, dur, mime: r.mime, size: bytes.length };
    const cur = A.current();
    if (cur && cur.id === r.docId) { (cur.body.recordings || (cur.body.recordings = [])).push(meta); A.changed(); }
    else await A.addRecordingMeta(r.docId, meta); // note was closed meanwhile
    updateButtons();
    toast(`Recording saved (${fmt(dur)})`);
  })();
  return r.saving;
}

/* ---------------- playback ---------------- */
async function openPlayer(id, atMs) {
  const list = recs();
  if (!list.length) return;
  id = id || (play && play.id) || list[list.length - 1].id;
  const meta = list.find((r) => r.id === id);
  if (!meta) return;
  let data;
  try { data = await store.loadAudio(id); } catch (e) { toast(e.locked ? 'This folder is locked' : 'Couldn’t open the recording'); return; }
  if (!data) { toast('This recording is missing'); return; }
  const wasPlaying = play && !play.audio.paused;
  closePlayer(true);
  const url = URL.createObjectURL(new Blob([data.bytes], { type: data.mime || meta.mime }));
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = url;
  play = { audio, url, id, dur: meta.dur };
  const bar = $('#playBar');
  const i = list.indexOf(meta);
  bar.innerHTML = `<button type="button" class="pb-pick" id="pbPick" aria-label="Recordings">${icon('mic')}<span>${label(meta, i)}</span>${icon('chevDown')}</button>
    <button type="button" class="icon-btn" id="pbBack" aria-label="Back 15 seconds">${icon('back15')}</button>
    <button type="button" class="icon-btn pb-play" id="pbPlay" aria-label="Play">${icon('play')}</button>
    <input type="range" id="pbScrub" min="0" max="${Math.max(1, meta.dur)}" step="100" value="0" aria-label="Position">
    <span class="pb-time" id="pbTime">0:00 / ${fmt(meta.dur)}</span>
    <button type="button" class="icon-btn" id="pbClose" aria-label="Close player">${icon('x')}</button>`;
  bar.hidden = false;
  $('#editor').classList.add('has-player');
  A.editor.setPlayback({ rec: id, recs: new Set(list.map((r) => r.id)), t: 0 });
  $('#pbPlay').addEventListener('click', () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
  $('#pbBack').addEventListener('click', () => seek(audio.currentTime * 1000 - 15000));
  $('#pbClose').addEventListener('click', () => closePlayer());
  $('#pbPick').addEventListener('click', (e) => recordingsMenu(e.currentTarget));
  const scrub = $('#pbScrub');
  scrub.addEventListener('input', () => seek(+scrub.value));
  const sync = () => {
    if (!play || play.audio !== audio) return;
    const ms = audio.currentTime * 1000;
    if (document.activeElement !== scrub || !audio.paused) scrub.value = ms;
    $('#pbTime').textContent = `${fmt(ms)} / ${fmt(meta.dur)}`;
    A.editor.setPlayhead(ms);
  };
  const loop = () => { sync(); if (play && play.audio === audio && !audio.paused) play.raf = requestAnimationFrame(loop); };
  audio.addEventListener('play', () => { $('#pbPlay').innerHTML = icon('pause'); $('#pbPlay').setAttribute('aria-label', 'Pause'); loop(); });
  audio.addEventListener('pause', () => { $('#pbPlay').innerHTML = icon('play'); $('#pbPlay').setAttribute('aria-label', 'Play'); sync(); });
  audio.addEventListener('ended', sync);
  audio.addEventListener('seeked', sync);
  play.sync = sync;
  if (atMs != null) { seek(atMs); audio.play().catch(() => {}); }
  else if (wasPlaying) audio.play().catch(() => {});
  updateButtons();
}
function seek(ms) {
  if (!play) return;
  ms = Math.max(0, Math.min(play.dur, ms));
  try { play.audio.currentTime = ms / 1000; } catch {}
  $('#pbScrub').value = ms;
  $('#pbTime').textContent = `${fmt(ms)} / ${fmt(play.dur)}`;
  A.editor.setPlayhead(ms);
}
export function closePlayer(keepBar) {
  if (play) {
    cancelAnimationFrame(play.raf);
    try { play.audio.pause(); } catch {}
    play.audio.removeAttribute('src'); try { play.audio.load(); } catch {}
    URL.revokeObjectURL(play.url);
    play = null;
  }
  if (!keepBar) {
    const bar = $('#playBar'); bar.hidden = true; bar.innerHTML = '';
    $('#editor').classList.remove('has-player');
    A.editor.setPlayback(null);
  }
  updateButtons();
}
async function seekToStroke(st) {
  const ms = Math.max(0, st.at - 500); // a moment before the stroke began
  if (play && play.id === st.rec) { seek(ms); play.audio.play().catch(() => {}); }
  else await openPlayer(st.rec, ms);
}

function recordingsMenu(anchor) {
  const list = recs();
  const pop = h(`<div class="rec-list"><div class="pop-title">Recordings</div>${list.map((r, i) => `
    <div class="rec-row ${play && play.id === r.id ? 'on' : ''}" data-id="${r.id}">
      <button type="button" class="rec-open" data-act="open"><b>${label(r, i)}</b><small>${new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${fmt(r.dur)}${r.unsynced ? ' · not synced to ink' : ''}</small></button>
      <button type="button" class="icon-btn" data-act="export" aria-label="Export recording">${icon('share')}</button>
      <button type="button" class="icon-btn danger-txt" data-act="delete" aria-label="Delete recording">${icon('trash')}</button>
    </div>`).join('')}</div>`);
  const opened = popover(anchor, pop, { align: 'start', width: 320 });
  opened.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'), row = e.target.closest('.rec-row');
    if (!b || !row) return;
    const id = row.dataset.id, i = list.findIndex((r) => r.id === id);
    if (b.dataset.act === 'open') { document.querySelector('.pop-back')?.dispatchEvent(new PointerEvent('pointerdown')); openPlayer(id); }
    if (b.dataset.act === 'export') exportRecording(id, i);
    if (b.dataset.act === 'delete') {
      document.querySelector('.pop-back')?.dispatchEvent(new PointerEvent('pointerdown'));
      if (!(await confirmDialog('Delete recording?', `${label(list[i], i)} (${fmt(list[i].dur)}) will be deleted. Your ink stays.`))) return;
      await deleteRecording(id);
    }
  });
}
export async function deleteRecording(id) {
  const cur = A.current();
  if (!cur) return;
  if (play && play.id === id) closePlayer();
  await store.deleteAudio(id);
  cur.body.recordings = recs().filter((r) => r.id !== id);
  A.changed();
  if (play) A.editor.setPlayback({ rec: play.id, recs: new Set(recs().map((r) => r.id)), t: play.audio.currentTime * 1000 });
  updateButtons();
  toast('Recording deleted');
}
async function exportRecording(id, i) {
  try {
    const d = await store.loadAudio(id);
    if (!d) return toast('This recording is missing');
    const title = (A.current()?.meta.title || 'Note').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
    await A.deliverFile(new Blob([d.bytes], { type: d.mime }), `${title} - recording ${i + 1}.${ext(d.mime)}`);
  } catch (e) { toast('Export failed: ' + e.message); }
}
export const _test = { get rec() { return rec; }, get play() { return play; }, openPlayer, seek, seekToStroke };
