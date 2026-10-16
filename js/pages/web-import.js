import { initTheme } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext } from '../components/org-switcher.js';
import { apiFetch } from '../api.js';
import { ENDPOINTS, WEB_IMPORT_POLL_MS, WEB_IMPORT_MAX_FAILURES } from '../config.js';
import { toast, emptyState, skeletonList, confirmDialog, openModal } from '../ui.js';
import { escapeHtml, timeAgo, copyText, qp } from '../utils.js';
import {
  pageStatusInfo,
  sessionStatusInfo,
  sessionProgress,
  progressText,
  isSessionTerminal,
  pageDisplayTitle,
  shortUrl,
  failedPageMessage,
  resolveSelectedId,
  classifySessionError,
  renderMarkdown,
  createImportPoller,
  normalizeSession,
  normalizePages,
  mergePolledPages,
  confirmationSummary,
  requestWebImportConfirmation,
} from './web-import-controller.js';

initTheme();
await guard('knowledge-bases.html');

const { orgId } = await getOrgContext();
const kbId = qp('kb');
const importId = qp('import');
const page = document.getElementById('page');

/** Sanitizer shared by the markdown renderer (DOMPurify is loaded in the shell). */
const sanitize = (h) => (globalThis.DOMPurify ? globalThis.DOMPurify.sanitize(h, { USE_PROFILES: { html: true } }) : h);

/* ==================== state ==================== */
let kbName = 'Knowledge Base';
let session = { status: 'pending', total_pages: 0 };
let pages = [];
let selectedId = null;
let mounted = true;
let editor = { id: null, text: '', editing: false, saving: false, error: '', saved: false };
let confirming = false;
let confirmation = null;
const inclusionPending = new Map();
const inclusionBusy = new Set();
const deleteBusy = new Set();
const dirty = () => editor.editing && pages.find(p => String(p.id) === String(editor.id))?.content !== editor.text;

function backHref() {
  return kbId ? `knowledge-base.html?id=${encodeURIComponent(kbId)}` : 'knowledge-bases.html';
}

function fetchStatus() {
  return apiFetch(ENDPOINTS.webImportDetail(orgId, importId), { cacheTtl: 0 });
}
function fetchPages() {
  return apiFetch(ENDPOINTS.webImportPages(orgId, importId), { cacheTtl: 0 });
}

/* ==================== render ==================== */
function layout() {
  page.innerHTML = `
    <p><a href="${backHref()}">← ${escapeHtml(kbName)}</a></p>
    <div id="wi-head"></div>
    <div id="wi-body" class="wi-layout">
      <div class="wi-list-col">
        <div class="wi-list-head"><h3>Selected pages</h3><span class="tiny muted" id="wi-count"></span></div>
        <div id="wi-list" class="wi-list" role="listbox" aria-label="Selected webpages">${skeletonList(3)}</div>
      </div>
      <div class="wi-main-col" id="wi-main"></div>
    </div>`;
}

