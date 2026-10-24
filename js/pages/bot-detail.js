import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext, currentRole } from '../components/org-switcher.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS, API_BASE_URL, BOT_DOMAINS_FIELD } from '../config.js';
import { toast, confirmDialog, skeletonList, emptyState, openModal, copyTextFallback } from '../ui.js';
import { escapeHtml, copyText, qp, formatDate, normalizeDomain, isValidDomain } from '../utils.js';
import { mountChat } from '../components/chat-widget.js';
import { showKeyModal } from './bots.js';
initTheme();
await guard('bots.html');
const { orgId, org } = await getOrgContext();
const botId = qp('id');
const page = document.getElementById('page');
const role = currentRole(org);
const canManage = role === 'owner' || role === 'admin';
if (!botId) { page.innerHTML = emptyState('🤖', 'No bot selected', '', `<a class="btn btn-primary" href="bots.html">Back</a>`); throw 0; }
let bot = null, kbs = [];
try { [bot, kbs] = await Promise.all([apiFetch(ENDPOINTS.botDetail(orgId, botId), { cacheTtl: 15000 }), apiFetch(ENDPOINTS.kbs(orgId), { cacheTtl: 15000 }).then(asList).catch(() => [])]); } catch (e) { page.innerHTML = emptyState('⚠️', 'Bot not found', escapeHtml(e.message), `<a class="btn btn-primary" href="bots.html">Back</a>`); throw 0; }
let tab = qp('tab', 'overview');
const endpoint = `${API_BASE_URL}${ENDPOINTS.publicChat(bot.slug)}`;
const kbName = (id) => kbs.find(k => String(k.id) === String(id))?.name || String(id).slice(0, 8);
page.innerHTML = `
  <p><a href="bots.html">← Bots</a></p>
  <div class="page-head"><div><h2>${escapeHtml(bot.name)}</h2><p class="mono muted small">/${escapeHtml(bot.slug || '')} · created ${formatDate(bot.created_at)}</p></div>
  <div class="flex"><button class="btn btn-secondary btn-sm" id="edit-bot-top">Edit bot</button><a class="btn btn-primary btn-sm" href="bot.html?id=${botId}&tab=playground">Open playground →</a></div></div>
  <div class="tabs" role="tablist">${['overview', 'integration', 'playground', 'usage'].map(t => `<button class="tab" data-tab="${t}" aria-selected="${tab === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
  <div id="tc"></div>`;
const tc = document.getElementById('tc');
page.querySelector('#edit-bot-top').addEventListener('click', () => {
  if (!canManage) { toast('Only owners and admins can edit bot settings.', 'error'); return; }
  if (tab !== 'overview') switchTab('overview');
  setTimeout(() => tc.querySelector('#edit-settings')?.click(), 0);
});
function switchTab(t) { tab = t; history.replaceState(null, '', `?id=${botId}&tab=${t}`); page.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === t)); draw(); }
/** Read the whitelist (GET detail & list both include `allowed_domains`). Owner user-JWT. */
function getDomains(b) {
  const v = b?.[BOT_DOMAINS_FIELD];
  if (!Array.isArray(v)) return [];
  return v.map(x => normalizeDomain(typeof x === 'string' ? x : '')).filter(Boolean);
}
/** PATCH {allowed_domains} — only `kb_ids` + `allowed_domains` are writable.
 *  Uses the owner's user-JWT (default auth), never the bot key. */
function saveDomains(domains) {
  return apiFetch(ENDPOINTS.botDetail(orgId, botId), { method: 'PATCH', body: { [BOT_DOMAINS_FIELD]: domains } });
}
/** Shared client-side check matching backend rules: bare hostnames, no wildcards. */
function domainError(raw) {
  if (String(raw).includes('*')) return 'Wildcards (*.example.com) are not allowed — enter each subdomain separately (mysite.com, www.mysite.com).';
  const d = normalizeDomain(raw);
  if (!d) return 'Enter a domain like example.com';
  if (!isValidDomain(d)) return `"${d}" is not a valid hostname. Use a bare domain like example.com (no http://, no path).`;
  return '';
}
page.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
function draw() {
  if (tab === 'overview') {
    const linked = bot.knowledge_bases || bot.kbs || bot.kb_ids || [];
    const kbLabel = (x) => typeof x === 'string' ? kbName(x) : (x.name || x.id);
    const kbIdOf = (x) => String(typeof x === 'string' ? x : (x.id || x.pk || ''));
    tc.innerHTML = `<div class="grid grid-2"><div class="card"><h3>Details</h3>
      <p class="small mt1">Endpoint</p><div class="code-block">POST ${escapeHtml(endpoint)} <button class="btn btn-secondary btn-sm copy-btn" data-c="${escapeHtml(endpoint)}">Copy</button></div>
      <div class="field mt2"><label>Linked knowledge bases</label><div class="flex" style="flex-wrap:wrap">${linked.map(x => `<span class="chip" title="${escapeHtml(kbIdOf(x))}">${escapeHtml(kbLabel(x))}</span>`).join('') || '<span class="muted small">None</span>'}</div></div>
      ${canManage ? `<div class="flex"><button class="btn btn-secondary btn-sm" id="edit-settings">Edit bot settings</button><button class="btn btn-secondary btn-sm" id="edit-kb">Edit linked KBs</button></div>` : `<p class="tiny muted">🔒 Only owners/admins can edit.</p>`}</div>
      <div class="card"><h3>API key</h3><p class="small muted">Raw keys are shown once at creation. Paste yours in the Playground to test.</p>
      ${canManage ? `<button class="btn btn-secondary btn-sm mt1" id="regen">Regenerate key</button>` : ''}</div></div>
      <div class="card mt3"><h3>Allowed domains</h3>
        <p class="small muted">Add your website domains that may call this bot. One hostname per line — <span class="mono">mysite.com</span>, <span class="mono">www.mysite.com</span>. Subdomains must be listed separately; <span class="mono">*.example.com</span> is not supported. Leave empty to block all your sites (only our dashboard can reach the bot until you add a domain).</p>
        <div class="mt2" id="dom-list" style="display:flex;gap:6px;flex-wrap:wrap"></div>
        ${canManage ? `<div class="field mt2"><label for="dom-in">Add a domain</label><div class="flex"><input id="dom-in" placeholder="mysite.com" inputmode="url" autocomplete="off" style="flex:1;min-width:0;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text)"><button class="btn btn-secondary btn-sm" id="dom-add">Add</button></div><div class="hint">Bare hostname only — no <span class="mono">http://</span>, no path, no wildcards (<span class="mono">*.example.com</span> is rejected).</div><div class="error" id="dom-err" style="display:none;color:var(--danger);font-size:12px"></div></div>
        <div class="flex" style="flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="dom-save">Save domains</button><button class="btn btn-ghost btn-sm" id="dom-clear">Clear all</button></div>`
        : `<p class="tiny muted mt1">🔒 Only owners/admins can edit.</p>`}</div>
      ${canManage ? `<div class="danger-zone"><h3> Danger zone</h3><div class="flex between mt1"><span class="small">Delete this bot permanently.</span><button class="btn btn-danger btn-sm" id="del">Delete bot</button></div></div>` : ''}`;
    // ---- Allowed-domains editor (local draft, saved via PATCH) ----
    let draftDoms = getDomains(bot);
    const domList = tc.querySelector('#dom-list');
    const paintDoms = () => {
      if (!domList) return;
      domList.innerHTML = draftDoms.length
        ? draftDoms.map(d => `<span class="chip">${escapeHtml(d)}${canManage ? ` <button class="icon-btn btn-sm" data-rm="${escapeHtml(d)}" aria-label="Remove ${escapeHtml(d)}" style="min-width:0;min-height:0;padding:0 4px">✕</button>` : ''}</span>`).join('')
        : '<span class="muted small">No domains yet — only our dashboard can reach this bot until you add one.</span>';
      domList.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { draftDoms = draftDoms.filter(x => x !== b.dataset.rm); paintDoms(); });
    };
    paintDoms();
    tc.querySelector('#edit-settings')?.addEventListener('click', () => {
      const linkedIds = linked.map(kbIdOf);
      const { el, close } = openModal(`<div class="modal-head"><h3>Edit bot</h3><button class="icon-btn" data-close>✕</button></div>
        <div class="modal-body"><div class="field"><label for="bot-name">Name</label><input id="bot-name" value="${escapeHtml(bot.name || '')}" required></div>
        <div class="field"><label for="bot-description">Description</label><textarea id="bot-description" rows="2">${escapeHtml(bot.description || '')}</textarea></div>
        <div class="field"><label for="bot-prompt">System prompt</label><textarea id="bot-prompt" rows="5">${escapeHtml(bot.system_prompt || '')}</textarea></div>
        <div class="grid grid-2"><div class="field"><label for="bot-temperature">Temperature (0–1)</label><input id="bot-temperature" type="number" min="0" max="1" step="0.1" value="${Number.isFinite(Number(bot.temperature)) ? Number(bot.temperature) : 0.2}"></div>
        <div class="field"><label for="bot-tokens">Max tokens</label><input id="bot-tokens" type="number" min="1" max="4096" step="1" value="${Number.isFinite(Number(bot.max_tokens)) ? Number(bot.max_tokens) : 512}"></div></div>
        <div class="field"><label for="bot-domains">Allowed domains</label><textarea id="bot-domains" rows="3" placeholder="mysite.com">${escapeHtml(getDomains(bot).join('\n'))}</textarea><div class="hint">One hostname per line. Wildcards are not supported.</div></div>
        <div class="field"><label>Linked knowledge bases</label>${kbs.map(k => `<label class="kb-pick ${linkedIds.includes(String(k.id)) ? 'selected' : ''}"><input type="checkbox" name="bot-kb" value="${escapeHtml(k.id)}" ${linkedIds.includes(String(k.id)) ? 'checked' : ''}><span>${escapeHtml(k.name)}</span></label>`).join('') || '<p class="muted small">No knowledge bases available.</p>'}</div>
        <label class="small" style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input id="bot-active" type="checkbox" ${bot.is_active !== false ? 'checked' : ''}> Active</label><div id="bot-edit-error" class="error" role="alert"></div></div>
        <div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="bot-save">Save changes</button></div>`, { wide: true });
      el.querySelectorAll('[name="bot-kb"]').forEach(cb => cb.onchange = () => cb.closest('.kb-pick').classList.toggle('selected', cb.checked));
      el.querySelector('#bot-save').onclick = async (e) => {
        const btn = e.currentTarget, errBox = el.querySelector('#bot-edit-error');
        const name = el.querySelector('#bot-name').value.trim();
        const temperature = Number(el.querySelector('#bot-temperature').value), maxTokens = Number(el.querySelector('#bot-tokens').value);
        const domainsRaw = el.querySelector('#bot-domains').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const domains = [...new Set(domainsRaw.map(normalizeDomain).filter(Boolean))];
        const invalid = domainsRaw.filter(x => domainError(x));
        if (!name) { errBox.textContent = 'Name is required.'; return; }
        if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) { errBox.textContent = 'Temperature must be between 0 and 1.'; return; }
        if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) { errBox.textContent = 'Max tokens must be between 1 and 4096.'; return; }
        if (invalid.length) { errBox.textContent = `Invalid domain: ${invalid[0]}`; return; }
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…'; errBox.textContent = '';
        const payload = { name, description: el.querySelector('#bot-description').value.trim(), system_prompt: el.querySelector('#bot-prompt').value.trim(), temperature, max_tokens: maxTokens, is_active: el.querySelector('#bot-active').checked, [BOT_DOMAINS_FIELD]: domains, kb_ids: [...el.querySelectorAll('[name="bot-kb"]:checked')].map(cb => cb.value) };
        try {
          bot = await apiFetch(ENDPOINTS.botDetail(orgId, botId), { method: 'PATCH', body: payload });
          close(); toast('Bot updated', 'success'); draw(); page.querySelector('h2').textContent = bot.name || name;
        } catch (error) {
          errBox.textContent = error?.fields ? Object.entries(error.fields).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join(' · ') : (error.message || 'Could not update bot');
          btn.disabled = false; btn.textContent = 'Save changes';
        }
      };
    });
    const domIn = tc.querySelector('#dom-in'), domErr = tc.querySelector('#dom-err');
    tc.querySelector('#dom-add')?.addEventListener('click', () => {
      const err = domainError(domIn.value);
      if (err) { domErr.style.display = 'block'; domErr.textContent = err; return; }
      const d = normalizeDomain(domIn.value);
      if (draftDoms.includes(d)) { domErr.style.display = 'block'; domErr.textContent = 'That domain is already listed.'; return; }
      domErr.style.display = 'none'; draftDoms.push(d); domIn.value = ''; paintDoms(); domIn.focus();
    });
    domIn?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tc.querySelector('#dom-add').click(); } });
    tc.querySelector('#dom-clear')?.addEventListener('click', () => { draftDoms = []; paintDoms(); });
    tc.querySelector('#dom-save')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Saving…`;
      try {
        bot = await saveDomains(draftDoms);
        draftDoms = getDomains(bot);
        paintDoms();
        toast(draftDoms.length ? `Allowed domains saved (${draftDoms.length})` : 'Allowed domains cleared — only our dashboard can reach this bot', 'success');
      } catch (err) {
        const detail = err?.fields?.[BOT_DOMAINS_FIELD] ? ` — ${err.fields[BOT_DOMAINS_FIELD]}` : '';
        toast((err.message || 'Could not save domains') + detail, 'error');
      } finally { btn.disabled = false; btn.textContent = 'Save domains'; }
    });
    tc.querySelector('[data-c]')?.addEventListener('click', async (e) => { await copyText(e.target.dataset.c); toast('Copied', 'success'); });
    document.getElementById('edit-kb')?.addEventListener('click', () => {
      const cur = new Set(linked.map(kbIdOf));
      const { el, close } = openModal(`<div class="modal-head"><h3>Linked KBs</h3><button class="icon-btn" data-close>✕</button></div><div class="modal-body"><p class="small muted">Attach or detach KBs (must belong to this org). Empty selection detaches all.</p>${kbs.map(k => `<label class="kb-pick ${cur.has(String(k.id)) ? 'selected' : ''}"><input type="checkbox" value="${k.id}" ${cur.has(String(k.id)) ? 'checked' : ''}><span style="flex:1"><strong>${escapeHtml(k.name)}</strong></span></label>`).join('') || '<p class="muted small">No knowledge bases in this org.</p>'}</div><div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="sv">Save</button></div>`);
      el.querySelectorAll('.kb-pick input').forEach(cb => cb.onchange = () => cb.closest('.kb-pick').classList.toggle('selected', cb.checked));
      el.querySelector('#sv').onclick = async () => {
        const ids = [...el.querySelectorAll('input:checked')].map(i => i.value);
        try { bot = await apiFetch(ENDPOINTS.botDetail(orgId, botId), { method: 'PATCH', body: { kb_ids: ids } }); close(); toast(ids.length ? 'KBs attached' : 'All KBs detached', 'success'); draw(); }
        catch (e) { toast(e.message, 'error'); }
      };
    });
    document.getElementById('regen')?.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Regenerate API key?', body: 'The old key stops working immediately.', confirmText: 'Regenerate' })) return;
      try { const r = await apiFetch(ENDPOINTS.regenerateKey(orgId, botId), { method: 'POST' }); showKeyModal(r.api_key || r.key || r.raw_key, bot); }
      catch (e) { toast(e.message, 'error'); }
    });
    document.getElementById('del')?.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Delete bot?', body: `Type <span class="mono">${escapeHtml(bot.slug || bot.name)}</span> to confirm.`, confirmText: 'Delete', requireText: bot.slug || bot.name })) return;
      try { await apiFetch(ENDPOINTS.botDetail(orgId, botId), { method: 'DELETE' }); toast('Bot deleted', 'success'); location.href = 'bots.html'; }
      catch (e) { toast(e.message, 'error'); }
    });
  }
  if (tab === 'integration') {
    const curl = `curl -X POST "${endpoint}" \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"query": "What is your refund policy?", "session_id": "550e8400-e29b-41d4-a716-446655440000"}'`;
    const js = `const res = await fetch('${endpoint}', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer YOUR_API_KEY' },\n  body: JSON.stringify({ query: 'Hello!', session_id: crypto.randomUUID() })\n});\nconst data = await res.json(); // { answer, sources }`;
    const py = `import requests\nr = requests.post('${endpoint}',\n  headers={'Authorization': 'Bearer YOUR_API_KEY'},\n  json={'query': 'Hello!', 'session_id': 'uuid-here'})\nprint(r.json()['answer'])`;
    tc.innerHTML = `<div class="alert alert-warning">🔒 <strong>Security:</strong> never expose the bot API key in public frontend code — proxy through your backend.</div>
    <div class="alert alert-info mt2">🌐 Browser calls are only accepted from this bot's <strong>Allowed domains</strong> (Overview tab). <span class="mono">curl</span> / server-to-server calls are unaffected. <a href="bot.html?id=${botId}&tab=overview">Manage domains →</a></div>
    <div class="card mt2"><h3>Request format</h3><p class="small muted"><span class="mono">POST ${escapeHtml(endpoint)}</span> · header <span class="mono">Authorization: Bearer &lt;bot_api_key&gt;</span> · body <span class="mono">{"query", "session_id"}</span>. <span class="mono">session_id</span> is a UUID per conversation; the server remembers the last 10 messages.</p>
    <div class="tabs mt2"><button class="tab" aria-selected="true" data-s="curl">cURL</button><button class="tab" aria-selected="false" data-s="js">JavaScript</button><button class="tab" aria-selected="false" data-s="py">Python</button></div>
    <pre class="code-block" id="sn"></pre>
    <h4 class="mt2">Streaming response (NDJSON chunks)</h4><p class="small muted">The API streams one JSON object per chunk. Concatenate <span class="mono">token</span>; the final chunk has <span class="mono">"done": true</span>.</p><pre class="code-block">{"token": "Refunds are", "session_id": "550e8400-…"}\n{"token": " available within 30 days…", "session_id": "550e8400-…"}\n{"token": "", "session_id": "550e8400-…", "done": true}</pre>
    <h4 class="mt2">Errors</h4><div class="table-wrap"><table><thead><tr><th>Code</th><th>Meaning</th></tr></thead><tbody><tr><td class="mono">401/403</td><td>Invalid or missing API key</td></tr><tr><td class="mono">404</td><td>Unknown bot slug</td></tr><tr><td class="mono">429</td><td>Rate limited — back off and retry</td></tr><tr><td class="mono">5xx</td><td>Server/LLM error — retry</td></tr></tbody></table></div></div>`;
    const sn = tc.querySelector('#sn'); const map = { curl, js, py }; sn.textContent = curl;
    tc.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { tc.querySelectorAll('[data-s]').forEach(x => x.setAttribute('aria-selected', 'false')); b.setAttribute('aria-selected', 'true'); sn.textContent = map[b.dataset.s]; });
  }
  if (tab === 'playground') {
    // Internal test chat: user-JWT auth, no bot API key needed.
    tc.innerHTML = `<div class="card"><h3>Playground</h3><p class="small muted">Internal test chat — sends with your login session, no API key needed.</p>
    <div id="chat"></div></div>`;
    mountChat(tc.querySelector('#chat'), { url: API_BASE_URL + ENDPOINTS.botTestChat(orgId, botId), auth: 'jwt', starterQuestions: ['What documents do you know about?', 'Summarize the refund policy.', 'How do I get started?'] });
  }
  if (tab === 'usage') tc.innerHTML = `<div class="card"><h3>Usage</h3><p class="muted">Per-key usage tracking is <span class="badge b-pending">Coming soon</span>.</p></div>`;
}
draw();
