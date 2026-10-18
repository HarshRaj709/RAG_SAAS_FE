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
  ingestionStatusInfo,
  ingestionPageStatusInfo,
  ingestionCounts,
  approvedPagesForDisplay,
  requestWebImportIngestion,
  shouldPollImport,
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
let ingestionStarting = false;
let statusRefreshing = false;
let confirmation = null;
let pollFatal = false;
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
let sharedPollFetch = null;
function fetchPollPair() {
  if (!sharedPollFetch) {
    const request = Promise.all([fetchStatus(), fetchPages()]);
    sharedPollFetch = request.finally(() => { sharedPollFetch = null; });
  }
  return sharedPollFetch;
}
function visiblePages() {
  return session.status === 'confirmed'
    ? approvedPagesForDisplay(pages, session.ingestion_pages)
    : pages;
}

/* ==================== render ==================== */
function layout() {
  page.innerHTML = `
    <p><a href="${backHref()}">← ${escapeHtml(kbName)}</a></p>
    <div id="wi-head"></div>
    <div id="wi-body" class="wi-layout">
      <div class="wi-list-col">
        <div class="wi-list-head"><h3 id="wi-list-title">Selected pages</h3><span class="tiny muted" id="wi-count"></span></div>
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
  const confirmed = session.status === 'confirmed';
  const ingestionInfo = ingestionStatusInfo(session.ingestion_status);
  const counts = ingestionCounts(session);
  const confirmedAt = confirmation?.confirmed_at || session.confirmed_at;
  const confirmedCount = confirmation?.page_count ?? (session.page_count || session.approved_page_count || session.confirmed_page_count || session.included_pages || 0);
  const confirmationBlock = summary.confirmed
    ? `<section class="wi-confirmed" aria-live="polite"><div><span class="badge b-completed">Import confirmed</span><strong>${confirmedCount} page${confirmedCount === 1 ? '' : 's'} approved</strong>${confirmedAt ? `<span class="tiny muted">Confirmed ${escapeHtml(timeAgo(confirmedAt))}</span>` : ''}</div><p class="tiny muted">The approved snapshot is saved and read-only.</p></section>${renderIngestionPanel(ingestionInfo, counts)}`
    : `<section class="wi-confirm-panel"><div><h3>Confirm Import</h3><p class="tiny muted">${summary.total} page${summary.total === 1 ? '' : 's'} scraped · ${summary.eligible} ready to confirm · ${summary.attention} missing content</p>${summary.scraping ? '<p class="tiny muted">Wait for scraping to finish before confirming.</p>' : summary.attention ? '<p class="tiny muted">Resolve pages that finished scraping but produced no content.</p>' : dirty() ? '<p class="tiny muted">Save or cancel your unsaved edits before confirming.</p>' : ''}</div><button class="btn btn-primary" id="wi-confirm" ${summary.canConfirm ? '' : 'disabled'}>${confirming ? '<span class="spinner"></span> Confirming…' : 'Confirm Import'}</button></section>`;
  w.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${summary.confirmed ? 'Confirmed webpage import' : 'Review webpage content'}</h2>
        <p class="muted">${summary.confirmed ? 'Approved content is immutable. Ingestion can be started separately.' : 'Review the content extracted from your selected webpages before approving the import.'}</p>
      </div>
      ${confirmed ? `<div class="wi-progress" role="group" aria-label="Ingestion progress"><div class="wi-progress-top"><strong>${escapeHtml(ingestionInfo.label)}</strong><span class="badge ${ingestionInfo.badge}">${escapeHtml(ingestionInfo.label)}</span></div><div class="tiny muted mt1">${counts.indexed} of ${counts.approved} approved pages indexed · ${counts.failed} failed</div></div>` : `<div class="wi-progress" role="group" aria-label="Scraping progress">
        <div class="wi-progress-top">
          <strong id="wi-progress-text">${escapeHtml(progressText(prog))}</strong>
          <span class="badge ${sInfo.badge}">${escapeHtml(sInfo.label)}</span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prog.percent}" aria-label="Pages scraped">
          <div style="width:${prog.percent}%"></div>
        </div>
        <div class="tiny muted mt1">${pages.filter(p => pageStatusInfo(p.status).key === 'completed').length} scraped · ${pages.filter(p => pageStatusInfo(p.status).key === 'failed').length} failed. These are drafts — nothing is added to the knowledge base yet.</div>
      </div>`}
    </div>
    ${confirmationBlock}
    <div id="wi-poll-warn"></div>`;
  w.querySelector('#wi-confirm')?.addEventListener('click', confirmImport);
  w.querySelector('#wi-start-ingestion')?.addEventListener('click', startIngestion);
  w.querySelector('#wi-refresh-ingestion')?.addEventListener('click', refreshImportStatus);
}

