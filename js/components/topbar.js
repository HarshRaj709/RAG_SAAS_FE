import { store, getTheme, setTheme } from '../state.js';
import { loadOrgs } from '../router-guard.js';
import { logout } from '../auth.js';
import { escapeHtml } from '../utils.js';

export async function mountTopbar(preloaded) {
  const bar = document.getElementById('topbar');
  if (!bar) return;
  const crumbs = { 'dashboard.html': 'Dashboard', 'knowledge-bases.html': 'Knowledge Bases', 'knowledge-base.html': 'Knowledge Base', 'bots.html': 'Bots', 'bot.html': 'Bot', 'members.html': 'Members', 'settings.html': 'Settings' };
  const page = location.pathname.split('/').pop();
  // Prefer orgs already loaded by guard()/mountShell — zero extra requests.
  let orgs = preloaded?.orgs || [], orgId = preloaded?.orgId ?? store.getOrgId();
  if (!preloaded) {
    try { ({ orgs, orgId } = await loadOrgs()); } catch { /* offline */ }
  }
  const cur = orgs.find(o => String(o.id) === String(orgId));
  bar.innerHTML = `
    <button class="icon-btn sidebar-toggle" id="sb-toggle" aria-label="Toggle menu">☰</button>
    <span class="crumb">Org / ${crumbs[page] || 'App'}</span>
    <div style="flex:1"></div>
    <div class="dropdown">
      <button class="btn btn-secondary btn-sm" id="org-btn" aria-haspopup="listbox">🏢 ${escapeHtml(cur?.name || 'Select org')} ▾</button>
      <div class="dropdown-menu" id="org-menu" role="listbox">
        ${orgs.map(o => `<button data-org="${o.id}">${escapeHtml(o.name)} ${String(o.id) === String(orgId) ? '✓' : ''}</button>`).join('') || '<div class="small muted" style="padding:8px 12px">No organizations</div>'}
        <button data-new-org style="border-top:1px solid var(--border);color:var(--primary)">+ Create organization</button>
      </div>
    </div>
    <button class="icon-btn" id="theme-btn" aria-label="Toggle theme">${getTheme() === 'dark' ? '☀️' : '🌙'}</button>
    <div class="dropdown"><button class="icon-btn" id="user-btn" aria-label="Account">👤</button>
      <div class="dropdown-menu" id="user-menu"><button id="u-settings">⚙️ Settings</button><button id="u-logout">⏻ Log out</button></div></div>`;
  const toggle = (id) => { const m = document.getElementById(id); const was = m.classList.contains('open'); document.querySelectorAll('.dropdown-menu').forEach(x => x.classList.remove('open')); if (!was) m.classList.add('open'); };
  document.getElementById('org-btn').onclick = (e) => { e.stopPropagation(); toggle('org-menu'); };
  document.getElementById('user-btn').onclick = (e) => { e.stopPropagation(); toggle('user-menu'); };
  document.addEventListener('click', () => document.querySelectorAll('.dropdown-menu').forEach(x => x.classList.remove('open')));
  document.getElementById('theme-btn').onclick = (e) => { const n = getTheme() === 'dark' ? 'light' : 'dark'; setTheme(n); e.currentTarget.textContent = n === 'dark' ? '☀️' : '🌙'; };
  document.getElementById('sb-toggle').onclick = () => { const s = document.getElementById('sidebar'); s.classList.toggle('open'); localStorage.setItem('rag_sidebar', s.classList.contains('open') ? 'open' : ''); };
  document.getElementById('u-logout').onclick = logout;
  document.getElementById('u-settings').onclick = () => location.href = 'settings.html';
  bar.querySelectorAll('[data-org]').forEach(b => b.onclick = () => { store.setOrgId(b.dataset.org); location.reload(); });
  const nb = bar.querySelector('[data-new-org]'); if (nb) nb.onclick = () => location.href = 'settings.html#new-org';
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { const s = document.querySelector('.search-input input'); s?.focus(); e.preventDefault(); } });
}
