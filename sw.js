// Offline support: precache the whole app shell (incl. vendored pdf.js / pdf-lib / fonts).
// deploy.sh stamps VERSION with a content hash so every deploy refreshes the cache.
const VERSION = 'inkwell-dark-ui-1';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'js/app.js', 'js/editor.js', 'js/store.js', 'js/db.js', 'js/crypto.js', 'js/render.js', 'js/pdf.js',
  'js/exportpdf.js', 'js/ui.js', 'js/icons.js', 'js/pin.js', 'js/throttle.js', 'js/drive.js',
  'vendor/pdfjs.min.js', 'vendor/pdfjs.worker.min.js', 'vendor/pdf-lib.esm.min.js', 'vendor/perfect-freehand.js', 'vendor/paper-grain.webp', 'vendor/paper-mottle.webp',
  'vendor/standard_fonts/FoxitDingbats.pfb', 'vendor/standard_fonts/FoxitFixed.pfb', 'vendor/standard_fonts/FoxitFixedBold.pfb',
  'vendor/standard_fonts/FoxitFixedBoldItalic.pfb', 'vendor/standard_fonts/FoxitFixedItalic.pfb', 'vendor/standard_fonts/FoxitSerif.pfb',
  'vendor/standard_fonts/FoxitSerifBold.pfb', 'vendor/standard_fonts/FoxitSerifBoldItalic.pfb', 'vendor/standard_fonts/FoxitSerifItalic.pfb',
  'vendor/standard_fonts/FoxitSymbol.pfb', 'vendor/standard_fonts/LiberationSans-Bold.ttf', 'vendor/standard_fonts/LiberationSans-BoldItalic.ttf',
  'vendor/standard_fonts/LiberationSans-Italic.ttf', 'vendor/standard_fonts/LiberationSans-Regular.ttf',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('inkwell-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then((r) => r || fetch(req)).catch(() => fetch(req)));
    return;
  }
  // cache-first; anything else same-origin (e.g. pdf.js CMaps) is cached on first use
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
