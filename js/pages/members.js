import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext, getOrgMembers } from '../components/org-switcher.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS } from '../config.js';
import { toast, openModal, confirmDialog, skeletonList, emptyState } from '../ui.js';
import { escapeHtml, formatDate } from '../utils.js';
initTheme();
await guard('members.html');
let { orgId, org } = await getOrgContext();
// Fallback: if detail didn't carry user_role, infer it from the members list
// by matching the logged-in user.
let role = org?.user_role || store.getUser()?.role || org?.role || null;
if (!role) {
  try {
    const me = store.getUser() || {};
    const res = await getOrgMembers(orgId);
    const hit = res.members.find(m => (me.email && m.email === me.email) || (me.name && (m.name === me.name || m.email === me.name)));
    if (hit?.role) role = hit.role;
  } catch { /* ignore */ }
}
role = role || 'member';
const canManage = role === 'owner' || role === 'admin';
const page = document.getElementById('page');
let members = [], invites = [];
async function load() {
  page.innerHTML = `<div class="page-head"><div><h2>Members</h2><p class="muted">${escapeHtml(org?.name || '')} · role: <span class="badge b-${role}">${escapeHtml(role)}</span></p></div>${canManage ? `<button class="btn btn-primary" id="inv">+ Invite member</button>` : ''}</div>
  <div id="ml">${skeletonList(2)}</div>
  <div class="card mt3"><div class="flex between"><h3>Pending invites</h3><button class="btn btn-ghost btn-sm" id="rl">Refresh</button></div><div id="il" class="mt1"><div class="skeleton" style="height:40px"></div></div></div>
  <div class="card mt3"><h3>What can each role do?</h3><div class="table-wrap mt1"><table class="perm-table"><thead><tr><th>Action</th><th>Owner</th><th>Admin</th><th>Member</th></tr></thead><tbody>
  ${[['Manage KBs, docs & bots', 1, 1, 0], ['Invite members', 1, 1, 0], ['Change roles / remove', 1, 1, 0], ['Regenerate bot keys', 1, 1, 0], ['Delete organization', 1, 0, 0], ['Chat & view', 1, 1, 1]].map(([a, o, ad, m]) => `<tr><td>${a}</td><td>${o ? '✓' : '—'}</td><td>${ad ? '✓' : '—'}</td><td>${m ? '✓' : '—'}</td></tr>`).join('')}</tbody></table></div></div>`;
  // Members (embedded in org detail)
  try {
    const res = await getOrgMembers(orgId);
    members = res.members;
    if (!members.length && res.count == null) {
      document.getElementById('ml').innerHTML = emptyState('👥', 'No member data', 'The org response did not include a members list.', '');
    } else {
      document.getElementById('ml').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th></th></tr></thead><tbody>
      ${members.map(m => `<tr><td><strong>${escapeHtml(m.name || m.email)}</strong></td><td class="muted">${escapeHtml(m.email)}</td><td><span class="badge b-${m.role}">${escapeHtml(m.role)}</span></td><td class="small">${formatDate(m.joined_at || m.created_at)}</td>
      <td>${canManage && m.role !== 'owner' ? `<select data-role="${m.id}" aria-label="Change role"><option value="owner" ${m.role === 'owner' ? 'selected' : ''}>owner</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>admin</option><option value="member" ${m.role === 'member' ? 'selected' : ''}>member</option></select> <button class="btn btn-ghost btn-sm" data-rm="${m.id}" data-nm="${escapeHtml(m.name || m.email)}">Remove</button>` : '<span class="tiny muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    }
  }
  catch (e) { document.getElementById('ml').innerHTML = emptyState('⚠️', 'Could not load members', escapeHtml(e.message), ''); }
  // Pending invites (GET same invites endpoint)
  await loadInvites();
  document.getElementById('rl').onclick = loadInvites;
  document.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => {
    try { await apiFetch(ENDPOINTS.memberUpdate(orgId, s.dataset.role), { method: 'PATCH', body: { role: s.value } }); toast('Role updated', 'success'); location.reload(); }
    catch (e) { toast(e.status === 403 ? 'Only owners/admins can change roles.' : e.message, 'error'); }
  });
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({ title: 'Remove member?', body: `<strong>${escapeHtml(b.dataset.nm || '')}</strong> loses access to this organization immediately.`, confirmText: 'Remove' })) return;
    try { await apiFetch(ENDPOINTS.memberRemove(orgId, b.dataset.rm), { method: 'DELETE' }); toast('Removed', 'success'); location.reload(); }
    catch (e) { toast(e.status === 403 ? 'Only owners/admins can remove members.' : e.message, 'error'); }
  });
  document.getElementById('inv')?.addEventListener('click', openInvite);
}
async function loadInvites() {
  const w = document.getElementById('il');
  if (!w) return;
  try { invites = asList(await apiFetch(ENDPOINTS.invites(orgId))); }
  catch (e) { w.innerHTML = `<p class="small muted">Could not load invites: ${escapeHtml(e.message)}</p>`; return; }
  // Hide consumed invites — backend may keep returning them with a final status.
  invites = invites.filter(iv => {
    const s = String(iv.status || '').toLowerCase();
    if (['accepted', 'consumed', 'used', 'expired', 'revoked', 'rejected', 'cancelled'].includes(s)) return false;
    if (iv.is_accepted || iv.accepted || iv.accepted_at || iv.used || iv.used_at) return false;
    return true;
  });
  if (!invites.length) { w.innerHTML = `<p class="small muted">No pending invites.</p>`; return; }
  w.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Status / Expiry</th><th></th></tr></thead><tbody>
    ${invites.map(iv => `<tr><td><strong>${escapeHtml(iv.email || iv.invitee || '-')}</strong></td><td><span class="badge b-${iv.role || 'member'}">${escapeHtml(iv.role || 'member')}</span></td>
    <td class="small muted">${escapeHtml(iv.status || iv.expires_at || iv.expires || 'pending')}</td>
    <td>${canManage ? `<button class="btn btn-ghost btn-sm" data-revoke="${iv.id || iv.pk || iv.token}">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  w.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({ title: 'Revoke invite?', body: 'The invite link stops working immediately.', confirmText: 'Revoke' })) return;
    try { await apiFetch(ENDPOINTS.inviteDetail(orgId, b.dataset.revoke), { method: 'DELETE' }); toast('Invite revoked', 'success'); loadInvites(); }
    catch (e) { toast(e.message, 'error'); }
  });
}
function openInvite() {
  if (!canManage) { toast('Only owners and admins can invite.', 'error'); return; }
  const { el, close } = openModal(`<div class="modal-head"><h3>Invite member</h3><button class="icon-btn" data-close>✕</button></div>
  <div class="modal-body"><div class="field"><label>Email(s), comma-separated</label><input id="ie" type="email" placeholder="teammate@company.com"><div class="error"></div><div class="hint">One invite per email. They join via the emailed token link.</div></div>
  <div class="field"><label>Role</label><select id="ir"><option value="member">Member — view & chat</option><option value="admin">Admin — manage everything</option><option value="owner">Owner — full control</option></select></div></div>
  <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="is">Send invite</button></div>`);
  el.querySelector('#is').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const emails = el.querySelector('#ie').value.split(',').map(s => s.trim()).filter(Boolean);
    const r = el.querySelector('#ir').value;
    if (!emails.length) { toast('Enter at least one email.', 'error'); btn.disabled = false; return; }
    try {
      for (const email of emails) await apiFetch(ENDPOINTS.invites(orgId), { method: 'POST', body: { email, role: r } });
      close(); toast(`Invite${emails.length > 1 ? 's' : ''} sent`, 'success'); loadInvites();
    } catch (err) { toast(err.message || 'Invite failed', 'error'); btn.disabled = false; }
  };
}
await load();