function renderHeader() {
  const w = document.getElementById('wi-head');
  if (!w) return;
  const prog = sessionProgress(session, pages);
  const sInfo = sessionStatusInfo(session.status);
  const summary = confirmationSummary(session, pages, { unsaved: dirty(), confirming });
  const confirmedAt = confirmation?.confirmed_at || session.confirmed_at;
  const confirmedCount = confirmation?.page_count ?? (session.page_count || session.included_pages || 0);
  const confirmationBlock = summary.confirmed
    ? `<section class="wi-confirmed" aria-live="polite"><div><span class="badge b-completed">Import confirmed</span><strong>${confirmedCount} page${confirmedCount === 1 ? '' : 's'} approved</strong>${confirmedAt ? `<span class="tiny muted">Confirmed ${escapeHtml(timeAgo(confirmedAt))}</span>` : ''}</div><p class="tiny muted">The approved snapshot is saved. RAG processing and search availability happen in a later step.</p></section>`
    : `<section class="wi-confirm-panel"><div><h3>Confirm Import</h3><p class="tiny muted">${summary.total} staged · ${summary.included} included · ${summary.excluded} excluded · ${summary.eligible} eligible · ${summary.attention} require attention</p>${summary.scraping ? '<p class="tiny muted">Wait for scraping to finish before confirming.</p>' : summary.attention ? '<p class="tiny muted">Exclude or resolve included pages that failed, are incomplete, or have no content.</p>' : dirty() ? '<p class="tiny muted">Save or cancel your unsaved edits before confirming.</p>' : ''}</div><button class="btn btn-primary" id="wi-confirm" ${summary.canConfirm ? '' : 'disabled'}>${confirming ? '<span class="spinner"></span> Confirming…' : 'Confirm Import'}</button></section>`;
  w.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${summary.confirmed ? 'Import confirmed' : 'Review webpage content'}</h2>
        <p class="muted">${summary.confirmed ? 'Your approved snapshot is saved for a later processing step.' : 'Review the content extracted from your selected webpages before approving the import.'}</p>
      </div>
      <div class="wi-progress" role="group" aria-label="Scraping progress">
        <div class="wi-progress-top">
          <strong id="wi-progress-text">${escapeHtml(progressText(prog))}</strong>
          <span class="badge ${sInfo.badge}">${escapeHtml(sInfo.label)}</span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prog.percent}" aria-label="Pages scraped">
          <div style="width:${prog.percent}%"></div>
        </div>
        <div class="tiny muted mt1">${pages.filter(p => p.is_included).length} included · ${pages.filter(p => !p.is_included).length} excluded. These are drafts — nothing is added to the knowledge base yet.</div>
      </div>
    </div>
    ${confirmationBlock}
    <div id="wi-poll-warn"></div>`;
  w.querySelector('#wi-confirm')?.addEventListener('click', confirmImport);
}

function renderList() {
  const w = document.getElementById('wi-list');
  const count = document.getElementById('wi-count');
  if (!w) return;
  if (count) count.textContent = pages.length ? `${pages.length} page${pages.length === 1 ? '' : 's'}` : '';
  if (!pages.length) {
    w.innerHTML = emptyState('🗂️', 'No pages yet', 'Pages will appear here once the import starts.', '');
    return;
  }
  w.innerHTML = pages.map((p) => {
    const info = pageStatusInfo(p.status);
    const sel = String(p.id) === String(selectedId);
    const wc = info.key === 'completed' && p.word_count ? `<span class="tiny muted">${p.word_count.toLocaleString()} words</span>` : '';
    return `<button type="button" class="wi-row${sel ? ' selected' : ''}" data-page-id="${escapeHtml(String(p.id))}"
        role="option" aria-selected="${sel}"${sel ? ' aria-current="true"' : ''}>
        <span class="page-ico" aria-hidden="true">📄</span>
        <span class="wi-row-main">
          <span class="wi-row-title">${escapeHtml(pageDisplayTitle(p))}</span>
          <span class="wi-row-url" title="${escapeHtml(p.url)}">${escapeHtml(shortUrl(p.url))}</span>
        </span>
        <span class="wi-row-meta">
          <span class="badge ${info.badge}">${escapeHtml(info.label)}</span>
          <span class="tiny wi-inclusion ${p.is_included ? 'is-included' : ''}">${p.is_included ? 'Included' : 'Excluded'}</span>
          ${wc}
        </span>
      </button>`;
  }).join('');
  w.querySelectorAll('.wi-row').forEach((b) => {
    b.onclick = async () => { if (await canLeaveEditor()) { selectedId = b.dataset.pageId; if (editor.id !== selectedId) editor = { id: null, text: '', editing: false, saving: false, error: '', saved: false }; renderList(); renderContent(); } };
  });
}

function renderContent() {
  const w = document.getElementById('wi-main');
  if (!w) return;
  if (!pages.length) {
    w.innerHTML = emptyState('📄', 'Nothing to preview', 'No pages are available in this import yet.', '');
    return;
  }
  const p = pages.find((x) => String(x.id) === String(selectedId));
  if (!p) {
    w.innerHTML = emptyState('📄', 'Select a page', 'Choose a webpage from the list to preview its extracted content.', '');
    return;
  }
  const info = pageStatusInfo(p.status);
  const readOnly = session.status === 'confirmed';
  if (editor.id !== String(p.id)) editor = { id: String(p.id), text: p.content || '', editing: false, saving: false, error: '', saved: false };
  const src = p.final_url || p.url;
  const header = `
    <div class="wi-main-head">
      <div class="wi-main-head-top">
        <h3>${escapeHtml(pageDisplayTitle(p))}</h3>
        <span class="badge ${info.badge}">${escapeHtml(info.label)}</span>
      </div>
      <div class="wi-main-meta">
        <a class="wi-src" href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer nofollow" title="Open source in a new tab">${escapeHtml(shortUrl(src, 100))} ↗</a>
        <button type="button" class="btn btn-ghost btn-sm" id="wi-copy" aria-label="Copy source URL">Copy URL</button>
        ${info.key === 'completed' && p.word_count ? `<span class="tiny muted">${p.word_count.toLocaleString()} words</span>` : ''}
        ${p.scraped_at ? `<span class="tiny muted">scraped ${escapeHtml(timeAgo(p.scraped_at))}</span>` : ''}
      </div>
    </div>`;

  let body = '';
  if (info.key === 'completed') {
    if (editor.editing) {
      body = `<div class="wi-editor"><div class="wi-editor-status" aria-live="polite">${readOnly ? '<span class="badge b-warning">Confirmed snapshot is read-only</span>' : dirty() ? '<span class="badge b-warning">Unsaved changes</span>' : editor.saved ? '<span class="badge b-completed">Saved</span>' : ''}${editor.error ? `<span class="tiny error-text">${escapeHtml(editor.error)}</span>` : ''}</div><label class="sr-only" for="wi-editor-text">Markdown content</label><textarea id="wi-editor-text" rows="20" spellcheck="false" ${editor.saving || readOnly ? 'disabled' : ''}>${escapeHtml(editor.text)}</textarea>${!readOnly ? `<div class="wi-actions"><button class="btn btn-primary" id="wi-save" ${editor.saving || !dirty() ? 'disabled' : ''}>${editor.saving ? '<span class="spinner"></span> Saving…' : 'Save'}</button><button class="btn btn-secondary" id="wi-cancel" ${editor.saving ? 'disabled' : ''}>Cancel</button></div>` : '<p class="tiny muted">Local unsaved text is not part of the approved snapshot.</p>'}</div>`;
    } else if (p.content && p.content.trim()) {
      const fmt = String(p.content_format || 'markdown').toLowerCase();
      body = (fmt === 'markdown' || fmt === 'md')
        ? `<div class="md-body">${renderMarkdown(p.content, { sanitize })}</div>`
        : `<pre class="wi-plain">${escapeHtml(p.content)}</pre>`;
    } else {
      body = `<div class="wi-placeholder">${emptyState('🫙', 'No content extracted', 'This page was scraped successfully but no readable content was found.', '')}</div>`;
    }
  } else if (info.key === 'processing') {
    body = `<div class="wi-placeholder"><span class="spinner dark"></span><div><strong>Scraping this page…</strong><div class="tiny muted">We're extracting the content now. This panel updates automatically.</div></div></div>`;
  } else if (info.key === 'pending') {
    body = `<div class="wi-placeholder"><span aria-hidden="true">⏳</span><div><strong>Waiting to scrape…</strong><div class="tiny muted">This page is queued. It will start shortly.</div></div></div>`;
  } else if (info.key === 'failed') {
    const msg = failedPageMessage(p);
    body = `<div class="wi-fail">
        <div class="wi-fail-ico" aria-hidden="true">⚠️</div>
        <h4>Unable to scrape this page</h4>
        ${msg ? `<p class="muted">${escapeHtml(msg)}</p>` : `<p class="muted">This page could not be scraped. You can still identify it by its URL below.</p>`}
        <p class="tiny muted mono wi-fail-url">${escapeHtml(p.url)}</p>
      </div>`;
  }

  const eligible = info.key === 'completed';
  const state = p.is_included ? 'Included in future import' : 'Excluded from future import';
  const controls = `<div class="wi-draft-controls"><label class="wi-include"><input id="wi-include" type="checkbox" ${p.is_included ? 'checked' : ''} ${readOnly || inclusionBusy.has(String(p.id)) || (!p.is_included && !eligible) ? 'disabled' : ''}><span>${escapeHtml(state)}</span></label><div class="wi-actions">${eligible && !editor.editing && !readOnly ? '<button type="button" class="btn btn-secondary btn-sm" id="wi-edit">Edit content</button>' : ''}<button type="button" class="btn btn-ghost btn-sm" id="wi-delete" ${readOnly || deleteBusy.has(String(p.id)) ? 'disabled' : ''}>${deleteBusy.has(String(p.id)) ? 'Deleting…' : 'Delete draft'}</button></div></div>`;
  w.innerHTML = `<div class="card wi-content">${header}${controls}<div class="wi-content-body">${body}</div></div>`;
  const copy = w.querySelector('#wi-copy');
  if (copy) copy.onclick = async () => {
    if (await copyText(src)) toast('Source URL copied', 'success');
  };
  w.querySelector('#wi-edit')?.addEventListener('click', () => { editor = { id: String(p.id), text: p.content || '', editing: true, saving: false, error: '', saved: false }; renderContent(); w.querySelector('#wi-editor-text')?.focus(); });
  w.querySelector('#wi-editor-text')?.addEventListener('input', (e) => { editor.text = e.target.value; editor.saved = false; const save = w.querySelector('#wi-save'); if (save) save.disabled = editor.saving || !dirty(); const status = w.querySelector('.wi-editor-status'); if (status) status.innerHTML = dirty() ? '<span class="badge b-warning">Unsaved changes</span>' : ''; renderHeader(); });
  w.querySelector('#wi-save')?.addEventListener('click', saveDraft);
  w.querySelector('#wi-cancel')?.addEventListener('click', () => { editor.text = p.content || ''; editor.editing = false; editor.error = ''; editor.saved = false; render(); });
  w.querySelector('#wi-include')?.addEventListener('change', (e) => updateInclusion(p, e.target.checked));
  w.querySelector('#wi-delete')?.addEventListener('click', () => deleteDraft(p));
}

