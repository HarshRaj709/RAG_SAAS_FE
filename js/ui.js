import { escapeHtml } from './utils.js';
/** Toasts, modals, confirm dialogs, skeletons, empty states. */
export function toast(msg, type = 'info', ms = 4200) {
  const stack = document.getElementById('toast-stack') || (() => { const d = document.createElement('div'); d.id = 'toast-stack'; d.setAttribute('role', 'status'); document.body.appendChild(d); return d; })();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${escapeHtml(msg)}</span><button aria-label="Dismiss">✕</button>`;
  el.querySelector('button').onclick = () => el.remove();
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, ms);
}
let lastFocus = null;
export function openModal(html, { wide = false } = {}) {
  lastFocus = document.activeElement;
  let bd = document.getElementById('modal-root');
  if (!bd) { bd = document.createElement('div'); bd.id = 'modal-root'; bd.className = 'modal-backdrop'; document.body.appendChild(bd); }
  bd.innerHTML = `<div class="modal ${wide ? 'modal-lg' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  bd.classList.add('open');
  const modal = bd.firstElementChild;
  const close = () => closeModal();
  bd.onclick = (e) => { if (e.target === bd) close(); };
  modal.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  const f = modal.querySelector('input,select,textarea,button:not([data-close])'); f?.focus();
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...modal.querySelectorAll('button,input,select,textarea,a[href]')].filter(x => !x.disabled);
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });
  return { el: modal, close };
}
export function closeModal() {
  const bd = document.getElementById('modal-root');
  if (bd) { bd.classList.remove('open'); bd.innerHTML = ''; }
  lastFocus?.focus?.();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
export function confirmDialog({ title, body, confirmText = 'Delete', requireText = null }) {
  return new Promise((resolve) => {
    const { el, close } = openModal(`
      <div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="modal-body"><p class="muted">${body}</p>
      ${requireText ? `<div class="field mt2"><label>Type <span class="mono">${escapeHtml(requireText)}</span> to confirm</label><input id="cf-input" autocomplete="off" placeholder="${escapeHtml(requireText)}"></div>` : ''}
      </div>
      <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-danger" id="cf-ok" ${requireText ? 'disabled' : ''}>${escapeHtml(confirmText)}</button></div>`);
    const ok = el.querySelector('#cf-ok');
    if (requireText) el.querySelector('#cf-input').oninput = (e) => { ok.disabled = e.target.value.trim() !== requireText; };
    ok.onclick = () => { close(); resolve(true); };
    el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => resolve(false), { once: true }));
  });
}
export function skeletonList(n = 3) {
  return Array.from({ length: n }, () => `<div class="card"><div class="skeleton" style="height:18px;width:45%"></div><div class="skeleton mt1" style="height:13px;width:80%"></div><div class="skeleton mt1" style="height:13px;width:60%"></div></div>`).join('');
}
export function emptyState(icon, title, sub, cta = '') {
  return `<div class="empty card"><div class="empty-icon">${icon}</div><h3 style="color:var(--text)">${title}</h3><p class="mt1">${sub}</p><div class="mt2">${cta}</div></div>`;
}
export function setFieldError(form, err) {
  form.querySelectorAll('.field').forEach(f => f.classList.remove('invalid'));
  if (err?.fields) for (const [k, v] of Object.entries(err.fields)) {
    const inp = form.querySelector(`[name="${CSS.escape(k)}"]`);
    if (inp) { const f = inp.closest('.field'); f?.classList.add('invalid'); const e = f?.querySelector('.error'); if (e) e.textContent = v; }
  }
}
export async function copyTextFallback(t) {
  try { await navigator.clipboard.writeText(t); } catch { /* noop */ }
}
export function withLoading(btn, fn) {  return async (...a) => {
    const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Working…`;
    try { return await fn(...a); } finally { btn.disabled = false; btn.innerHTML = orig; }
  };
}
