import { ENDPOINTS, API_BASE_URL } from '../config.js';
import { escapeHtml, uuid, copyText, timeAgo } from '../utils.js';
import { toast } from '../ui.js';

/**
 * Pull complete {...} JSON objects out of a stream buffer.
 * Handles NDJSON lines, SSE `data:` payloads, and concatenated objects.
 */
function pullObjects(buf) {
  const out = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start !== -1) { out.push(buf.slice(start, i + 1)); start = -1; } }
  }
  return { out, rest: start !== -1 ? buf.slice(start) : '' };
}

/** Full chat playground (streaming). mount(el, {slug, getKey}) */
export function mountChat(el, { slug, getKey, starterQuestions = [] }) {
  let sessionId = uuid();
  let loading = false, streaming = false, streamCtrl = null;
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
          <div class="chat-bubble ${m.role === 'user' ? 'chat-user' : 'chat-assistant'}">${m.role === 'assistant' ? m.html + (m.streaming ? '<span class="stream-cursor">▍</span>' : '') : escapeHtml(m.text)}</div>
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
  function fail(hint) {
    msgs.push({ role: 'assistant', text: '', html: `<span style="color:var(--danger)">⚠️ ${escapeHtml(hint)}</span>`, error: true, at: new Date().toISOString() });
  }
  function errHint(status, message) {
    if (status === 401 || status === 403) return 'Invalid API key.';
    if (status === 404) return 'Bot not found.';
    if (status === 429) return 'Rate limited — wait and retry.';
    return message || `Request failed (${status})`;
  }
  async function doSend(text) {
    text = (text ?? input.value).trim();
    if (!text || loading || streaming) return;
    const key = getKey();
    if (!key) { toast('Paste your bot API key above to test.', 'error'); return; }
    input.value = '';
    msgs.push({ role: 'user', text, at: new Date().toISOString() });
    loading = true; render();
    const amsg = { role: 'assistant', text: '', html: '', sources: [], streaming: true, at: new Date().toISOString() };
    streamCtrl = new AbortController();
    // Give the stream up to 5 min; no per-chunk timeout.
    const killer = setTimeout(() => streamCtrl.abort('timeout'), 5 * 60 * 1000);
    try {
      const res = await fetch(API_BASE_URL + ENDPOINTS.publicChat(slug), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ query: text, session_id: sessionId }),
        signal: streamCtrl.signal,
      });
      if (!res.ok) {
        let detail = '';
        try { const ej = await res.json(); detail = ej.detail || ej.message || JSON.stringify(ej); } catch { /* ignore */ }
        loading = false; render();
        fail(errHint(res.status, detail));
        return;
      }
      // First byte received → swap typing dots for the live bubble.
      loading = false; streaming = true; msgs.push(amsg); send.textContent = 'Stop'; render();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', done = false;
      const paint = () => { amsg.html = amsg.text ? md(amsg.text) : ''; render(); };
      const onObject = (o) => {
        if (o.session_id) sessionId = o.session_id;
        if (o.done) { done = true; return; }
        if (typeof o.token === 'string' && o.token) { amsg.text += o.token; paint(); return; }
        if (typeof o.answer === 'string' && !amsg.text) { amsg.text = o.answer; paint(); return; }
        const src = o.sources || o.citations || o.chunks;
        if (Array.isArray(src) && src.length) amsg.sources = src;
      };
      while (!done) {
        const { done: rdDone, value } = await reader.read();
        if (rdDone) break;
        buf += decoder.decode(value, { stream: true });
        buf = buf.replace(/\[DONE\]/g, '');
        const { out, rest } = pullObjects(buf);
        buf = rest;
        for (const raw of out) {
          try { onObject(JSON.parse(raw)); } catch { /* ignore partial */ }
          if (done) break;
        }
      }
      if (buf.trim()) { try { onObject(JSON.parse(buf)); } catch { /* ignore */ } }
      if (!amsg.text && !done) fail('Empty response from bot.');
    } catch (e) {
      loading = false;
      if (e?.name === 'AbortError' && streaming) {
        if (!amsg.text) fail('Request stopped.');
        else { amsg.text += '\n\n*(stopped)*'; toast('Stopped', 'info'); }
      } else {
        fail(e?.message || 'Network error. Is the backend running?');
      }
      // Remove the live bubble if it was never added (pre-stream failure).
      if (!msgs.includes(amsg) && amsg.text) msgs.push(amsg);
      else if (!msgs.includes(amsg)) { /* fail() already pushed */ }
    } finally {
      clearTimeout(killer);
      loading = false; streaming = false; amsg.streaming = false;
      if (msgs.includes(amsg) && !amsg.text && !amsg.sources.length) msgs.splice(msgs.indexOf(amsg), 1);
      if (msgs.includes(amsg) && amsg.text) amsg.html = md(amsg.text);
      send.textContent = 'Send';
      render(); bindCopies();
    }
  }
  function bindCopies() { box.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { await copyText(decodeURIComponent(b.dataset.copy)); toast('Copied', 'success'); }); }
  send.onclick = () => { if (streaming && streamCtrl) streamCtrl.abort('stop'); else doSend(); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } };
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => doSend(b.dataset.q));
  el.querySelector('#newchat').onclick = () => { if (streaming && streamCtrl) streamCtrl.abort('stop'); sessionId = uuid(); msgs.length = 0; render(); toast('New conversation started', 'info'); };
  el.querySelector('#copychat').onclick = async () => { await copyText(msgs.map(m => `${m.role}: ${m.text}`).join('\n\n')); toast('Conversation copied', 'success'); };
  msgs.push({ role: 'assistant', text: '', html: `👋 Hi! I'm connected to this bot's knowledge bases. Ask me anything grounded in your documents.`, at: new Date().toISOString() });
  render();
  return { newSession() { sessionId = uuid(); msgs.length = 0; render(); } };
}
