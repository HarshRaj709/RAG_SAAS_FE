import { store } from '../state.js';
import { loadOrgs } from '../router-guard.js';
import { logout } from '../auth.js';
import { initials } from '../utils.js';

const NAV = [
  ['dashboard.html', 'Dashboard', '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'],
  ['knowledge-bases.html', 'Knowledge Bases', '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'],
  ['bots.html', 'Bots', '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/><path d="M9 17h6"/>'],
  ['members.html', 'Members', '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 15.2c2.6.3 4.7 1.8 5.5 4.8"/>'],
  ['settings.html', 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1z"/>'],
];
const icon = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

export async function mountShell(active) {
  const page = (active || location.pathname.split('/').pop() || 'dashboard.html');
  let holder = document.getElementById('app-shell');
  if (!holder) { holder = document.createElement('div'); holder.id = 'app-shell'; holder.className = 'app-shell'; document.body.prepend(holder); }
  const user = store.getUser() || { name: 'User', email: '', role: 'member' };
  holder.innerHTML = `
    <aside class="sidebar" id="sidebar" aria-label="Primary">
      <div class="brand"><img src="assets/logo.svg" alt="" width="28" height="28"><span>RAG SaaS</span></div>
      <nav>${NAV.map(([h, l, p]) => `<a class="nav-link ${page === h || (h === 'knowledge-bases.html' && page === 'knowledge-base.html') || (h === 'bots.html' && page === 'bot.html') ? 'active' : ''}" href="${h}">${icon(p)}${l}</a>`).join('')}
        <a class="nav-link" href="https://documenter.getpostman.com/view/41362344/2sBXqKofTd" target="_blank" rel="noopener">📄 API Docs</a></nav>
      <div class="user-card"><div class="avatar">${initials(user.name || user.email)}</div>
        <div style="min-width:0;flex:1"><div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user.name || user.email}</div>
        <div class="tiny muted">${user.role ? `<span class="badge b-${user.role}">${user.role}</span>` : ''}</div></div>
        <button class="icon-btn" id="logout-btn" title="Log out" aria-label="Log out">⏻</button></div>
    </aside>
    <div class="main"><header class="topbar" id="topbar"></header><main class="page" id="page"></main></div>`;
  document.getElementById('logout-btn').onclick = logout;
  if (localStorage.getItem('rag_sidebar') === 'open') document.getElementById('sidebar').classList.add('open');
  const { orgs, orgId } = await loadOrgs().catch(() => ({ orgs: [], orgId: null }));
  return { orgs, orgId };
}