function renderIngestionPanel(info, counts) {
  const active = shouldPollImport(session);
  const canStart = session.status === 'confirmed' && ['not_started', 'partially_failed', 'failed'].includes(info.key) && !ingestionStarting && counts.approved > 0;
  const completed = info.key === 'completed';
  const failed = info.key === 'failed';
  const partial = info.key === 'partially_failed';
  const action = canStart ? `<button class="btn btn-primary" id="wi-start-ingestion">${info.key === 'not_started' ? 'Start Ingestion' : 'Retry ingestion'}</button>` : ingestionStarting ? '<button class="btn btn-primary" disabled><span class="spinner"></span> Starting…</button>' : '';
  const outcome = completed
    ? `<p class="tiny wi-ingest-success">All ${counts.indexed} approved page${counts.indexed === 1 ? '' : 's'} indexed successfully.</p><a class="btn btn-secondary btn-sm" href="${backHref()}">Open knowledge base</a>`
    : partial
      ? `<p class="tiny wi-ingest-warning">${counts.indexed} indexed; ${counts.failed} failed. You can retry ingestion for the failed pages.</p>`
      : failed
        ? `<p class="tiny wi-ingest-error">Ingestion failed. The approved snapshot is preserved; retry is available.</p>`
        : info.key === 'queued'
          ? '<p class="tiny muted">The request is queued. Processing has not necessarily started yet.</p>'
          : info.key === 'processing'
            ? '<p class="tiny muted">Approved pages are being processed. Each page becomes available for retrieval after the backend reports it indexed.</p>'
            : '<p class="tiny muted">Start ingestion when you are ready to process the approved pages for RAG retrieval.</p>';
  return `<section class="wi-ingestion" aria-live="polite"><div class="wi-ingestion-head"><div><h3>Ingestion</h3><span class="badge ${info.badge}">${escapeHtml(info.label)}</span></div>${action}</div><div class="wi-ingestion-counts"><span><strong>${counts.approved}</strong> approved</span><span><strong>${counts.indexed}</strong> indexed</span><span><strong>${counts.processing}</strong> processing</span><span><strong>${counts.waiting}</strong> waiting</span><span><strong>${counts.failed}</strong> failed</span></div>${session.ingestion_started_at ? `<p class="tiny muted">Started ${escapeHtml(timeAgo(session.ingestion_started_at))}${session.ingestion_completed_at ? ` · finished ${escapeHtml(timeAgo(session.ingestion_completed_at))}` : ''}</p>` : ''}${outcome}${pollFatal && active ? `<div class="alert alert-warning mt1" role="alert">Status updates stopped after a connection problem. <button type="button" class="btn btn-ghost btn-sm" id="wi-refresh-ingestion" ${statusRefreshing ? 'disabled' : ''}>${statusRefreshing ? 'Refreshing…' : 'Refresh status'}</button></div>` : ''}<p class="tiny muted">Pages are processed independently; retrieval availability follows the backend indexing pipeline and may take time to update.</p></section>`;
}

function setHtmlPreservingScroll(el, html) {
  if (!el) return;
  const top = el.scrollTop;
  el.innerHTML = html;
  if (top) el.scrollTop = top;
}