async function confirmImport() {
  if (confirming) return;
  const summary = confirmationSummary(session, pages, { unsaved: dirty(), confirming });
  if (!summary.canConfirm) return;
  const { el, close } = openModal(`<div class="modal-head"><h3>Confirm webpage import?</h3><button class="icon-btn" data-cancel aria-label="Cancel">✕</button></div><div class="modal-body"><p>Confirm ${summary.included} included page${summary.included === 1 ? '' : 's'}?</p><ul><li>Only included pages will be approved.</li><li>Saved edits will be included; excluded pages will stay out.</li><li>Confirmation records an approved snapshot.</li><li>RAG indexing and search availability happen in a later processing step.</li></ul></div><div class="modal-foot"><button class="btn btn-secondary" data-cancel>Cancel</button><button class="btn btn-primary" id="wi-confirm-submit">Confirm ${summary.included} page${summary.included === 1 ? '' : 's'}</button></div>`);
  el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => close());
  el.querySelector('#wi-confirm-submit').onclick = async (event) => {
    if (confirming) return;
    confirming = true; event.currentTarget.disabled = true; event.currentTarget.innerHTML = '<span class="spinner"></span> Confirming…'; renderHeader();
    try {
      confirmation = await requestWebImportConfirmation(apiFetch, ENDPOINTS.webImportConfirm(orgId, kbId, importId));
      session = { ...session, status: confirmation.status, confirmed_at: confirmation.confirmed_at, page_count: confirmation.page_count, included_pages: confirmation.page_count };
      confirming = false; close(); render(); stopPolling(); toast('Import confirmed', 'success');
    } catch (e) {
      confirming = false;
      const message = e?.status === 400 || e?.status === 409 ? (e.message || 'The server could not confirm these pages. Review the import and try again.') : 'Could not reach the server to confirm. Your drafts are unchanged; you can retry.';
      const alert = el.querySelector('.modal-body');
      alert?.querySelector('[role="alert"]')?.remove();
      if (alert) alert.insertAdjacentHTML('beforeend', `<div class="alert alert-warning mt1" role="alert">${escapeHtml(message)}</div>`);
      event.currentTarget.disabled = false; event.currentTarget.textContent = `Retry confirmation`;
      renderHeader();
    }
  };
}

