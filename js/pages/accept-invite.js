import { initTheme, store } from '../state.js';
import { apiFetch } from '../api.js';
import { ENDPOINTS } from '../config.js';
import { toast } from '../ui.js';
import { isAuthed } from '../auth.js';
initTheme();
const token = new URLSearchParams(location.search).get('token');
const box = document.getElementById('content');
if (!token) { box.innerHTML = `<div class="alert alert-danger">Missing invite token. Ask your admin for a fresh invite link.</div><a class="btn btn-secondary mt2" href="login.html">Go to login</a>`; }
else if (!isAuthed()) { location.href = `login.html?next=${encodeURIComponent('accept-invite.html?token=' + token)}`; }
else {
  box.innerHTML = `<div class="card"><h3>You're invited</h3><p class="muted small">Token <span class="mono">${token.slice(0, 10)}…</span></p><button class="btn btn-primary mt2" id="acc" style="width:100%">Accept invite</button></div>`;
  document.getElementById('acc').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Accepting…';
    // Best-effort: remove the now-consumed invite so it stops showing as pending.
    const cleanup = async () => {
      try {
        const me = store.getUser() || {};
        const { asList } = await import('../api.js');
        const orgs = asList(await apiFetch(ENDPOINTS.orgs()));
        for (const o of orgs) {
          let list = [];
          try { list = asList(await apiFetch(ENDPOINTS.invites(o.id))); } catch { continue; }
          const hit = list.find(iv => iv.token === token || (me.email && iv.email && iv.email === me.email));
          const iid = hit?.id || hit?.pk;
          if (hit && iid) { try { await apiFetch(ENDPOINTS.inviteDetail(o.id, iid), { method: 'DELETE' }); } catch { /* non-admins can't revoke; ignore */ } break; }
        }
      } catch { /* ignore */ }
    };
    try {
      await apiFetch(ENDPOINTS.acceptInvite(), { method: 'POST', body: { token } });
      await cleanup();
      toast('Invite accepted!', 'success'); location.href = 'dashboard.html';
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      // Accepting twice (or an invite for an existing member) is not a failure —
      // the user is already in the org, so take them to the dashboard.
      if (msg.includes('already') && msg.includes('member')) {
        await cleanup();
        toast("You're already a member of this organization.", 'success');
        setTimeout(() => { location.href = 'dashboard.html'; }, 800);
        box.innerHTML = `<div class="alert alert-info">You're already a member of this organization. Redirecting…</div><a class="btn btn-secondary mt2" href="dashboard.html">Go to dashboard</a>`;
        return;
      }
      toast(err.message, 'error'); box.innerHTML = `<div class="alert alert-danger">${err.message}</div><p class="small muted mt1">This link may have expired. Ask an admin to resend it.</p><a class="btn btn-secondary mt2" href="dashboard.html">Go to dashboard</a>`;
    }
  };
}
