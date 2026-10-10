import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext, currentRole } from '../components/org-switcher.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS } from '../config.js';
import { toast, openModal, skeletonList, emptyState, setFieldError, copyTextFallback } from '../ui.js';
import { escapeHtml, formatDate, debounce, copyText } from '../utils.js';
initTheme();
await guard('bots.html');
const { orgId, org } = await getOrgContext();
const role = currentRole(org);
const canManage = role === 'owner' || role === 'admin';
const page = document.getElementById('page');
let bots = [], kbs = [], q = '';
page.innerHTML = `<div class="page-head"><div><h2>Bots</h2><p class="muted">Chatbots grounded in your knowledge bases.</p></div><button class="btn btn-primary" id="new">+ New Bot</button></div>
<div class="search-input" style="max-width:380px"><span>🔍</span><input id="q" placeholder="Search bots…" aria-label="Search bots"></div><div id="list" class="mt2"></div>`;
async function load() {
  document.getElementById('list').innerHTML = skeletonList(3);
  try { [bots, kbs] = await Promise.all([apiFetch(ENDPOINTS.bots(orgId), { cacheTtl: 15000 }).then(asList), apiFetch(ENDPOINTS.kbs(orgId), { cacheTtl: 15000 }).then(asList).catch(() => [])]); }
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
    const lbl = (x) => typeof x === 'string' ? kbName(x) : (x.name || x.id);
    return `<div class="card hoverable"><h3>${escapeHtml(b.name)}</h3><p class="mono small muted">/${escapeHtml(b.slug || '')}</p>
    <div class="mt1" style="display:flex;gap:6px;flex-wrap:wrap">${linked.map(x => `<span class="chip">${escapeHtml(lbl(x))}</span>`).join('') || '<span class="tiny muted">No KBs linked</span>'}</div>
    <p class="tiny muted mt1">Created ${formatDate(b.created_at)}</p>
    <div class="flex mt2"><a class="btn btn-secondary btn-sm" href="bot.html?id=${b.id}">Open</a><a class="btn btn-ghost btn-sm" href="bot.html?id=${b.id}&tab=playground">Test →</a></div></div>`;
  }).join('') + `</div>`;
}
/** 4-step wizard */
function openWizard() {
  if (!canManage) { toast('Only owners and admins can do this.', 'error'); return; }
  if (!kbs.length) { toast('Create a knowledge base first.', 'error'); location.href = 'knowledge-bases.html'; return; }
  let step = 1, draft = { name: '', description: '', kb_ids: [], system_prompt: '', temperature: 0.2, max_tokens: 512 };
  const { el, close } = openModal(`<div class="modal-head"><h3>Create bot</h3><button class="icon-btn" data-close>✕</button></div><div class="modal-body" id="wz"></div>`, { wide: true });
  const body = el.querySelector('#wz');
  function draw() {
    body.innerHTML = `<div class="stepper">${['Details', 'Knowledge', 'Settings', 'Review'].map((l, i) => `<div class="step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}"><div class="dot">${step > i + 1 ? '✓' : i + 1}</div>${l}</div>`).join('')}</div><div id="ws"></div>
    <div class="flex between mt3"><button class="btn btn-ghost" id="wb" ${step === 1 ? 'disabled' : ''}>← Back</button><button class="btn btn-primary" id="wn">${step === 4 ? 'Create bot' : 'Next →'}</button></div>`;
    const s = body.querySelector('#ws');
    if (step === 1) s.innerHTML = `<div class="field"><label>Bot name</label><input id="wn2" value="${escapeHtml(draft.name)}" placeholder="Support Bot"><div class="error"></div></div><div class="field"><label>Description</label><textarea id="wd" rows="3" placeholder="Helps customers with…">${escapeHtml(draft.description)}</textarea></div>`;
    if (step === 2) {
      s.innerHTML = `<div class="field"><label>Select knowledge bases (one or more)</label>
        <div class="search-input"><span>🔍</span><input id="kbq" placeholder="Search knowledge bases…" aria-label="Search knowledge bases"></div>
        <div class="flex between mt1"><span class="small muted" id="kbc"></span><span><button class="btn btn-ghost btn-sm" id="kball">Select all</button><button class="btn btn-ghost btn-sm" id="kbnone">Clear</button></span></div>
        <div id="kblist" class="mt1"></div></div>`;
      const list = s.querySelector('#kblist');
      const paint = (f = '') => {
        const items = kbs.filter(k => (k.name || '').toLowerCase().includes(f.toLowerCase()));
        s.querySelector('#kbc').textContent = `${draft.kb_ids.length} of ${kbs.length} selected`;
        list.innerHTML = items.length ? items.map(k => {
          const sel = draft.kb_ids.includes(String(k.id));
          const dc = k.document_count ?? k.documents_count ?? (Array.isArray(k.documents) ? k.documents.length : null) ?? (Array.isArray(k.files) ? k.files.length : null);
          return `<label class="kb-pick ${sel ? 'selected' : ''}"><input type="checkbox" value="${k.id}" ${sel ? 'checked' : ''}><span style="flex:1;min-width:0"><strong>${escapeHtml(k.name)}</strong><br><span class="tiny muted">${dc ?? '?'} docs${k.description ? ' · ' + escapeHtml(k.description) : ''}</span></span></label>`;
        }).join('') : `<p class="muted small">No knowledge bases match.</p>`;
        list.querySelectorAll('input').forEach(cb => cb.onchange = () => {
          const id = String(cb.value);
          if (cb.checked && !draft.kb_ids.includes(id)) draft.kb_ids.push(id);
          if (!cb.checked) draft.kb_ids = draft.kb_ids.filter(x => x !== id);
          cb.closest('.kb-pick').classList.toggle('selected', cb.checked);
          s.querySelector('#kbc').textContent = `${draft.kb_ids.length} of ${kbs.length} selected`;
        });
      };
      paint();
      s.querySelector('#kbq').oninput = (e) => paint(e.target.value);
      s.querySelector('#kball').onclick = (e) => { e.preventDefault(); draft.kb_ids = kbs.map(k => String(k.id)); paint(s.querySelector('#kbq').value); };
      s.querySelector('#kbnone').onclick = (e) => { e.preventDefault(); draft.kb_ids = []; paint(s.querySelector('#kbq').value); };
    }
    if (step === 3) {
      s.innerHTML = `<div class="field"><label for="wsp">System prompt</label><textarea id="wsp" rows="4" placeholder="Answer only using provided context.">${escapeHtml(draft.system_prompt)}</textarea><div class="hint">Guides how the bot answers. Optional.</div></div>
      <div class="grid grid-2"><div class="field"><label for="wt">Temperature: <span id="tv">${draft.temperature}</span></label><input id="wt" type="range" min="0" max="1" step="0.1" value="${draft.temperature}"><div class="hint">Lower = focused, higher = creative.</div></div>
      <div class="field"><label for="wmt">Max tokens</label><input id="wmt" type="number" min="1" max="4096" step="1" value="${draft.max_tokens}"><div class="hint">Max reply length.</div></div></div>`;
      const wt = s.querySelector('#wt');
      wt.oninput = () => { s.querySelector('#tv').textContent = wt.value; };
    }
    if (step === 4) s.innerHTML = `<div class="card"><h4>${escapeHtml(draft.name || '(unnamed)')}</h4><p class="small muted">${escapeHtml(draft.description || 'No description')}</p><div class="mt1" style="display:flex;gap:6px;flex-wrap:wrap">${draft.kb_ids.map(id => `<span class="chip">${escapeHtml(kbName(id))}</span>`).join('')}</div>
      <div class="small muted mt2">Temperature <span class="mono">${draft.temperature}</span> · Max tokens <span class="mono">${draft.max_tokens}</span>${draft.system_prompt ? `<br>System prompt: “${escapeHtml(draft.system_prompt.slice(0, 120))}${draft.system_prompt.length > 120 ? '…' : ''}”` : ''}</div></div>`;
    body.querySelector('#wb').onclick = () => { if (step > 1) { step--; draw(); } };
    body.querySelector('#wn').onclick = async (e) => {
      const nextBtn = e.currentTarget;
      if (step === 1) { draft.name = body.querySelector('#wn2').value.trim(); draft.description = body.querySelector('#wd').value.trim(); if (!draft.name) { toast('Name is required.', 'error'); return; } }
      if (step === 2 && !draft.kb_ids.length) { toast('Select at least one KB.', 'error'); return; }
      if (step === 3) {
        draft.system_prompt = body.querySelector('#wsp').value.trim();
        draft.temperature = Math.min(1, Math.max(0, Number(body.querySelector('#wt').value) || 0));
        draft.max_tokens = Math.min(4096, Math.max(1, parseInt(body.querySelector('#wmt').value, 10) || 512));
      }
      if (step < 4) { step++; draw(); return; }
      nextBtn.disabled = true; nextBtn.innerHTML = `<span class="spinner"></span> Creating…`;
      try {
        // 1. Create has NO KB field — only name (+ optional settings).
        const payload = { name: draft.name, system_prompt: draft.system_prompt, temperature: draft.temperature, max_tokens: draft.max_tokens };
        if (draft.description) payload.description = draft.description;
        const created = await apiFetch(ENDPOINTS.bots(orgId), { method: 'POST', body: payload });
        const botId = created.id || created.pk || created.uuid;
        // 2. Attach KBs via PATCH {kb_ids} (must belong to same org).
        let attachWarn = '';
        if (botId && draft.kb_ids.length) {
          try {
            await apiFetch(ENDPOINTS.botDetail(orgId, botId), { method: 'PATCH', body: { kb_ids: draft.kb_ids } });
            const check = await apiFetch(ENDPOINTS.botDetail(orgId, botId));
            const linked = check.kbs || check.knowledge_bases || check.kb_ids || [];
            if (!linked.length) attachWarn = 'Bot created, but no KBs appear linked — verify the KBs belong to this org.';
          } catch (ae) { attachWarn = `Bot created, but KB attach failed: ${ae.message}`; }
        }
        close();
        showKeyModal(created.api_key || created.key || created.raw_key, { ...created, id: botId });
        if (attachWarn) toast(attachWarn, 'error'); else toast('Bot created with KBs attached', 'success');
        load();
      } catch (err) {
        toast(err.message || 'Bot creation failed', 'error');
        nextBtn.disabled = false; nextBtn.textContent = 'Create bot';
      }
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