async function canLeaveEditor() {
  if (!dirty()) return true;
  return new Promise((resolve) => {
    const { el, close } = openModal(`<div class="modal-head"><h3>Unsaved changes</h3><button class="icon-btn" data-stay aria-label="Stay">✕</button></div><div class="modal-body"><p class="muted">Save your edits before switching pages?</p></div><div class="modal-foot"><button class="btn btn-secondary" data-discard>Discard</button><button class="btn btn-secondary" data-stay>Stay</button><button class="btn btn-primary" data-save>Save</button></div>`);
    el.querySelectorAll('[data-stay]').forEach(b => b.onclick = () => { close(); resolve(false); });
    el.querySelector('[data-discard]').onclick = () => { close(); editor.editing = false; resolve(true); };
    el.querySelector('[data-save]').onclick = async (e) => { e.currentTarget.disabled = true; const ok = await saveDraft(); close(); resolve(ok); };
  });
}

async function saveDraft() {
  if (session.status === 'confirmed' || !editor.editing || editor.saving || !dirty()) return false;
  const id = editor.id; editor.saving = true; editor.error = ''; renderContent();
  try {
    const res = await apiFetch(ENDPOINTS.webImportPage(orgId, importId, encodeURIComponent(id)), { method: 'PATCH', body: { content: editor.text } });
    const response = res?.page || res || {};
    pages = pages.map(p => String(p.id) === id ? { ...p, ...response, id: p.id, content: response.content ?? editor.text, word_count: response.word_count ?? editor.text.trim().split(/\s+/).filter(Boolean).length } : p);
    editor.text = pages.find(p => String(p.id) === id)?.content || editor.text;
    editor.saving = false; editor.editing = false; editor.saved = true; render(); toast('Draft saved', 'success'); return true;
  } catch (e) { editor.saving = false; editor.error = e?.status && e.status < 500 ? e.message : 'Could not save this draft. Try again.'; renderContent(); return false; }
}

