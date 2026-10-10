// Offline support with a network-first app shell so a reload picks up UI updates.
// Static vendor files stay cache-first.
const VERSION = 'inkwell-8c874711486e';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'sw.js',
  'js/app.js', 'js/editor.js', 'js/store.js', 'js/db.js', 'js/crypto.js', 'js/render.js', 'js/pdf.js',
  'js/exportpdf.js', 'js/ui.js', 'js/icons.js', 'js/pin.js', 'js/throttle.js', 'js/drive.js', 'js/audio.js', 'js/backup.js', 'js/trim.js', 'js/unzip.js', 'js/notability.js', 'js/dates.js',
];
const ASSETS = [
  ...SHELL,
  'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'vendor/pdfjs.min.js', 'vendor/pdfjs.worker.min.js', 'vendor/pdf-lib.esm.min.js', 'vendor/perfect-freehand.js', 'vendor/paper-grain.webp', 'vendor/paper-mottle.webp',
  'vendor/standard_fonts/FoxitDingbats.pfb', 'vendor/standard_fonts/FoxitFixed.pfb', 'vendor/standard_fonts/FoxitFixedBold.pfb',
  'vendor/standard_fonts/FoxitFixedBoldItalic.pfb', 'vendor/standard_fonts/FoxitFixedItalic.pfb', 'vendor/standard_fonts/FoxitSerif.pfb',
  'vendor/standard_fonts/FoxitSerifBold.pfb', 'vendor/standard_fonts/FoxitSerifBoldItalic.pfb', 'vendor/standard_fonts/FoxitSerifItalic.pfb',
  'vendor/standard_fonts/FoxitSymbol.pfb', 'vendor/standard_fonts/LiberationSans-Bold.ttf', 'vendor/standard_fonts/LiberationSans-BoldItalic.ttf',
  'vendor/standard_fonts/LiberationSans-Italic.ttf', 'vendor/standard_fonts/LiberationSans-Regular.ttf',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    // cache: 'reload' skips the browser's HTTP cache so a new build never mixes with old files
    await Promise.all(ASSETS.map((path) => c.add(new Request(path, { cache: 'reload' })).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('inkwell-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isShell(url) {
  if (url.origin !== location.origin) return false;
  const path = url.pathname.replace(/\/$/, '');
  const base = location.pathname.replace(/\/sw\.js$/, '').replace(/\/$/, '');
  const rel = path.startsWith(base) ? path.slice(base.length).replace(/^\//, '') : path;
  return rel === '' || SHELL.some((s) => s.replace(/^\.\//, '') === rel);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate' || isShell(url)) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
