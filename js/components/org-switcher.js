import { store } from '../state.js';
import { loadOrgs } from '../router-guard.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS } from '../config.js';
/** Org switcher helper (logic used by topbar dropdown). */
export async function getOrgContext() {
  const { orgs, orgId } = await loadOrgs();
  let org = orgs.find(o => String(o.id) === String(orgId)) || orgs[0] || null;
  // The org LIST may not include `user_role`; the DETAIL does.
  // Fetch it so role gating (invite/manage buttons) is correct.
  if (org) {
    try {
      // Cached 60s + deduped: repeat calls on one page load cost zero requests.
      const detail = await apiFetch(ENDPOINTS.members(org.id), { cacheTtl: 60000 });
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) org = { ...org, ...detail };
    } catch { /* keep list version; role falls back below */ }
  }
  return { orgs, orgId: org?.id || orgId, org };
}
/**
 * Backend has no separate members endpoint: GET org detail returns
 * {id, name, created_by, user_role, members, ...}. Normalize `members`
 * which may be an array of objects, an array of strings, or a count.
 */
export function normalizeMembers(raw) {
  const m = raw?.members ?? raw;
  if (Array.isArray(m)) {
    return m.map((x, i) => typeof x === 'string'
      ? { id: x, name: x, email: x, role: 'member' }
      : { id: x.id || x.user_id || x.email || x.username || String(i), name: x.username || x.name || x.email || 'Member', email: x.email || x.username || '', role: x.role || x.user_role || 'member', joined_at: x.joined_at || x.created_at, ...x });
  }
  return [];
}
export function memberCount(raw) {
  if (Array.isArray(raw?.members)) return raw.members.length;
  if (typeof raw?.members === 'number') return raw.members;
  if (typeof raw?.members_count === 'number') return raw.members_count;
  return null;
}
export async function getOrgMembers(orgId) {
  const detail = await apiFetch(ENDPOINTS.members(orgId), { cacheTtl: 15000 });
  const list = normalizeMembers(detail);
  return { detail, members: list.length ? list : asList(detail).length ? normalizeMembers(asList(detail)) : list, count: memberCount(detail) };
}
export function switchOrg(id) { store.setOrgId(id); location.reload(); }
/** Current user's role in the org. Backend field is `user_role`; list items may omit it. */
export function currentRole(org) {
  const me = store.getUser() || {};
  return String(org?.user_role || me.role || org?.role || 'member').toLowerCase();
}
export function canManageRole(r) { return r === 'owner' || r === 'admin'; }
