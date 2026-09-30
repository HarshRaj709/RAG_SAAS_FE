import { apiFetch } from '../api.js';
import { ENDPOINTS } from '../config.js';
import { escapeHtml, uuid, copyText, timeAgo } from '../utils.js';
import { toast } from '../ui.js';

/** Full chat playground. mount(el, {slug, getKey}) */
export function mountChat(el, { slug, getKey, starterQuestions = [] }) {
  let sessionId = uuid();
  let loading = false;
  const msgs = [];
  el.innerHTML = `
    <div class="chat-shell">
      <div class="chat-msgs" id="cm" aria-live="polite"></div>
      <div class="starter-chips" id="chips">${starterQuestions.map(q => `<button class="btn btn-secondary btn-sm" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}</div>
      <div class="chat-input-bar">
        <textarea id="ci" rows="2" placeholder="Ask about your documents… (Enter to send)" aria-label="Chat message"></textarea>
        <button class="btn btn-primary" id="cs">Send</button>
      </div>
      <div class="tiny muted" style="padding:8px 16px;border-top:1px solid var(--border)">Bot remembers the last 10 messages · session <span class="mono">${sessionId.slice(0, 8)}</span> · <button class="btn btn-ghost btn-sm" id="newchat">New chat</button> · <button class="btn btn-ghost btn-sm" id="copychat">Copy</button></div>
    </div>`;
  const box = el.querySelector('#cm'), input = el.querySelector('#ci'), send = el.querySelector('#cs');
  function render() {
    box.innerHTML = msgs.map((m, i) => `
      <div class="msg-row ${m.role === 'user' ? 'me' : ''}">
        <div style="max-width:78%">
          <div class="chat-bubble ${m.role === 'user' ? 'chat-user' : 'chat-assistant'}">${m.role === 'assistant' ? m.html : escapeHtml(m.text)}</div>
          <div class="msg-meta">${timeAgo(m.at)} ${m.error ? `<button class="btn btn-ghost btn-sm" data-retry="${i}">Retry</button>` : ''}</div>
          ${m.sources?.length ? `<details class="sources"><summary>Sources (${m.sources.length})</summary>${m.sources.map(s => `<div class="src-item">📄 ${escapeHtml(s.filename || s.source || 'chunk')} ${s.score ? `<span class="muted mono">${Number(s.score).toFixed(2)}</span>` : ''}${s.text ? `<div class="small muted">${escapeHtml(String(s.text).slice(0, 220))}…</div>` : ''}</div>`).join('')}</details>` : ''}
        </div></div>`).join('') + (loading ? `<div class="msg-row"><div class="chat-bubble chat-assistant"><span class="typing"><span></span><span></span><span></span></span></div></div>` : '');
    box.scrollTop = box.scrollHeight;
    box.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => { const m = msgs[Number(b.dataset.retry) - 1]; if (m) doSend(m.text); });
  }
  function md(text) {
    let h = escapeHtml(text);
    h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => `<pre class="code-block">${c}<button class="btn btn-secondary btn-sm copy-btn" data-copy="${encodeURIComponent(c)}">Copy</button></pre>`);
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
    return window.DOMPurify ? DOMPurify.sanitize(h) : h;
  }
  async function doSend(text) {
    text = (text ?? input.value).trim();
    if (!text || loading) return;
    const key = getKey();
    if (!key) { toast('Paste your bot API key above to test.', 'error'); return; }
    input.value = '';
    msgs.push({ role: 'user', text, at: new Date().toISOString() });
    loading = true; render();
    try {
      const res = await apiFetch(ENDPOINTS.publicChat(slug), { method: 'POST', body: { query: text, session_id: sessionId }, auth: false, botKey: key });
      const answer = res.answer || res.response || res.output || JSON.stringify(res);
      msgs.push({ role: 'assistant', text: answer, html: md(answer), sources: res.sources || res.citations || res.chunks || [], at: new Date().toISOString() });
    } catch (e) {
      const hint = e.status === 401 || e.status === 403 ? 'Invalid API key.' : e.status === 404 ? 'Bot not found.' : e.status === 429 ? 'Rate limited — wait and retry.' : e.message;
      msgs.push({ role: 'assistant', text: '', html: `<span style="color:var(--danger)">⚠️ ${escapeHtml(hint)}</span>`, error: true, at: new Date().toISOString() });
    } finally { loading = false; render(); bindCopies(); }
  }
  function bindCopies() { box.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { await copyText(decodeURIComponent(b.dataset.copy)); toast('Copied', 'success'); }); }
  send.onclick = () => doSend();
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } };
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => doSend(b.dataset.q));
  el.querySelector('#newchat').onclick = () => { sessionId = uuid(); msgs.length = 0; render(); toast('New conversation started', 'info'); };
  el.querySelector('#copychat').onclick = async () => { await copyText(msgs.map(m => `${m.role}: ${m.text}`).join('\n\n')); toast('Conversation copied', 'success'); };
  msgs.push({ role: 'assistant', text: '', html: `👋 Hi! I'm connected to this bot's knowledge bases. Ask me anything grounded in your documents.`, at: new Date().toISOString() });
  render();
  return { newSession() { sessionId = uuid(); msgs.length = 0; render(); } };
}
