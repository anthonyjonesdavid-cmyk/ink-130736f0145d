// Minimal promise wrapper around IndexedDB.
const DB_NAME = 'inkwell';
const VERSION = 1;
export const STORES = ['folders', 'docs', 'content', 'files'];
let dbp = null;

export function openDB() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbp = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database blocked by another tab'));
    });
  }
  return dbp;
}

function reqP(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function run(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch {} reject(e); });
  });
}

export const get = (store, id) => run([store], 'readonly', (t) => reqP(t.objectStore(store).get(id)));
export const getAll = (store) => run([store], 'readonly', (t) => reqP(t.objectStore(store).getAll()));
export const put = (store, val) => run([store], 'readwrite', (t) => { t.objectStore(store).put(val); });
export const del = (store, id) => run([store], 'readwrite', (t) => { t.objectStore(store).delete(id); });

// ops: [{store, put: value} | {store, del: id}] in one atomic transaction
export function batch(ops) {
  const stores = [...new Set(ops.map((o) => o.store))];
  if (!stores.length) return Promise.resolve();
  return run(stores, 'readwrite', (t) => {
    for (const o of ops) {
      const s = t.objectStore(o.store);
      if ('put' in o) s.put(o.put); else s.delete(o.del);
    }
  });
}
