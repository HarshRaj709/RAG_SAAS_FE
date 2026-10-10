import { isAuthed } from './auth.js';
import { apiFetch, asList } from './api.js';
import { ENDPOINTS } from './config.js';
import { store } from './state.js';
import { mountShell } from './components/sidebar.js';
import { mountTopbar } from './components/topbar.js';

/** Page guard: require auth, load org context, mount shell. Returns {orgs, orgId}. */
export async function guard(activeNav) {
  if (!isAuthed()) { location.href = `login.html?next=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`; throw 0; }
  const ctx = await mountShell(activeNav);
  // Reuse the orgs already fetched by mountShell — mountTopbar must NOT refetch.
  mountTopbar(ctx);
  return ctx.orgId;
}
// Single-flight: concurrent callers (shell + topbar + page) share one request;
// apiFetch's GET cache then serves repeat visits without network.
let _orgsInflight = null;
export async function loadOrgs() {
  if (_orgsInflight) return _orgsInflight;
  _orgsInflight = (async () => {
    const data = await apiFetch(ENDPOINTS.orgs(), { cacheTtl: 60000 });
    const orgs = asList(data).length ? asList(data) : (data?.orgs || data?.organizations || data?.data || []);
    let cur = store.getOrgId();
    if (!cur && orgs.length) { cur = orgs[0].id; store.setOrgId(cur); }
    if (cur && !orgs.find(o => String(o.id) === String(cur)) && orgs.length) { cur = orgs[0].id; store.setOrgId(cur); }
    return { orgs, orgId: cur };
  })();
  try { return await _orgsInflight; }
  finally { _orgsInflight = null; }
}
export function canManage(role) { return role === 'owner' || role === 'admin'; }
