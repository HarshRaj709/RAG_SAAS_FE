import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext } from '../components/org-switcher.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS } from '../config.js';
import { toast, openModal, skeletonList, emptyState, setFieldError, copyTextFallback } from '../ui.js';
import { escapeHtml, formatDate, debounce, copyText } from '../utils.js';
initTheme();
await guard('bots.html');
const { orgId, org } = await getOrgContext();
const role = store.getUser()?.role || org?.role || 'member';
const canManage = role === 'owner' || role === 'admin';
const page = document.getElementById('page');
let bots = [], kbs = [], q = '';
page.innerHTML = `<div class="page-head"><div><h2>Bots</h2><p class="muted">Chatbots grounded in your knowledge bases.</p></div><button class="btn btn-primary" id="new">+ New Bot</button></div>
<div class="search-input" style="max-width:380px"><span>🔍</span><input id="q" placeholder="Search bots…" aria-label="Search bots"></div><div id="list" class="mt2"></div>`;
async function load() {
  document.getElementById('list').innerHTML = skeletonList(3);
  try { [bots, kbs] = [asList(await apiFetch(ENDPOINTS.bots(orgId))), asList(await apiFetch(ENDPOINTS.kbs(orgId)).catch(() => []))]; }
  catch (e) { document.getElementById('list').innerHTML = emptyState('⚠️', 'Could not load', escapeHtml(e.message), `<button class="btn btn-primary" onclick="location.reload()">Retry</button>`); return; }
  render();
}
function kbName(id) { return kbs.find(k => String(k.id) === String(id))?.name || String(id).slice(0, 8); }
function render() {
  const list = document.getElementById('list');
  const f = bots.filter(b => (b.name + b.slug).toLowerCase().includes(q.toLowerCase()));
  if (!f.length) { list.innerHTML = emptyState('🤖', q ? 'No matches' : 'No bots yet', 'Create a bot linked to one or more knowledge bases.', canManage ? `<button class="btn btn-primary" id="e-new">Create bot</button>` : ''); document.getElementById('e-new')?.addEventListener('click', openWizard); return; }
  list.innerHTML = `<div class="kb-grid">` + f.map(b => {
    const linked = b.knowledge_bases || b.kbs || b.kb_ids || [];
    return `<div class="card hoverable"><h3>${escapeHtml(b.name)}</h3><p class="mono small muted">/${escapeHtml(b.slug || '')}</p>
    <div class="mt1" style="display:flex;gap:6px;flex-wrap:wrap">${linked.map(id => `<span class="chip">${escapeHtml(kbName(id))}</span>`).join('') || '<span class="tiny muted">No KBs linked</span>'}</div>
    <p class="tiny muted mt1">Created ${formatDate(b.created_at)}</p>
    <div class="flex mt2"><a class="btn btn-secondary btn-sm" href="bot.html?id=${b.id}">Open</a><a class="btn btn-ghost btn-sm" href="bot.html?id=${b.id}&tab=playground">Test →</a></div></div>`;
  }).join('') + `</div>`;
}
/** 4-step wizard */
function openWizard() {
  if (!canManage) { toast('Only owners and admins can do this.', 'error'); return; }
  if (!kbs.length) { toast('Create a knowledge base first.', 'error'); location.href = 'knowledge-bases.html'; return; }
  let step = 1, draft = { name: '', description: '', kb_ids: [], temperature: 0.7 };
  const { el, close } = openModal(`<div class="modal-head"><h3>Create bot</h3><button class="icon-btn" data-close>✕</button></div><div class="modal-body" id="wz"></div>`, { wide: true });
  const body = el.querySelector('#wz');
  function draw() {
    body.innerHTML = `<div class="stepper">${['Details', 'Knowledge', 'Settings', 'Review'].map((l, i) => `<div class="step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}"><div class="dot">${step > i + 1 ? '✓' : i + 1}</div>${l}</div>`).join('')}</div><div id="ws"></div>
    <div class="flex between mt3"><button class="btn btn-ghost" id="wb" ${step === 1 ? 'disabled' : ''}>← Back</button><button class="btn btn-primary" id="wn">${step === 4 ? 'Create bot' : 'Next →'}</button></div>`;
    const s = body.querySelector('#ws');
    if (step === 1) s.innerHTML = `<div class="field"><label>Bot name</label><input id="wn2" value="${escapeHtml(draft.name)}" placeholder="Support Bot"><div class="error"></div></div><div class="field"><label>Description</label><textarea id="wd" rows="3" placeholder="Helps customers with…">${escapeHtml(draft.description)}</textarea></div>`;
    if (step === 2) s.innerHTML = `<div class="field"><label>Select knowledge bases (one or more)</label>${kbs.map(k => `<label class="check-item" style="cursor:pointer"><input type="checkbox" value="${k.id}" ${draft.kb_ids.includes(String(k.id)) ? 'checked' : ''}> <span><strong>${escapeHtml(k.name)}</strong><br><span class="tiny muted">${k.document_count ?? '?'} docs</span></span></label>`).join('')}</div>`;
    if (step === 3) s.innerHTML = `<div class="alert alert-info">LLM tuning (system prompt, temperature, max tokens) is <strong>Coming soon</strong> — shown disabled until the API supports it.</div>
      <div class="field"><label>System prompt</label><textarea disabled placeholder="Coming soon"></textarea></div>
      <div class="field"><label>Temperature: <span id="tv">${draft.temperature}</span></label><input type="range" min="0" max="1" step="0.1" value="${draft.temperature}" disabled></div>`;
    if (step === 4) s.innerHTML = `<div class="card"><h4>${escapeHtml(draft.name || '(unnamed)')}</h4><p class="small muted">${escapeHtml(draft.description || 'No description')}</p><div class="mt1">${draft.kb_ids.map(id => `<span class="chip">${escapeHtml(kbName(id))}</span>`).join('')}</div></div>`;
    body.querySelector('#wb').onclick = () => { if (step > 1) { step--; draw(); } };
    body.querySelector('#wn').onclick = async () => {
      if (step === 1) { draft.name = body.querySelector('#wn2').value.trim(); draft.description = body.querySelector('#wd').value.trim(); if (!draft.name) { toast('Name is required.', 'error'); return; } }
      if (step === 2) { draft.kb_ids = [...body.querySelectorAll('input:checked')].map(i => i.value); if (!draft.kb_ids.length) { toast('Select at least one KB.', 'error'); return; } }
      if (step < 4) { step++; draw(); return; }
      try {
        // TODO(verify): bot create payload keys (knowledge_base_ids vs kb_ids) per Postman.
        const created = await apiFetch(ENDPOINTS.bots(orgId), { method: 'POST', body: { name: draft.name, description: draft.description, knowledge_base_ids: draft.kb_ids, kb_ids: draft.kb_ids } });
        close(); showKeyModal(created.api_key || created.key || created.raw_key, created); load();
      } catch (e) { toast(e.message, 'error'); }
    };
  }
  draw();
}
/** Blocking one-time key modal */
export function showKeyModal(rawKey, bot) {
  if (!rawKey) { toast('Bot created. (API did not return a raw key — check docs.)', 'info'); return; }
  const { el } = openModal(`<div class="modal-head"><h3>🔑 Save your API key</h3></div><div class="modal-body">
    <div class="alert alert-warning"><strong>Shown only once.</strong> We store only a hash. If you lose it, you must generate a new one.</div>
    <div class="key-reveal mt2"><span style="flex:1" id="rk">${escapeHtml(rawKey)}</span><button class="btn btn-secondary btn-sm" id="cp">Copy</button></div>
    <label class="small mt2" style="display:flex;gap:8px"><input type="checkbox" id="ack"> I've saved this key somewhere safe</label>
    </div><div class="modal-foot"><button class="btn btn-primary" id="done" disabled>Done</button></div>`);
  el.querySelector('#cp').onclick = async () => { await copyText(rawKey); toast('API key copied', 'success'); };
  el.querySelector('#ack').onchange = (e) => el.querySelector('#done').disabled = !e.target.checked;
  el.querySelector('#done').onclick = () => { el.querySelector('#rk').textContent = '••••••••'; document.getElementById('modal-root').innerHTML = ''; document.getElementById('modal-root').classList.remove('open'); if (bot?.id) location.href = `bot.html?id=${bot.id}`; };
}
document.getElementById('new').onclick = openWizard;
document.getElementById('q').oninput = debounce((e) => { q = e.target.value; render(); }, 250);
await load();