function renderList() {
  const w = document.getElementById('wi-list');
  const count = document.getElementById('wi-count');
  const title = document.getElementById('wi-list-title');
  const shown = visiblePages();
  if (!w) return;
  if (title) title.textContent = session.status === 'confirmed' ? 'Approved webpages' : 'Selected pages';
  if (count) count.textContent = shown.length ? `${shown.length} page${shown.length === 1 ? '' : 's'}` : '';
  if (!shown.length) {
    w.innerHTML = emptyState('🗂️', session.status === 'confirmed' ? 'No approved pages' : 'No pages yet', session.status === 'confirmed' ? 'This confirmed snapshot has no page details to display.' : 'Pages will appear here once the import starts.', '');
    return;
  }
  setHtmlPreservingScroll(w, shown.map((p) => {
    const info = session.status === 'confirmed' ? ingestionPageStatusInfo(p.ingestion_status) : pageStatusInfo(p.status);
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
          ${session.status === 'confirmed' ? '<span class="tiny wi-inclusion is-included">Approved</span>' : ''}
          ${wc}
        </span>
      </button>`;
  }).join(''));
  w.querySelectorAll('.wi-row').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.pageId;
      if (String(id) === String(selectedId)) return;
      if (!(await canLeaveEditor())) return;
      selectedId = id;
      if (editor.id !== selectedId) editor = { id: null, text: '', editing: false, saving: false, error: '', saved: false };
      // Update the selected row in place — rebuilding the list resets its scroll.
      w.querySelectorAll('.wi-row').forEach((row) => {
        const on = row.dataset.pageId === id;
        row.classList.toggle('selected', on);
        row.setAttribute('aria-selected', String(on));
        if (on) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
      });
      renderContent();
    };
  });
}

function renderContent() {
  const w = document.getElementById('wi-main');
  const shown = visiblePages();
  if (!w) return;
  if (!shown.length) {
    w.innerHTML = emptyState('📄', session.status === 'confirmed' ? 'No approved content to preview' : 'Nothing to preview', 'No pages are available in this import yet.', '');
    return;
  }
  const p = shown.find((x) => String(x.id) === String(selectedId));
  if (!p) {
    w.innerHTML = emptyState('📄', 'Select a page', 'Choose a webpage from the list to preview its extracted content.', '');
    return;
  }
  const info = session.status === 'confirmed' ? ingestionPageStatusInfo(p.ingestion_status) : pageStatusInfo(p.status);
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
  if (session.status === 'confirmed' && p.ingestion_status === 'failed') {
    body = `<div class="alert alert-warning wi-ingestion-error" role="status"><strong>Indexing failed for this page.</strong>${p.ingestion_error ? `<p>${escapeHtml(p.ingestion_error)}</p>` : ''}</div>${p.content?.trim() ? `<div class="md-body">${renderMarkdown(p.content, { sanitize })}</div>` : '<p class="tiny muted">Approved page content is available in the snapshot.</p>'}`;
  } else if (info.key === 'completed' || session.status === 'confirmed') {
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
  const controls = readOnly
    ? `<div class="wi-draft-controls"><span class="tiny wi-inclusion is-included">Approved snapshot · read-only</span></div>`
    : `<div class="wi-draft-controls"><span class="tiny muted">Not added to the knowledge base until you confirm.</span><div class="wi-actions">${eligible && !editor.editing ? '<button type="button" class="btn btn-secondary btn-sm" id="wi-edit">Edit content</button>' : ''}<button type="button" class="btn btn-ghost btn-sm" id="wi-delete" ${deleteBusy.has(String(p.id)) ? 'disabled' : ''}>${deleteBusy.has(String(p.id)) ? 'Deleting…' : 'Delete'}</button></div></div>`;
  w.innerHTML = `<div class="card wi-content">${header}${controls}<div class="wi-content-body">${body}</div></div>`;
  const copy = w.querySelector('#wi-copy');
  if (copy) copy.onclick = async () => {
    if (await copyText(src)) toast('Source URL copied', 'success');
  };
  w.querySelector('#wi-edit')?.addEventListener('click', () => { editor = { id: String(p.id), text: p.content || '', editing: true, saving: false, error: '', saved: false }; renderContent(); w.querySelector('#wi-editor-text')?.focus(); });
  w.querySelector('#wi-editor-text')?.addEventListener('input', (e) => { editor.text = e.target.value; editor.saved = false; const save = w.querySelector('#wi-save'); if (save) save.disabled = editor.saving || !dirty(); const status = w.querySelector('.wi-editor-status'); if (status) status.innerHTML = dirty() ? '<span class="badge b-warning">Unsaved changes</span>' : ''; renderHeader(); });
  w.querySelector('#wi-save')?.addEventListener('click', saveDraft);
  w.querySelector('#wi-cancel')?.addEventListener('click', () => { editor.text = p.content || ''; editor.editing = false; editor.error = ''; editor.saved = false; render(); });
  w.querySelector('#wi-delete')?.addEventListener('click', () => deleteDraft(p));
}

async function confirmImport() {
  if (confirming) return;
  const summary = confirmationSummary(session, pages, { unsaved: dirty(), confirming });
  if (!summary.canConfirm) return;
  const { el, close } = openModal(`<div class="modal-head"><h3>Confirm webpage import?</h3><button class="icon-btn" data-cancel aria-label="Cancel">✕</button></div><div class="modal-body"><p>Confirm ${summary.eligible} page${summary.eligible === 1 ? '' : 's'} ready for review?</p><ul><li>Every page that finished scraping will be confirmed.</li><li>Saved edits are included; pages that failed to scrape are skipped.</li><li>Confirmation records an approved snapshot.</li><li>RAG indexing and search availability happen in a later processing step.</li></ul></div><div class="modal-foot"><button class="btn btn-secondary" data-cancel>Cancel</button><button class="btn btn-primary" id="wi-confirm-submit">Confirm ${summary.eligible} page${summary.eligible === 1 ? '' : 's'}</button></div>`);
  el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => close());
  el.querySelector('#wi-confirm-submit').onclick = async (event) => {
    if (confirming) return;
    confirming = true; event.currentTarget.disabled = true; event.currentTarget.innerHTML = '<span class="spinner"></span> Confirming…'; renderHeader();
    try {
      confirmation = await requestWebImportConfirmation(apiFetch, ENDPOINTS.webImportConfirm(orgId, kbId, importId));
      session = { ...session, status: confirmation.status, confirmed_at: confirmation.confirmed_at, page_count: confirmation.page_count, approved_page_count: confirmation.page_count, included_pages: confirmation.page_count, ingestion_pages: null };
      confirming = false; close(); stopPolling();
      try { session = normalizeSession(await fetchStatus()); } catch { /* local approval response still allows the confirmed read-only view */ }
      selectedId = resolveSelectedId(visiblePages(), selectedId); render(); toast('Import confirmed', 'success');
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

async function startIngestion() {
  if (ingestionStarting || session.status !== 'confirmed') return;
  const counts = ingestionCounts(session);
  if (!counts.approved || !['not_started', 'partially_failed', 'failed'].includes(session.ingestion_status)) return;
  const { el, close } = openModal(`<div class="modal-head"><h3>Start webpage ingestion?</h3><button class="icon-btn" data-cancel aria-label="Cancel">✕</button></div><div class="modal-body"><p>This will process the ${counts.approved} approved webpage${counts.approved === 1 ? '' : 's'} for RAG retrieval.</p><p class="muted">Pages are processed independently. A page can become available for retrieval after the backend marks its indexing complete, subject to the knowledge base's indexing consistency.</p><p class="tiny muted">The confirmed snapshot is immutable. Starting again after a failure retries the failed pages.</p></div><div class="modal-foot"><button class="btn btn-secondary" data-cancel>Cancel</button><button class="btn btn-primary" id="wi-ingest-submit">Start Ingestion</button></div>`);
  el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => close());
  el.querySelector('#wi-ingest-submit').onclick = async (event) => {
    if (ingestionStarting) { close(); return; }
    ingestionStarting = true; event.currentTarget.disabled = true; event.currentTarget.innerHTML = '<span class="spinner"></span> Starting…';
    el.querySelectorAll('[data-cancel]').forEach(b => { b.disabled = true; }); renderHeader();
    try {
      const response = await requestWebImportIngestion(apiFetch, ENDPOINTS.webImportIngest(orgId, kbId, importId));
      session = { ...session, ...response, ingestion_pages: null };
      pollFatal = false; ingestionStarting = false; close();
      render();
      if (shouldPollImport(session)) startPolling({ immediate: true });
      else toast(ingestionStatusInfo(session.ingestion_status).label, 'success');
    } catch (e) {
      ingestionStarting = false;
      const message = e?.status === 400 || e?.status === 409
        ? (e.message || 'The server rejected the ingestion request. Review the import status and try again.')
        : 'Could not start ingestion because the server could not be reached. The approved snapshot is unchanged; you can retry.';
      el.querySelector('[role="alert"]')?.remove();
      el.querySelector('.modal-body')?.insertAdjacentHTML('beforeend', `<div class="alert alert-warning mt1" role="alert">${escapeHtml(message)}</div>`);
      event.currentTarget.disabled = false; event.currentTarget.textContent = 'Retry';
      el.querySelectorAll('[data-cancel]').forEach(b => { b.disabled = false; });
      renderHeader();
    }
  };
}

async function refreshImportStatus() {
  if (statusRefreshing) return;
  statusRefreshing = true;
  stopPolling();
  pollFatal = false;
  render();
  try {
    const [s, p] = await fetchPollPair();
    onUpdate({ session: normalizeSession(s), pages: normalizePages(p) });
    if (shouldPollImport(session)) startPolling({ immediate: true });
  } catch {
    pollFatal = true; render();
  } finally {
    statusRefreshing = false;
    render();
  }
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
    // Page-draft PATCH was removed; edit the underlying document's content instead.
    const res = await apiFetch(ENDPOINTS.documentContent(orgId, kbId, encodeURIComponent(id)), { method: 'PATCH', body: { content: editor.text } });
    const response = res?.document || res?.page || res || {};
    pages = pages.map(p => String(p.id) === id ? { ...p, ...response, id: p.id, content: response.content ?? editor.text, word_count: response.word_count ?? editor.text.trim().split(/\s+/).filter(Boolean).length } : p);
    editor.text = pages.find(p => String(p.id) === id)?.content || editor.text;
    editor.saving = false; editor.editing = false; editor.saved = true; render(); toast('Content saved', 'success'); return true;
  } catch (e) { editor.saving = false; editor.error = e?.status && e.status < 500 ? e.message : 'Could not save this content. Try again.'; renderContent(); return false; }
}

async function deleteDraft(p) {
  const id = String(p.id); if (session.status === 'confirmed' || deleteBusy.has(id)) return;
  const ok = await confirmDialog({ title: 'Delete this page?', body: 'This removes the page (and its document) from the current review session. It does not delete content already indexed in the knowledge base.', confirmText: 'Delete' });
  if (!ok || deleteBusy.has(id)) return;
  deleteBusy.add(id); renderContent();
  try {
    // Page-draft DELETE was removed; delete the document itself.
    await apiFetch(ENDPOINTS.documentDetail(orgId, kbId, encodeURIComponent(id)), { method: 'DELETE' });
    pages = pages.filter(x => String(x.id) !== id);
    session.total_pages = pages.length;
    session.completed_pages = pages.filter(x => pageStatusInfo(x.status).key === 'completed').length;
    session.failed_pages = pages.filter(x => pageStatusInfo(x.status).key === 'failed').length;
    session.processing_pages = pages.filter(x => pageStatusInfo(x.status).key === 'processing').length;
    session.pending_pages = pages.filter(x => pageStatusInfo(x.status).key === 'pending').length;
    if (editor.id === id) editor = { id: null, text: '', editing: false, saving: false, error: '', saved: false };
    const preferred = selectedId === id ? (pages.find(x => pageStatusInfo(x.status).key === 'completed')?.id ?? null) : selectedId;
    selectedId = resolveSelectedId(pages, preferred); render(); toast('Page deleted', 'success');
  } catch (e) { deleteBusy.delete(id); toast(e?.status && e.status < 500 ? e.message : 'Could not delete this page. Try again.', 'error'); renderContent(); return; }
  deleteBusy.delete(id);
}

function renderPollWarn(count) {
  const w = document.getElementById('wi-poll-warn');
  if (!w) return;
  if (pollFatal) {
    w.innerHTML = `<div class="alert alert-warning mt1" role="alert"><span>⚠️</span><div class="tiny">Status updates stopped after a connection problem. <button type="button" class="btn btn-ghost btn-sm" id="wi-refresh-status" ${statusRefreshing ? 'disabled' : ''}>${statusRefreshing ? 'Refreshing…' : 'Refresh status'}</button></div></div>`;
    w.querySelector('#wi-refresh-status')?.addEventListener('click', refreshImportStatus);
    return;
  }
  w.innerHTML = count
    ? `<div class="alert alert-warning mt1"><span>⚠️</span><div class="tiny">Temporary problem reaching the server — retrying… (attempt ${count})</div></div>`
    : '';
}

function render() { renderHeader(); renderList(); renderContent(); renderPollWarn(0); }

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
  selectedId = resolveSelectedId(visiblePages(), selectedId);
  render();
}

