import { isAuthed } from './auth.js';
import { apiFetch, asList } from './api.js';
import { ENDPOINTS } from './config.js';
import { store } from './state.js';
import { mountShell } from './components/sidebar.js';
import { mountTopbar } from './components/topbar.js';

/** Page guard: require auth, load org context, mount shell. Returns {orgs, orgId}. */
export async function guard(activeNav) {
  if (!isAuthed()) { location.href = `login.html?next=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`; throw 0; }
  const { orgId } = await mountShell(activeNav);
  mountTopbar();
  return orgId;
}
export async function loadOrgs() {
  const data = await apiFetch(ENDPOINTS.orgs());
  const orgs = asList(data).length ? asList(data) : (data?.orgs || data?.organizations || data?.data || []);
  let cur = store.getOrgId();
  if (!cur && orgs.length) { cur = orgs[0].id; store.setOrgId(cur); }
  if (cur && !orgs.find(o => String(o.id) === String(cur)) && orgs.length) { cur = orgs[0].id; store.setOrgId(cur); }
  return { orgs, orgId: cur };
}
export function canManage(role) { return role === 'owner' || role === 'admin'; }
