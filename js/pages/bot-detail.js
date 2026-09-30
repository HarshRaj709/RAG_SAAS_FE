import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext, currentRole } from '../components/org-switcher.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS, API_BASE_URL } from '../config.js';
import { toast, confirmDialog, skeletonList, emptyState, openModal, copyTextFallback } from '../ui.js';
import { escapeHtml, copyText, qp, formatDate } from '../utils.js';
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
try { bot = await apiFetch(ENDPOINTS.botDetail(orgId, botId)); } catch (e) { page.innerHTML = emptyState('⚠️', 'Bot not found', escapeHtml(e.message), `<a class="btn btn-primary" href="bots.html">Back</a>`); throw 0; }
try { kbs = asList(await apiFetch(ENDPOINTS.kbs(orgId))); } catch { kbs = []; }
let tab = qp('tab', 'overview');
const endpoint = `${API_BASE_URL}${ENDPOINTS.publicChat(bot.slug)}`;
const kbName = (id) => kbs.find(k => String(k.id) === String(id))?.name || String(id).slice(0, 8);
page.innerHTML = `
  <p><a href="bots.html">← Bots</a></p>
  <div class="page-head"><div><h2>${escapeHtml(bot.name)}</h2><p class="mono muted small">/${escapeHtml(bot.slug || '')} · created ${formatDate(bot.created_at)}</p></div>
  <a class="btn btn-primary btn-sm" href="bot.html?id=${botId}&tab=playground">Open playground →</a></div>
  <div class="tabs" role="tablist">${['overview', 'integration', 'playground', 'usage'].map(t => `<button class="tab" data-tab="${t}" aria-selected="${tab === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
  <div id="tc"></div>`;
const tc = document.getElementById('tc');
function switchTab(t) { tab = t; history.replaceState(null, '', `?id=${botId}&tab=${t}`); page.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === t)); draw(); }
page.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
function draw() {
  if (tab === 'overview') {
    const linked = bot.knowledge_bases || bot.kbs || bot.kb_ids || [];
    const kbLabel = (x) => typeof x === 'string' ? kbName(x) : (x.name || x.id);
    const kbIdOf = (x) => String(typeof x === 'string' ? x : (x.id || x.pk || ''));
    tc.innerHTML = `<div class="grid grid-2"><div class="card"><h3>Details</h3>
      <p class="small mt1">Endpoint</p><div class="code-block">POST ${escapeHtml(endpoint)} <button class="btn btn-secondary btn-sm copy-btn" data-c="${escapeHtml(endpoint)}">Copy</button></div>
      <div class="field mt2"><label>Linked knowledge bases</label><div class="flex" style="flex-wrap:wrap">${linked.map(x => `<span class="chip" title="${escapeHtml(kbIdOf(x))}">${escapeHtml(kbLabel(x))}</span>`).join('') || '<span class="muted small">None</span>'}</div></div>
      ${canManage ? `<button class="btn btn-secondary btn-sm" id="edit-kb">Edit linked KBs</button>` : `<p class="tiny muted">🔒 Only owners/admins can edit.</p>`}</div>
      <div class="card"><h3>API key</h3><p class="small muted">Raw keys are shown once at creation. Paste yours in the Playground to test.</p>
      ${canManage ? `<button class="btn btn-secondary btn-sm mt1" id="regen">Regenerate key</button>` : ''}</div></div>
      ${canManage ? `<div class="danger-zone"><h3> Danger zone</h3><div class="flex between mt1"><span class="small">Delete this bot permanently.</span><button class="btn btn-danger btn-sm" id="del">Delete bot</button></div></div>` : ''}`;
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
    <div class="card mt2"><h3>Request format</h3><p class="small muted"><span class="mono">POST ${escapeHtml(endpoint)}</span> · header <span class="mono">Authorization: Bearer &lt;bot_api_key&gt;</span> · body <span class="mono">{"query", "session_id"}</span>. <span class="mono">session_id</span> is a UUID per conversation; the server remembers the last 10 messages.</p>
    <div class="tabs mt2"><button class="tab" aria-selected="true" data-s="curl">cURL</button><button class="tab" aria-selected="false" data-s="js">JavaScript</button><button class="tab" aria-selected="false" data-s="py">Python</button></div>
    <pre class="code-block" id="sn"></pre>
    <h4 class="mt2">Streaming response (NDJSON chunks)</h4><p class="small muted">The API streams one JSON object per chunk. Concatenate <span class="mono">token</span>; the final chunk has <span class="mono">"done": true</span>.</p><pre class="code-block">{"token": "Refunds are", "session_id": "550e8400-…"}\n{"token": " available within 30 days…", "session_id": "550e8400-…"}\n{"token": "", "session_id": "550e8400-…", "done": true}</pre>
    <h4 class="mt2">Errors</h4><div class="table-wrap"><table><thead><tr><th>Code</th><th>Meaning</th></tr></thead><tbody><tr><td class="mono">401/403</td><td>Invalid or missing API key</td></tr><tr><td class="mono">404</td><td>Unknown bot slug</td></tr><tr><td class="mono">429</td><td>Rate limited — back off and retry</td></tr><tr><td class="mono">5xx</td><td>Server/LLM error — retry</td></tr></tbody></table></div></div>`;
    const sn = tc.querySelector('#sn'); const map = { curl, js, py }; sn.textContent = curl;
    tc.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { tc.querySelectorAll('[data-s]').forEach(x => x.setAttribute('aria-selected', 'false')); b.setAttribute('aria-selected', 'true'); sn.textContent = map[b.dataset.s]; });
  }
  if (tab === 'playground') {
    tc.innerHTML = `<div class="card"><h3>Playground</h3><p class="small muted">Paste your bot API key to test. It is kept only in <span class="mono">sessionStorage</span> for this tab — never localStorage — because raw keys can't be retrieved after creation.</p>
    <div class="field mt1"><label>Bot API key</label><div class="flex"><input id="bk" type="password" placeholder="rag_…" autocomplete="off" style="flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text)"><button class="btn btn-secondary btn-sm" id="bks">Save for session</button></div></div>
    <div id="chat"></div></div>`;
    const inp = tc.querySelector('#bk');
    inp.value = sessionStorage.getItem('play_' + botId) || '';
    tc.querySelector('#bks').onclick = () => { sessionStorage.setItem('play_' + botId, inp.value.trim()); toast(inp.value.trim() ? 'Key saved for this tab session' : 'Key cleared', 'info'); };
    mountChat(tc.querySelector('#chat'), { slug: bot.slug, getKey: () => tc.querySelector('#bk').value.trim() || sessionStorage.getItem('play_' + botId) || '', starterQuestions: ['What documents do you know about?', 'Summarize the refund policy.', 'How do I get started?'] });
  }
  if (tab === 'usage') tc.innerHTML = `<div class="card"><h3>Usage</h3><p class="muted">Per-key usage tracking is <span class="badge b-pending">Coming soon</span>.</p></div>`;
}
draw();
