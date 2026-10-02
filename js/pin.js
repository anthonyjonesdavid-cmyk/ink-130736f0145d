// Passcode entry: 4 dots + big on-screen keypad. The dots are also a real
// <input inputmode="numeric"> so the iPad number keyboard / a hardware keyboard work too.
import { h, esc } from './ui.js';

export function createPinPad({ length = 4, label = 'Enter passcode', onComplete, compact = false } = {}) {
  const el = h(`<div class="pinpad ${compact ? 'compact' : ''}">
    <div class="pin-label">${esc(label)}</div>
    <label class="pin-dots">${'<span class="dot"></span>'.repeat(length)}
      <input class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="${length}" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Passcode">
    </label>
    <div class="keypad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" class="key" data-k="${n}">${n}</button>`).join('')}
      <span></span><button type="button" class="key" data-k="0">0</button>
      <button type="button" class="key fn" data-k="del" aria-label="Delete"><svg viewBox="0 0 24 24" class="ic" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H10l-7-7z"/><path d="m12 9 6 6"/><path d="m18 9-6 6"/></svg></button>
    </div>
  </div>`);
  const input = el.querySelector('.pin-input');
  const dots = [...el.querySelectorAll('.dot')];
  let disabled = false, busy = false;

  const render = () => dots.forEach((d, i) => d.classList.toggle('on', i < input.value.length));
  const check = () => {
    render();
    if (input.value.length === length && !busy) {
      busy = true;
      const v = input.value;
      setTimeout(async () => { try { await onComplete?.(v); } finally { busy = false; } }, 140);
    }
  };
  const press = (k) => {
    if (disabled || busy) return;
    if (k === 'del') input.value = input.value.slice(0, -1);
    else if (input.value.length < length) input.value += k;
    check();
  };
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, length); if (disabled) input.value = ''; check(); });
  input.addEventListener('keydown', (e) => { e.stopPropagation(); });
  el.querySelector('.keypad').addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (b) press(b.dataset.k);
  });
  // hardware keyboard when the input isn't focused
  const onKey = (e) => {
    if (!el.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (document.activeElement === input || (document.activeElement && document.activeElement.matches('input,textarea'))) return;
    if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { press('del'); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);

  return {
    el,
    input,
    clear() { input.value = ''; render(); },
    shake() { const d = el.querySelector('.pin-dots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); },
    setLabel(t, cls = '') { const l = el.querySelector('.pin-label'); l.textContent = t; l.className = 'pin-label ' + cls; },
    setDisabled(v) { disabled = v; el.classList.toggle('disabled', v); if (v) { input.value = ''; render(); input.blur(); } },
  };
}
