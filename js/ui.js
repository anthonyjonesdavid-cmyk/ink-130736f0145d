// Small UI kit: modal dialogs, popovers, toasts.
import { icon } from './icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer;
export function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// modal({title, body: html|Element, actions:[{label, value, kind}], onOpen(el, close), dismissable})
export function modal({ title, body = '', actions = [{ label: 'OK', value: true, kind: 'primary' }], onOpen, dismissable = true, cls = '' }) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    const wrap = h(`<div class="modal-back"><div class="modal ${cls}" role="dialog" aria-modal="true">
      ${title ? `<div class="modal-head"><h2>${esc(title)}</h2>${dismissable ? `<button class="icon-btn sm modal-x" aria-label="Close">${icon('x')}</button>` : ''}</div>` : ''}
      <div class="modal-body"></div>
      ${actions.length ? `<div class="modal-actions"></div>` : ''}
    </div></div>`);
    const bodyEl = $('.modal-body', wrap);
    if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
    let done = false;
    const close = (v) => {
      if (done) return; done = true;
      wrap.classList.remove('show');
      setTimeout(() => wrap.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(null); };
    document.addEventListener('keydown', onKey);
    const acts = $('.modal-actions', wrap);
    for (const a of actions) {
      const b = h(`<button class="btn ${a.kind || 'secondary'}">${esc(a.label)}</button>`);
      b.addEventListener('click', async () => {
        if (a.validate) { const ok = await a.validate(wrap, b); if (!ok) return; }
        close(typeof a.value === 'function' ? a.value(wrap) : a.value);
      });
      acts.appendChild(b);
    }
    if (dismissable) {
      wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(null); });
      $('.modal-x', wrap)?.addEventListener('click', () => close(null));
    }
    root.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('show'));
    onOpen?.(wrap, close);
  });
}

export async function promptText(title, value = '', { placeholder = '', okLabel = 'Save' } = {}) {
  let input;
  const r = await modal({
    title,
    body: `<input class="field" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="120">`,
    actions: [{ label: 'Cancel', value: null }, { label: okLabel, value: (w) => $('input', w).value.trim(), kind: 'primary' }],
    onOpen: (w, close) => {
      input = $('input', w);
      setTimeout(() => { input.focus(); input.select(); }, 60);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value.trim()); });
    },
  });
  return r || null;
}

export function confirmDialog(title, text, okLabel = 'Delete', kind = 'danger') {
  return modal({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, kind }] });
}

// popover anchored to an element. items: [{label, icon, onClick, danger, checked}] or content Element
let openPop = null;
export function closePopover() { if (openPop) { openPop(); openPop = null; } }
export function popover(anchor, content, { align = 'end', width } = {}) {
  closePopover();
  const back = h('<div class="pop-back"></div>');
  const pop = h('<div class="popover"></div>');
  if (width) pop.style.width = width + 'px';
  if (Array.isArray(content)) {
    const list = h('<div class="menu"></div>');
    for (const it of content) {
      if (it === '-') { list.appendChild(h('<div class="menu-sep"></div>')); continue; }
      const b = h(`<button class="menu-item ${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.checked != null ? `<span class="menu-check ${it.checked ? 'on' : ''}">${icon('check')}</span>` : ''}</button>`);
      b.addEventListener('click', () => { closePopover(); it.onClick?.(); });
      list.appendChild(b);
    }
    pop.appendChild(list);
  } else pop.appendChild(content);
  document.body.append(back, pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = align === 'start' ? r.left : align === 'center' ? r.left + r.width / 2 - pw / 2 : r.right - pw;
  left = Math.max(10, Math.min(vw - pw - 10, left));
  let top = r.bottom + 8;
  const minTop = (document.getElementById('topBand')?.offsetHeight || 0) + 10;
  if (top + ph > vh - 10) top = Math.max(minTop, r.top - ph - 8);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  requestAnimationFrame(() => pop.classList.add('show'));
  const close = () => { back.remove(); pop.remove(); };
  back.addEventListener('pointerdown', (e) => { e.preventDefault(); closePopover(); });
  openPop = close;
  return pop;
}
