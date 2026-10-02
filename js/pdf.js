// pdf.js (vendored, legacy build for wider Safari support). No network/CDN at runtime.
import * as pdfjsLib from '../vendor/pdfjs.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs.worker.min.js', import.meta.url).href;
const base = new URL('../vendor/', import.meta.url).href;

export async function openPdf(bytes) {
  // pdf.js transfers the buffer to its worker, so give it a copy and keep the original.
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    isEvalSupported: false,
    enableXfa: false,
  });
  return task.promise;
}

export async function pageSizes(pdfDoc) {
  const out = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const pg = await pdfDoc.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    out.push({ w: vp.width, h: vp.height });
  }
  return out;
}
