import { initTheme } from '../state.js';
import { signup, login } from '../auth.js';
import { toast, setFieldError, withLoading } from '../ui.js';
initTheme();
document.querySelector('.toggle-pw').onclick = () => { const i = document.getElementById('pw'); i.type = i.type === 'password' ? 'text' : 'password'; };
const pw = document.getElementById('pw'), pwm = document.getElementById('pwm');
pw.oninput = () => {
  let s = 0; if (pw.value.length >= 8) s += 30; if (/[A-Z]/.test(pw.value)) s += 20; if (/[0-9]/.test(pw.value)) s += 25; if (/[^A-Za-z0-9]/.test(pw.value)) s += 25;
  pwm.style.width = s + '%'; pwm.style.background = s < 50 ? 'var(--danger)' : s < 80 ? 'var(--warning)' : 'var(--success)';
};
const form = document.getElementById('f');
// Invite flow: token survives in URL + sessionStorage across the accept page → signup.
const _iq = new URLSearchParams(location.search).get('invite_token');
if (_iq) { try { sessionStorage.setItem('invite_token', _iq); } catch { /* ignore */ } }
const inviteToken = _iq || (() => { try { return sessionStorage.getItem('invite_token'); } catch { return null; } })();
if (inviteToken) {
  const banner = document.createElement('div');
  banner.className = 'alert alert-info mt2';
  banner.innerHTML = `You've been invited to join a workspace — you'll join it automatically right after signup.`;
  form.prepend(banner);
}
function focusFirstInvalid(err) {
  if (err?.fields) {
    for (const k of ['username', 'email', 'password', 'password_confirm', 'organization']) {
      if (err.fields[k]) { document.querySelector(`[name="${k}"]`)?.focus(); break; }
    }
  }
}
document.getElementById('sub').onclick = withLoading(document.getElementById('sub'), async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const username = fd.get('username')?.trim();
  const email = fd.get('email')?.trim();
  const password = fd.get('password');
  const orgName = fd.get('organization')?.trim();
  if (!username || !email || !password) { toast('Username, email and password are required.', 'error'); return; }
  if (password !== fd.get('password_confirm')) { toast('Passwords do not match.', 'error'); document.getElementById('pw2').focus(); return; }
  // Backend /api/register/ expects exactly: username, email, password.
  const body = { username, email, password };
  try {
    await signup(body);
    // Auto-login (backend login accepts username or email — send both keys).
    try { await login(username, password); } catch { try { await login(email, password); } catch { location.href = 'login.html'; return; } }
    // Invite flow (mandatory second call): signup does NOT auto-join — the
    // backend requires JWT for accept, which we now have. Never call accept
    // before signup.
    if (inviteToken) {
      const { apiFetch } = await import('../api.js');
      const { ENDPOINTS } = await import('../config.js');
      const { store } = await import('../state.js');
      try {
        const data = await apiFetch(ENDPOINTS.acceptInvite(), { method: 'POST', body: { token: inviteToken } });
        try { sessionStorage.removeItem('invite_token'); sessionStorage.removeItem('invite_error'); } catch { /* ignore */ }
        const oid = data?.org_id || data?.orgId || data?.org?.id;
        if (oid) store.setOrgId(oid);
        toast('Account created — you joined the workspace!', 'success');
        location.href = 'dashboard.html';
        return;
      } catch (accErr) {
        const msg = String(accErr.message || '').toLowerCase();
        if (accErr.status === 401) {
          // Re-login, then retry accept from the invite page.
          location.href = `login.html?next=${encodeURIComponent('/invites/accept/?token=' + inviteToken)}`;
          return;
        }
        if (msg.includes('already') && msg.includes('member')) {
          try { sessionStorage.removeItem('invite_token'); sessionStorage.removeItem('invite_error'); } catch { /* ignore */ }
          const oid = accErr.fields?.org_id || accErr.fields?.orgId;
          if (oid) { try { store.setOrgId(oid); } catch { /* ignore */ } }
          toast("Account created — you're already in this workspace.", 'success');
          location.href = 'dashboard.html';
          return;
        }
        // Expired / invalid / used: surface it on the invite page.
        try { sessionStorage.setItem('invite_error', msg.includes('expir') ? 'expired' : 'invalid'); } catch { /* ignore */ }
        toast(accErr.message || 'Invite could not be accepted', 'error');
        location.href = `/invites/accept/?token=${encodeURIComponent(inviteToken)}`;
        return;
      }
    }
    // Standard flow: create a personal org so the workspace UX holds.
    // (Skipped above when joining via invite.)
    if (orgName) {
      try {
        const { apiFetch } = await import('../api.js');
        const { ENDPOINTS } = await import('../config.js');
        const { store } = await import('../state.js');
        const org = await apiFetch(ENDPOINTS.orgCreate(), { method: 'POST', body: { name: orgName } });
        if (org?.id) store.setOrgId(org.id);
      } catch { /* org will be created later from Settings */ }
    }
    toast('Account created — welcome!', 'success'); location.href = 'dashboard.html';
  } catch (err) {
    setFieldError(form, err);
    // e.g. { username: ['This field is required.'], email: ['user with this email already exists.'] }
    toast(err.message || 'Signup failed', 'error');
    focusFirstInvalid(err);
  }
});