function onUpdate({ session: s, pages: p }) {
  if (!mounted) return;
  // A UI exception here must never be mistaken for a failed poll (the poller
  // counts thrown errors as network failures and would stop after 3 of them).
  try {
    session = session.status === 'confirmed'
      ? { ...s, status: 'confirmed', confirmed_at: session.confirmed_at || s.confirmed_at, page_count: session.page_count || s.page_count, included_pages: session.included_pages || s.included_pages }
      : s;
    pages = mergePolledPages(p, pages, { editingId: editor.editing ? editor.id : null, editorText: editor.text });
    selectedId = resolveSelectedId(visiblePages(), selectedId);
    pollFatal = false;
    renderPollWarn(0);
    render();
  } catch (err) {
    console.error('[web-import] failed to render poll update', err);
  }
  if (!shouldPollImport(session)) stopPolling();
}

function startPolling({ immediate = false } = {}) {
  if (poller) return;
  poller = createImportPoller({
    fetchStatus: () => fetchPollPair().then(([status]) => status),
    fetchPages: () => fetchPollPair().then(([, pageData]) => pageData),
    onUpdate,
    interval: WEB_IMPORT_POLL_MS,
    maxConsecutiveFailures: WEB_IMPORT_MAX_FAILURES,
    onError: (err, info) => {
      if (!mounted) return;
      if (info.fatal) {
        pollFatal = true;
        stopPolling();
        toast('Stopped updating — the server could not be reached.', 'error');
        render();
        renderPollWarn(0);
      } else {
        renderPollWarn(info.failures);
      }
    },
  });
  poller.start({ immediate });
}
function stopPolling() { if (poller) { poller.stop(); poller = null; } }

document.addEventListener('visibilitychange', () => {
  if (!mounted) return;
  if (document.hidden) stopPolling();
  else if (shouldPollImport(session)) startPolling({ immediate: true });
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
    const [s, p] = await fetchPollPair();
    if (!mounted) return;
    applyData(s, p);
    if (shouldPollImport(session)) startPolling({ immediate: true });
  } catch (e) {
    renderFatal(classifySessionError(e), e);
  }
}

await boot();
