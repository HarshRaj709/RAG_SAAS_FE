/** Utils: dates, bytes, clipboard, uuid, debounce, escape */
export function escapeHtml(s = '') { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function formatBytes(n = 0) { if (!n) return '—'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(1)} ${u[i]}`; }
export function formatDate(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
export function timeAgo(iso) { if (!iso) return '—'; const s = (Date.now() - new Date(iso)) / 1e3; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; }
export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export async function copyText(t) { try { await navigator.clipboard.writeText(t); return true; } catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); return true; } catch { return false; } finally { ta.remove(); } } }
export function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
export function initials(name = '?') { return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
export const qp = (k, d = '') => new URLSearchParams(location.search).get(k) ?? d;
/** Normalize a user-entered site into a bare hostname (no protocol/path/port). Returns '' if empty. */
export function normalizeDomain(raw = '') {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, ''); // strip scheme
  s = s.split('/')[0].split('?')[0].split('#')[0]; // strip path/query
  s = s.split('@').pop(); // strip userinfo
  s = s.split(':')[0]; // strip port
  s = s.replace(/^\.+|\.+$/g, '');
  return s;
}
/** Bare-hostname validation: e.g. example.com, sub.example.co.uk, localhost. No scheme/path. */
export function isValidDomain(d = '') {
  if (d === 'localhost') return true;
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,}$/.test(d);
}
