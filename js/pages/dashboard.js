import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS } from '../config.js';
import { toast, skeletonList, emptyState } from '../ui.js';
import { escapeHtml, timeAgo } from '../utils.js';

initTheme();

async function main() {
  await guard('dashboard.html');
  const page = document.getElementById('page');
  page.innerHTML = skeletonList(4);
  try {
    const { getOrgContext: g, getOrgMembers } = await import('../components/org-switcher.js');
    const { orgs, orgId, org } = await g();
    if (!org) {
      page.innerHTML = emptyState('🏢', 'No organization', 'Create one to get started.', `<a class="btn btn-primary" href="settings.html#new-org">Create organization</a>`);
      return;
    }
    const [kbs, bots, members] = await Promise.all([
      apiFetch(ENDPOINTS.kbs(orgId)).then(asList).catch(() => []),
      apiFetch(ENDPOINTS.bots(orgId)).then(asList).catch(() => []),
      getOrgMembers(orgId).then(r => r.members).catch(() => []),
    ]);
    let docs = [], chunks = 0;
    const kbDocList = (detail) => {
      if (!detail || typeof detail !== 'object') return [];
      for (const k of ['documents', 'files', 'docs', 'uploads', 'items']) {
        if (Array.isArray(detail[k])) return detail[k];
      }
      return [];
    };
    for (const kb of kbs.slice(0, 6)) {
      try {
        const d = kbDocList(await apiFetch(ENDPOINTS.kbDetail(orgId, kb.id)));
        docs.push(...d.map(x => ({ ...x, kb: kb.name })));
        chunks += d.reduce((a, x) => a + (x.chunk_count ?? x.chunks_count ?? (typeof x.chunks === 'number' ? x.chunks : 0)), 0);
      }
      catch { /* ignore */ }
      chunks += kb.total_chunks || 0;
    }
    const hasKb = kbs.length > 0, hasDoc = docs.length > 0, hasBot = bots.length > 0;
    const steps = [
      ['Create a knowledge base', hasKb, 'knowledge-bases.html'],
      ['Upload a document', hasDoc, 'knowledge-bases.html'],
      ['Create a bot', hasBot, 'bots.html'],
      ['Chat in the playground', false, hasBot ? `bot.html?id=${bots[0].id}&tab=playground` : 'bots.html'],
    ];
    const user = store.getUser() || {};
    page.innerHTML = `
    <div class="page-head"><div><h2>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}${user.name ? `, ${escapeHtml(user.name.split(' ')[0])}` : ''} 👋</h2><p class="muted">${escapeHtml(org.name)} · ${orgs.length} org${orgs.length > 1 ? 's' : ''}</p></div>
    <div class="flex"><a class="btn btn-secondary" href="knowledge-bases.html">+ New KB</a><a class="btn btn-primary" href="bots.html">+ New bot</a></div></div>
    <div class="grid grid-5">
      ${[['📚', kbs.length, 'Knowledge bases'], ['📄', docs.length, 'Documents'], ['🧩', chunks, 'Chunks'], ['🤖', bots.length, 'Bots'], ['👥', members.length, 'Members']].map(([i, n, l]) => `<div class="card stat-card"><div class="stat-icon">${i}</div><div><div class="stat-num">${n}</div><div class="stat-label">${l}</div></div></div>`).join('')}
    </div>
    <div class="grid grid-2 mt3">
      <div class="card"><h3>Getting started</h3><div class="mt2">${steps.map(([t, done, h]) => `<a href="${h}" class="check-item ${done ? 'done' : ''}" style="text-decoration:none;color:inherit"><span class="ck">${done ? '✓' : '○'}</span><span><strong>${t}</strong></span></a>`).join('')}</div></div>
      <div class="card"><h3>Usage per bot key</h3><p class="muted small mt1">Detailed analytics are <span class="badge b-pending">Coming soon</span> — the backend does not expose usage yet.</p><div class="progress mt2"><div style="width:8%"></div></div></div>
    </div>
    <div class="grid grid-2 mt3">
      <div class="card"><div class="flex between"><h3>Recent documents</h3><a href="knowledge-bases.html" class="small">View all</a></div>
        ${docs.slice(0, 5).map(d => { const st = String(d.status || d.ingestion_status || d.state || d.ingest_status || (d.ingested_at ? 'completed' : 'pending')); return `<div class="upload-row"><span>📄</span><span style="flex:1"><strong>${escapeHtml(d.filename || d.file_name || d.name)}</strong><br><span class="tiny muted">${escapeHtml(d.kb || '')} · ${timeAgo(d.created_at || d.uploaded_at)}</span></span><span class="badge b-${st}">${escapeHtml(st)}</span></div>`; }).join('') || '<p class="muted small mt2">No documents yet.</p>'}</div>
      <div class="card"><div class="flex between"><h3>Recent bots</h3><a href="bots.html" class="small">View all</a></div>
        ${bots.slice(0, 5).map(b => `<div class="upload-row"><span>🤖</span><span style="flex:1"><strong>${escapeHtml(b.name)}</strong><br><span class="tiny muted mono">${escapeHtml(b.slug || '')}</span></span><a class="btn btn-secondary btn-sm" href="bot.html?id=${b.id}">Open</a></div>`).join('') || '<p class="muted small mt2">No bots yet.</p>'}</div>
    </div>`;
  } catch (e) {
    if (e === 0) return;
    const p = document.getElementById('page');
    if (p && !p.innerHTML) return;
    if (e?.message) toast(e.message, 'error');
  }
}

main();