async function updateInclusion(p, included) {
  const id = String(p.id); if (session.status === 'confirmed' || inclusionBusy.has(id)) return;
  inclusionBusy.add(id); inclusionPending.set(id, included); renderContent();
  try {
    const res = await apiFetch(ENDPOINTS.webImportPage(orgId, importId, encodeURIComponent(id)), { method: 'PATCH', body: { is_included: included } });
    const updated = res?.page || res || {};
    pages = pages.map(x => String(x.id) === id ? { ...x, ...updated, id: x.id, is_included: updated.is_included ?? included } : x);
    inclusionPending.delete(id); render();
  } catch (e) { inclusionPending.delete(id); toast(e?.status && e.status < 500 ? e.message : 'Could not update inclusion. Try again.', 'error'); renderContent(); }
  finally { inclusionBusy.delete(id); }
}

async function deleteDraft(p) {
  const id = String(p.id); if (session.status === 'confirmed' || deleteBusy.has(id)) return;
  const ok = await confirmDialog({ title: 'Delete this draft?', body: 'This removes the draft from the current review session. It does not delete content already indexed in the knowledge base.', confirmText: 'Delete draft' });
  if (!ok || deleteBusy.has(id)) return;
  deleteBusy.add(id); renderContent();
  try {
    await apiFetch(ENDPOINTS.webImportPage(orgId, importId, encodeURIComponent(id)), { method: 'DELETE' });
    pages = pages.filter(x => String(x.id) !== id);
    session.total_pages = pages.length;
    session.completed_pages = pages.filter(x => pageStatusInfo(x.status).key === 'completed').length;
    session.failed_pages = pages.filter(x => pageStatusInfo(x.status).key === 'failed').length;
    session.processing_pages = pages.filter(x => pageStatusInfo(x.status).key === 'processing').length;
    session.pending_pages = pages.filter(x => pageStatusInfo(x.status).key === 'pending').length;
    if (editor.id === id) editor = { id: null, text: '', editing: false, saving: false, error: '', saved: false };
    const preferred = selectedId === id ? (pages.find(x => pageStatusInfo(x.status).key === 'completed')?.id ?? null) : selectedId;
    selectedId = resolveSelectedId(pages, preferred); render(); toast('Draft deleted', 'success');
  } catch (e) { deleteBusy.delete(id); toast(e?.status && e.status < 500 ? e.message : 'Could not delete this draft. Try again.', 'error'); renderContent(); return; }
  deleteBusy.delete(id);
}

