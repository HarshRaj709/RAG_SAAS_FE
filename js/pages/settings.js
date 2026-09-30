import { initTheme, store, getTheme, setTheme } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext } from '../components/org-switcher.js';
import { apiFetch } from '../api.js';
import { ENDPOINTS, API_BASE_URL } from '../config.js';
import { toast, confirmDialog, openModal } from '../ui.js';
import { escapeHtml } from '../utils.js';
import { logout } from '../auth.js';
initTheme();
await guard('settings.html');
const { orgs, orgId, org } = await getOrgContext();
const user = store.getUser() || {};
const role = org?.user_role || user.role || org?.role || 'member';
const canManage = role === 'owner' || role === 'admin';
const page = document.getElementById('page');
page.innerHTML = `
  <div class="page-head"><div><h2>Settings</h2><p class="muted">Profile, organization and appearance.</p></div></div>
  <div class="grid grid-2">
    <div class="card"><h3>Profile</h3><div class="field mt2"><label>Name</label><input id="pn" value="${escapeHtml(user.name || '')}"></div>
    <div class="field"><label>Email</label><input value="${escapeHtml(user.email || '')}" disabled><div class="hint">Email change isn't supported by the API.</div></div>
    <button class="btn btn-primary btn-sm" id="ps">Save profile</button></div>
    <div class="card"><h3>Appearance</h3><p class="small muted">Theme is stored locally.</p><div class="flex mt1"><button class="btn btn-secondary btn-sm" data-th="light">☀️ Light</button><button class="btn btn-secondary btn-sm" data-th="dark">🌙 Dark</button> <span class="small muted">Current: ${getTheme()}</span></div>
    <h3 class="mt3">API base</h3><div class="field mt1"><label>Backend URL</label><input id="ab" value="${escapeHtml(API_BASE_URL)}"><div class="hint">Change in <span class="mono">js/config.js</span> permanently.</div></div><button class="btn btn-secondary btn-sm" id="abs">Save & reload</button></div>
  </div>
  <div class="card mt3"><h3>Organization</h3><div class="field mt1"><label>Name</label><input id="on" value="${escapeHtml(org?.name || '')}" ${canManage ? '' : 'disabled'}></div>
  ${canManage ? `<button class="btn btn-primary btn-sm" id="os">Rename</button>` : `<p class="tiny muted">🔒 Only owners/admins can rename.</p>`}
  <div class="mt2"><label class="small">Switch organization</label><div class="flex" style="flex-wrap:wrap">${orgs.map(o => `<button class="btn ${String(o.id) === String(orgId) ? 'btn-primary' : 'btn-secondary'} btn-sm" data-sw="${o.id}">${escapeHtml(o.name)}</button>`).join('')}</div></div>
  <div class="mt2"><button class="btn btn-secondary btn-sm" id="neworg">+ Create organization</button></div></div>
  <div class="card mt3"><h3>Session</h3><div class="flex"><button class="btn btn-secondary btn-sm" id="lo">Log out</button></div></div>
  ${canManage ? `<div class="danger-zone"><h3>Danger zone</h3><p class="small">Delete <strong>${escapeHtml(org?.name || '')}</strong> and all its KBs, bots and documents.</p><button class="btn btn-danger btn-sm mt1" id="delorg">Delete organization</button></div>` : ''}`;
page.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { setTheme(b.dataset.th); location.reload(); });
document.getElementById('abs').onclick = () => { localStorage.setItem('rag_api_base', document.getElementById('ab').value.trim()); location.reload(); };
page.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => { store.setOrgId(b.dataset.sw); location.reload(); });
document.getElementById('ps').onclick = async () => { toast('Profile update is not exposed by the backend — stored locally.', 'info'); const u = store.getUser() || {}; u.name = document.getElementById('pn').value; store.setUser(u); location.reload(); };
document.getElementById('os')?.addEventListener('click', async () => {
  try { await apiFetch(ENDPOINTS.orgUpdate(orgId), { method: 'PATCH', body: { name: document.getElementById('on').value } }); toast('Renamed', 'success'); location.reload(); }
  catch (e) { toast(e.message, 'error'); }
});
document.getElementById('neworg').onclick = () => {
  const { el, close } = openModal(`<div class="modal-head"><h3>New organization</h3><button class="icon-btn" data-close>✕</button></div><div class="modal-body"><div class="field"><label>Name</label><input id="nn"></div></div><div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="nc">Create</button></div>`);
  el.querySelector('#nc').onclick = async () => {
    try { const o = await apiFetch(ENDPOINTS.orgCreate(), { method: 'POST', body: { name: el.querySelector('#nn').value } }); close(); store.setOrgId(o.id); toast('Organization created', 'success'); location.reload(); }
    catch (e) { toast(e.message, 'error'); }
  };
};
if (location.hash === '#new-org') document.getElementById('neworg').click();
document.getElementById('lo').onclick = logout;
document.getElementById('delorg')?.addEventListener('click', async () => {
  if (!await confirmDialog({ title: 'Delete organization?', body: `Type <span class="mono">${escapeHtml(org.name)}</span> to confirm. This cannot be undone.`, confirmText: 'Delete', requireText: org.name })) return;
  try { await apiFetch(ENDPOINTS.orgDelete(orgId), { method: 'DELETE' }); store.setOrgId(null); toast('Deleted', 'success'); location.href = 'dashboard.html'; }
  catch (e) { toast(e.message, 'error'); }
});
