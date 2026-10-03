// Data layer. Everything inside a password-protected folder (document metadata + titles,
// page/annotation data, PDF bytes, thumbnails) is AES-GCM encrypted before it touches IndexedDB.
import * as db from './db.js';
import * as C from './crypto.js';

const te = new TextEncoder();
const keys = new Map(); // folderId -> CryptoKey (memory only)
const aad = (kind, id) => te.encode(`inkwell:${kind}:${id}`);

export class LockedError extends Error { constructor() { super('This folder is locked'); this.locked = true; } }

export function uid() {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- folders ---------- */
export async function listFolders() {
  return (await db.getAll('folders')).sort((a, b) => a.createdAt - b.createdAt);
}
export const getFolder = (id) => (id ? db.get('folders', id) : Promise.resolve(null));

// kind: 'pin' (digits) or 'password' — only a UI hint for which entry pad to show.
export async function createFolder(name, password, kind = 'password') {
  const f = { id: uid(), name, createdAt: Date.now(), locked: !!password };
  if (password) {
    f.secretKind = kind === 'pin' ? 'pin' : 'password';
    f.kdf = 'PBKDF2-SHA256';
    f.iterations = C.PBKDF2_ITERATIONS;
    f.salt = C.randomBytes(16);
    const key = await C.deriveKey(password, f.salt, f.iterations);
    f.verifier = await C.encryptJSON(key, { check: 'inkwell-folder', id: f.id }, aad('verify', f.id));
    keys.set(f.id, key);
  }
  await db.put('folders', f);
  return f;
}

export async function renameFolder(id, name) {
  const f = await db.get('folders', id);
  f.name = name;
  await db.put('folders', f);
}

export async function unlockFolder(id, password) {
  const f = await db.get('folders', id);
  if (!f || !f.locked) return;
  const key = await C.deriveKey(password, f.salt, f.iterations);
  try {
    const v = await C.decryptJSON(key, f.verifier, aad('verify', id));
    if (v.check !== 'inkwell-folder') throw new Error();
  } catch {
    throw new Error('Wrong password');
  }
  keys.set(id, key);
}

export const isUnlocked = (id) => keys.has(id);
export const lockFolder = (id) => keys.delete(id);
export const lockAll = () => keys.clear();
export const unlockedIds = () => [...keys.keys()];

function keyForFolderId(folderId, folderLocked) {
  if (!folderLocked) return null;
  const k = keys.get(folderId);
  if (!k) throw new LockedError();
  return k;
}
async function folderKey(folderId) {
  if (!folderId) return null;
  const f = await db.get('folders', folderId);
  return keyForFolderId(folderId, f && f.locked);
}

export async function deleteFolder(id) {
  const f = await db.get('folders', id);
  if (f && f.locked && !keys.has(id)) throw new LockedError();
  const docs = (await db.getAll('docs')).filter((d) => d.folderId === id);
  const ops = [{ store: 'folders', del: id }];
  for (const d of docs) for (const s of ['docs', 'content', 'files']) ops.push({ store: s, del: d.id });
  await db.batch(ops);
  keys.delete(id);
}

/* ---------- sealing helpers ---------- */
async function sealJSON(key, kind, id, folderId, obj) {
  if (!key) return { id, folderId, enc: false, data: obj };
  return { id, folderId, enc: true, box: await C.encryptJSON(key, obj, aad(kind, id)) };
}
async function openJSON(rec, kind) {
  if (!rec.enc) return rec.data;
  const k = keys.get(rec.folderId);
  if (!k) throw new LockedError();
  return C.decryptJSON(k, rec.box, aad(kind, rec.id));
}

/* ---------- documents ---------- */
// docs store:    {id, folderId, enc, data: meta | box}   meta = {title, kind, paper, createdAt, updatedAt, pageCount, thumb}
// content store: {id, folderId, enc, data: body | box}   body = {pages: [...]}
// files store:   {id, folderId, enc, bytes | box}        original PDF bytes
export async function listDocs(folderId) {
  const recs = (await db.getAll('docs')).filter((d) => (d.folderId || null) === (folderId || null));
  const out = [];
  for (const r of recs) out.push({ id: r.id, folderId: r.folderId || null, ...(await openJSON(r, 'meta')) });
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function countDocs() {
  const counts = {};
  for (const r of await db.getAll('docs')) counts[r.folderId || 'root'] = (counts[r.folderId || 'root'] || 0) + 1;
  return counts;
}

export async function loadDoc(id) {
  const [rec, crec] = await Promise.all([db.get('docs', id), db.get('content', id)]);
  if (!rec) throw new Error('Note not found');
  const meta = await openJSON(rec, 'meta');
  const body = await openJSON(crec, 'body');
  return { id, folderId: rec.folderId || null, encrypted: !!rec.enc, meta, body };
}

export async function loadPdf(id) {
  const rec = await db.get('files', id);
  if (!rec) return null;
  if (!rec.enc) return rec.bytes;
  const k = keys.get(rec.folderId);
  if (!k) throw new LockedError();
  return C.decryptBytes(k, rec.box, aad('file', id));
}

export async function saveDoc(doc, { pdfBytes } = {}) {
  const key = await folderKey(doc.folderId);
  const ops = [
    { store: 'docs', put: await sealJSON(key, 'meta', doc.id, doc.folderId, doc.meta) },
    { store: 'content', put: await sealJSON(key, 'body', doc.id, doc.folderId, doc.body) },
  ];
  if (pdfBytes) {
    const rec = key
      ? { id: doc.id, folderId: doc.folderId, enc: true, box: await C.encryptBytes(key, pdfBytes, aad('file', doc.id)) }
      : { id: doc.id, folderId: doc.folderId, enc: false, bytes: pdfBytes };
    ops.push({ store: 'files', put: rec });
  }
  await db.batch(ops);
}

export async function saveMeta(id, folderId, meta) {
  const key = await folderKey(folderId);
  await db.put('docs', await sealJSON(key, 'meta', id, folderId, meta));
}

export async function deleteDoc(id) {
  await db.batch(['docs', 'content', 'files'].map((s) => ({ store: s, del: id })));
}

// Re-encrypts (or decrypts) as needed. Both folders must be unlocked.
export async function moveDoc(id, toFolderId) {
  const src = await db.get('docs', id);
  if (!src) throw new Error('Note not found');
  const from = src.folderId || null, to = toFolderId || null;
  await rewriteDoc(id, to, { srcKey: await keyFor(from), dstKey: await keyFor(to) });
}

/* ---------- crash-safe rewrite (move / encrypt in place) ----------
   One note = up to three records with the same id (docs, content, files). A rewrite:
     1. reads the current records and decrypts them to plaintext (source key if they're encrypted),
     2. builds the new records (sealed with the destination key, or plain) and verifies them IN MEMORY
        by decrypting each one and comparing it with the plaintext,
     3. replaces all three in ONE IndexedDB transaction (atomic: after a crash either the old or the new copy exists),
     4. reads them back and verifies again; on any mismatch the original records are written back.
   Records that are already in the target form are left untouched. */
export const hooks = {}; // test-only fault injection: { failVerify, crashAfter, delayMs }
const KINDS = [['docs', 'meta'], ['content', 'body'], ['files', 'file']];
async function keyFor(folderId) {
  if (!folderId) return null;
  const f = await db.get('folders', folderId);
  if (!f || !f.locked) return null;
  const k = keys.get(folderId);
  if (!k) throw new LockedError();
  return k;
}
const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
function sameBytes(a, b) {
  a = toU8(a); b = toU8(b);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
async function plainOf(rec, kind, key) {
  if (!rec.enc) return kind === 'file' ? toU8(rec.bytes) : rec.data;
  if (!key) throw new LockedError();
  return kind === 'file' ? C.decryptBytes(key, rec.box, aad('file', rec.id)) : C.decryptJSON(key, rec.box, aad(kind, rec.id));
}
async function sealAs(kind, id, folderId, plain, key) {
  if (kind === 'file') return key ? { id, folderId, enc: true, box: await C.encryptBytes(key, plain, aad('file', id)) } : { id, folderId, enc: false, bytes: plain };
  return sealJSON(key, kind, id, folderId, plain);
}
async function matches(rec, kind, key, plain) {
  try {
    const got = await plainOf(rec, kind, key);
    return kind === 'file' ? sameBytes(got, plain) : JSON.stringify(got) === JSON.stringify(plain);
  } catch { return false; }
}
async function rewriteDoc(id, toFolderId, { srcKey, dstKey }) {
  const olds = await Promise.all(KINDS.map(([st]) => db.get(st, id)));
  if (!olds[0]) throw new Error('Note not found');
  const plan = [];
  for (let i = 0; i < KINDS.length; i++) {
    const [st, kind] = KINDS[i], old = olds[i];
    if (!old) continue;
    const already = (old.folderId || null) === (toFolderId || null) && !!old.enc === !!dstKey;
    if (already) continue;
    const plain = await plainOf(old, kind, srcKey);
    const rec = await sealAs(kind, id, toFolderId, plain, dstKey);
    if (!(await matches(rec, kind, dstKey, plain))) throw new Error('Encryption check failed; nothing was changed');
    plan.push({ st, kind, old, rec, plain });
  }
  if (!plan.length) return false;
  await db.batch(plan.map((p) => ({ store: p.st, put: p.rec })));
  let ok = true;
  for (const p of plan) {
    const back = await db.get(p.st, id);
    if (hooks.failVerify || !back || !(await matches(back, p.kind, dstKey, p.plain))) { ok = false; break; }
  }
  if (!ok) {
    await db.batch(plan.map((p) => ({ store: p.st, put: p.old })));
    throw new Error('Couldn’t verify the new copy; the note was left as it was');
  }
  return true;
}

/* ---------- encrypt an existing folder ----------
   lockExistingFolder() first stores the folder's key material with  encrypting: true  (the folder now behaves
   as locked), then encrypts its notes one by one. Plaintext records stay until their encrypted copy is verified.
   If the app is closed half-way, the flag stays set; the next unlock calls finishEncryption() to resume. */
export async function lockExistingFolder(id, password, kind = 'pin') {
  const f = await db.get('folders', id);
  if (!f) throw new Error('Folder not found');
  if (f.locked) throw new Error('This folder is already locked');
  const salt = C.randomBytes(16);
  const key = await C.deriveKey(password, salt, C.PBKDF2_ITERATIONS);
  Object.assign(f, {
    locked: true, encrypting: true, secretKind: kind === 'pin' ? 'pin' : 'password', kdf: 'PBKDF2-SHA256',
    iterations: C.PBKDF2_ITERATIONS, salt, verifier: await C.encryptJSON(key, { check: 'inkwell-folder', id }, aad('verify', id)),
  });
  // sanity: the stored verifier must open with this key before we rely on it
  const v = await C.decryptJSON(key, f.verifier, aad('verify', id));
  if (v.check !== 'inkwell-folder') throw new Error('Encryption check failed');
  await db.put('folders', f);
  keys.set(id, key);
}
export async function pendingEncryption(id) {
  const docs = (await db.getAll('docs')).filter((d) => d.folderId === id);
  const ids = [];
  for (const d of docs) {
    const recs = await Promise.all(KINDS.map(([st]) => db.get(st, d.id)));
    if (recs.some((r) => r && !r.enc)) ids.push(d.id);
  }
  return ids;
}
export async function finishEncryption(id, onProgress) {
  const key = keys.get(id); // captured: an auto-relock (app backgrounded) mustn't stop a half-done encryption
  if (!key) throw new LockedError();
  const todo = await pendingEncryption(id);
  let done = 0;
  onProgress?.(0, todo.length);
  for (const docId of todo) {
    if (hooks.crashAfter != null && done >= hooks.crashAfter) throw new Error('simulated crash');
    if (hooks.delayMs) await new Promise((r) => setTimeout(r, hooks.delayMs));
    await rewriteDoc(docId, id, { srcKey: null, dstKey: key });
    onProgress?.(++done, todo.length);
  }
  const f = await db.get('folders', id);
  if (f && f.encrypting && !(await pendingEncryption(id)).length) { delete f.encrypting; await db.put('folders', f); }
  return done;
}

/* ---------- batch helpers ---------- */
// moves one note with keys captured up front (so an auto-relock mid-batch doesn't strand it)
export async function moveDocWithKeys(id, toFolderId, srcKey, dstKey) {
  return rewriteDoc(id, toFolderId || null, { srcKey, dstKey });
}
export const folderKeyNow = keyFor;

/* ---------- backup ---------- */
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function exportBackup() {
  const data = { format: 'inkwell-backup', version: 1, exportedAt: new Date().toISOString() };
  for (const s of db.STORES) data[s] = await db.getAll(s);
  return JSON.stringify(data, (k, v) => (v instanceof Uint8Array ? { $b64: b64(v) } : v instanceof ArrayBuffer ? { $b64: b64(new Uint8Array(v)) } : v));
}

export async function importBackup(text) {
  let data;
  try {
    data = JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.$b64 === 'string' ? unb64(v.$b64) : v));
  } catch { throw new Error('That file is not an Inkwell backup.'); }
  if (!data || data.format !== 'inkwell-backup') throw new Error('That file is not an Inkwell backup.');
  const ops = [];
  for (const s of db.STORES) for (const rec of data[s] || []) if (rec && rec.id) ops.push({ store: s, put: rec });
  await db.batch(ops);
  return { folders: (data.folders || []).length, docs: (data.docs || []).length };
}