function renderPollWarn(count) {
  const w = document.getElementById('wi-poll-warn');
  if (!w) return;
  w.innerHTML = count
    ? `<div class="alert alert-warning mt1"><span>⚠️</span><div class="tiny">Temporary problem reaching the server — retrying… (attempt ${count})</div></div>`
    : '';
}

function render() { renderHeader(); renderList(); renderContent(); }

/* ==================== fatal / invalid session ==================== */
function renderFatal(kind, err) {
  stopPolling();
  const map = {
    not_found: ['🔍', 'Import not found', 'This import session does not exist or has been removed.'],
    forbidden: ['🔒', 'No access', 'You do not have permission to view this import session.'],
    unauthorized: ['🔒', 'Session expired', 'Please log in again to view this import.'],
    network: ['📡', 'Cannot reach the server', 'Check your connection, then try again.'],
    unknown: ['⚠️', 'Something went wrong', err?.message || 'The import could not be loaded.'],
  };
  const [icon, title, sub] = map[kind] || map.unknown;
  page.innerHTML = `<p><a href="${backHref()}">← Back</a></p>` +
    emptyState(icon, title, escapeHtml(sub), `<a class="btn btn-primary" href="${backHref()}">Back to knowledge base</a>`);
}

/* ==================== polling ==================== */
let poller = null;

function applyData(statusRes, pagesRes) {
  session = normalizeSession(statusRes);
  pages = normalizePages(pagesRes);
  selectedId = resolveSelectedId(pages, selectedId);
  render();
}

function onUpdate({ session: s, pages: p }) {
  if (!mounted) return;
  session = session.status === 'confirmed'
    ? { ...s, status: 'confirmed', confirmed_at: session.confirmed_at || s.confirmed_at, page_count: session.page_count || s.page_count, included_pages: session.included_pages || s.included_pages }
    : s;
  pages = mergePolledPages(p, pages, { editingId: editor.editing ? editor.id : null, editorText: editor.text, pendingInclusion: inclusionPending });
  selectedId = resolveSelectedId(pages, selectedId);
  renderPollWarn(0);
  render();
}

function startPolling() {
  if (poller) return;
  poller = createImportPoller({
    fetchStatus,
    fetchPages,
    onUpdate,
    interval: WEB_IMPORT_POLL_MS,
    maxConsecutiveFailures: WEB_IMPORT_MAX_FAILURES,
    onError: (err, info) => {
      if (!mounted) return;
      if (info.fatal) {
        toast('Stopped updating — the server could not be reached.', 'error');
        renderPollWarn(0);
      } else {
        renderPollWarn(info.failures);
      }
    },
  });
  poller.start();
}
function stopPolling() { if (poller) { poller.stop(); poller = null; } }

document.addEventListener('visibilitychange', () => {
  if (!mounted) return;
  if (document.hidden) stopPolling();
  else if (!isSessionTerminal(session.status)) startPolling();
});
window.addEventListener('pagehide', () => { mounted = false; stopPolling(); });
window.addEventListener('beforeunload', (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });

/* ==================== boot ==================== */
async function loadKbName() {
  if (!kbId) return;
  try {
    const kb = await apiFetch(ENDPOINTS.kbDetail(orgId, kbId), { cacheTtl: 30000 });
    if (kb?.name) kbName = kb.name;
  } catch { /* fall back to generic name */ }
}

async function boot() {
  if (!kbId || !importId) {
    renderFatal('not_found', { message: 'Missing knowledge base or import id.' });
    return;
  }
  await loadKbName();
  layout();
  renderHeader();
  try {
    const [s, p] = await Promise.all([fetchStatus(), fetchPages()]);
    if (!mounted) return;
    applyData(s, p);
    if (!isSessionTerminal(session.status)) startPolling();
  } catch (e) {
    renderFatal(classifySessionError(e), e);
  }
}

await boot();
