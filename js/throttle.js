// Escalating lockout after wrong passcodes, persisted in localStorage so a reload doesn't reset it.
// 1-4 wrong: no wait. 5th wrong: 30 s, then 1 min, 2 min, 4 min, 8 min, ... capped at 1 hour.
const K = (id) => 'inkwell.unlock.' + id;
export const FREE_TRIES = 5;

export function state(id) {
  try { return { fails: 0, until: 0, ...JSON.parse(localStorage.getItem(K(id)) || '{}') }; }
  catch { return { fails: 0, until: 0 }; }
}
export function remainingMs(id) { return Math.max(0, state(id).until - Date.now()); }
export function delayFor(fails) { return fails < FREE_TRIES ? 0 : Math.min(3600, 30 * 2 ** (fails - FREE_TRIES)) * 1000; }
export function recordFailure(id) {
  const s = state(id);
  s.fails += 1;
  const d = delayFor(s.fails);
  s.until = d ? Date.now() + d : 0;
  try { localStorage.setItem(K(id), JSON.stringify(s)); } catch {}
  return s;
}
export function recordSuccess(id) { try { localStorage.removeItem(K(id)); } catch {} }
export function triesLeft(id) { return Math.max(0, FREE_TRIES - state(id).fails); }
export function fmtWait(ms) {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}
