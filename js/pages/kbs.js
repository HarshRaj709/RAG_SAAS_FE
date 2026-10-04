import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext, currentRole } from '../components/org-switcher.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS } from '../config.js';
import { toast, openModal, confirmDialog, skeletonList, emptyState, setFieldError } from '../ui.js';
import { escapeHtml, formatDate, debounce } from '../utils.js';
initTheme();
await guard('knowledge-bases.html');
const page = document.getElementById('page');
const { orgId, org } = await getOrgContext();
const role = currentRole(org);
const canManage = role === 'owner' || role === 'admin';
let all = [], view = 'grid', q = new URLSearchParams(location.search).get('q') || '';
page.innerHTML = `
  <div class="page-head"><div><h2>Knowledge Bases</h2><p class="muted">Group documents per product, team or locale.</p></div>
  <button class="btn btn-primary" id="new">+ New Knowledge Base</button></div>
  <div class="flex between"><div class="search-input"><span>🔍</span><input id="q" placeholder="Search knowledge bases…  ( / )" value="${escapeHtml(q)}" aria-label="Search"></div>
  <div class="flex"><button class="btn btn-ghost btn-sm" id="gv">▦ Grid</button><button class="btn btn-ghost btn-sm" id="lv">☰ List</button></div></div>
  <div id="list" class="mt2"></div>`;
async function load() {
  const list = document.getElementById('list');
  list.innerHTML = skeletonList(3);
  try { all = asList(await apiFetch(ENDPOINTS.kbs(orgId))); } catch (e) { list.innerHTML = emptyState('⚠️', 'Could not load', escapeHtml(e.message), `<button class="btn btn-primary" onclick="location.reload()">Retry</button>`); return; }
  render();
}
/** Tolerant count accessors — backend key names vary; fall back to embedded arrays. */
function kbDocsArr(k) {
  for (const key of ['documents', 'files', 'docs', 'uploads', 'items']) {
    if (Array.isArray(k?.[key])) return k[key];
  }
  return null;
}
function kbDocCount(k) {
  for (const key of ['document_count', 'documents_count', 'docs_count', 'doc_count', 'num_documents', 'total_documents', 'count']) {
    const v = Number(k?.[key]);
    if (Number.isFinite(v)) return v;
  }
  const arr = kbDocsArr(k);
  if (arr) return arr.length;
  return 0;
}
function kbChunkCount(k) {
  for (const key of ['total_chunks', 'chunks_count', 'chunk_count', 'total_chunks_count', 'num_chunks', 'total_embeddings']) {
    const v = Number(k?.[key]);
    if (Number.isFinite(v)) return v;
  }
  if (typeof k?.chunks === 'number') return k.chunks;
  const arr = kbDocsArr(k);
  if (arr) return arr.reduce((a, x) => a + (Number(x?.chunk_count ?? x?.chunks_count ?? (typeof x?.chunks === 'number' ? x.chunks : 0)) || 0), 0);
  return 0;
}
function render() {
  const list = document.getElementById('list');
  const f = all.filter(k => (k.name || '').toLowerCase().includes(q.toLowerCase()));
  if (!f.length) { list.innerHTML = emptyState('📚', q ? 'No matches' : 'No knowledge bases yet', 'Create one, then upload PDFs, DOCX, MD or TXT files.', canManage ? `<button class="btn btn-primary" id="e-new">New Knowledge Base</button>` : ''); document.getElementById('e-new')?.addEventListener('click', () => openCreate()); return; }
  list.innerHTML = `<div class="${view === 'grid' ? 'kb-grid' : 'grid'}">` + f.map(k => `
    <div class="card hoverable kb-card"><h3>${escapeHtml(k.name)}</h3><p class="small muted">${escapeHtml(k.description || 'No description')}</p>
    <div class="mt1 flex" style="flex-wrap:wrap"><span class="chip">📄 ${kbDocCount(k)} docs</span><span class="chip">🧩 ${kbChunkCount(k)} chunks</span></div>
    <p class="tiny muted mt1">Created ${formatDate(k.created_at)}</p>
    <div class="flex mt2"><a class="btn btn-secondary btn-sm" href="knowledge-base.html?id=${k.id}">Open</a>
    ${canManage ? `<button class="btn btn-ghost btn-sm" data-edit="${k.id}">Edit</button><button class="btn btn-ghost btn-sm" data-del="${k.id}" title="Only owners and admins can do this">Delete</button>` : `<span class="tiny muted" title="Only owners and admins can do this">🔒 Read-only</span>`}</div></div>`).join('') + `</div>`;
  list.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openCreate(all.find(x => String(x.id) === b.dataset.edit)));
  list.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const kb = all.find(x => String(x.id) === b.dataset.del);
    if (!await confirmDialog({ title: 'Delete knowledge base?', body: `This deletes <strong>${escapeHtml(kb.name)}</strong> and its documents.`, confirmText: 'Delete', requireText: kb.name })) return;
    try { await apiFetch(ENDPOINTS.kbDetail(orgId, kb.id), { method: 'DELETE' }); toast('Deleted', 'success'); load(); }
    catch (e) { toast(e.status === 403 ? 'Permission denied — owners/admins only.' : e.message, 'error'); }
  });
}
function openCreate(existing) {
  if (existing instanceof Event) existing = undefined;
  const { el, close } = openModal(`<div class="modal-head"><h3>${existing ? 'Edit' : 'New'} Knowledge Base</h3><button class="icon-btn" data-close>✕</button></div>
    <form id="kf"><div class="modal-body">
    <div class="field"><label>Name (unique per org)</label><input name="name" required value="${escapeHtml(existing?.name || '')}"><div class="error"></div><div class="hint">Letters, numbers, spaces and dashes.</div></div>
    <div class="field"><label>Description</label><textarea name="description" rows="3">${escapeHtml(existing?.description || '')}</textarea><div class="error"></div></div>
    </div><div class="modal-foot"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="ks">${existing ? 'Save' : 'Create'}</button></div></form>`);
  el.querySelector('#ks').onclick = async (e) => {
    e.preventDefault();
    const fd = new FormData(el.querySelector('#kf'));
    const body = { name: fd.get('name').trim(), description: fd.get('description').trim() };
    try {
      if (existing) await apiFetch(ENDPOINTS.kbDetail(orgId, existing.id), { method: 'PATCH', body });
      else await apiFetch(ENDPOINTS.kbs(orgId), { method: 'POST', body });
      close(); toast(existing ? 'Saved' : 'Knowledge base created', 'success'); load();
    } catch (err) { setFieldError(el.querySelector('#kf'), err); if (!Object.keys(err.fields || {}).length) toast(err.message, 'error'); }
  };
}
document.getElementById('new').onclick = () => canManage ? openCreate() : toast('Only owners and admins can do this.', 'error');
document.getElementById('q').oninput = debounce((e) => { q = e.target.value; render(); }, 250);
document.getElementById('gv').onclick = () => { view = 'grid'; render(); };
document.getElementById('lv').onclick = () => { view = 'list'; render(); };
await load();
