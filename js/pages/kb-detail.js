import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext, currentRole } from '../components/org-switcher.js';
import { apiFetch, asList, uploadWithProgress } from '../api.js';
import { ENDPOINTS, ACCEPTED_EXTS, MAX_FILE_MB, POLL_MS } from '../config.js';
import { toast, confirmDialog, skeletonList, emptyState, openModal } from '../ui.js';
import { escapeHtml, timeAgo, formatBytes, qp, debounce } from '../utils.js';
import { startWebImport as startWebImportRequest, webImportUrl, normalizeImportList, isSessionTerminal, sessionProgress, progressText, sessionStatusInfo } from './web-import-controller.js';
import { docStatusInfo, isDocPollTerminal, requestDocContent, saveDocContent, confirmAndStartEmbedding } from './doc-review-controller.js';
initTheme();
await guard('knowledge-bases.html');
const { orgId, org } = await getOrgContext();
const kbId = qp('id');
const page = document.getElementById('page');
const role = currentRole(org);
const canManage = role === 'owner' || role === 'admin';
if (!kbId) { page.innerHTML = emptyState('📚', 'No KB selected', '', `<a class="btn btn-primary" href="knowledge-bases.html">Back to list</a>`); throw 0; }
let kb = null, docs = [], tab = qp('tab', 'documents');
/** Per-document polling timers: docId -> timeout id. Prevents duplicate loops. */
const docTimers = new Map();
/** docIds currently retrying (Retry button disabled). */
const retrying = new Set();
/** docIds with an in-flight status request (avoid overlapping polls). */
const inflight = new Set();
/** Doc field accessors — backend key names vary. */
const docId = (d) => d.id || d.doc_id || d.pk || d.uuid;
const docName = (d) => d.filename || d.file_name || d.name || 'Untitled';
const docStatus = (d) => String(
  d.status || d.ingestion_status || d.state || d.ingest_status
  || (d.ingested_at ? 'completed' : 'pending')
);
const docChunks = (d) => (d.chunk_count ?? d.chunks_count ?? d.chunks ?? null);
const docError = (d) => d.error_message || d.error || d.last_error || '';
const docIngestedAt = (d) => d.ingested_at || d.ingestedAt || null;
const docWords = (d) => (Number(d.word_count) || null);
const docConfirmedAt = (d) => d.confirmed_at || null;
/** Clear frontend status mapping. */
function statusLabel(d) {
  if (retrying.has(String(docId(d)))) return 'Retrying…';
  return docStatusInfo(docStatus(d)).label;
}
/** Documents come embedded in the KB detail (no separate list endpoint). */
function kbDocs(detail) {
  if (!detail || typeof detail !== 'object') return [];
  for (const k of ['documents', 'files', 'docs', 'uploads', 'items']) {
    if (Array.isArray(detail[k])) return detail[k];
  }
  return [];
}
/* ================= Website URL discovery =================
 * Flow: POST {root_url} -> discover/ returns the site's available pages, the
 * user picks the ones to import, then "Review selected pages" starts a web
 * import session (POST web-imports/) and navigates to the review screen.
 */
const DISCOVER_PANEL_HTML = `
  <div class="discover">
    <div class="discover-intro">
      <p class="small">Point us at a website and we'll discover the pages that can be added to this knowledge base. Pick the ones you need — nothing is scraped until you confirm.</p>
    </div>
    <div class="url-row">
      <div class="url-input"><span aria-hidden="true">🔗</span><input id="root-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://docs.example.com"></div>
      <button class="btn btn-primary" id="discover-btn"><span class="disc-ico" aria-hidden="true">🌐</span> Discover pages</button>
    </div>
    <p class="tiny muted mt1" id="disc-hint">Works best on public docs or help-center sites. Sub-pages of the same host are included.</p>
    <div id="disc-result" class="mt2" aria-live="polite"></div>
  </div>`;

/* ---------- discovery response normalizers (backend key names vary) ---------- */
function normalizeRootUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.')) return '';
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}
const pageUrl = (p) => (typeof p === 'string' ? p : (p.url || p.link || p.href || p.path || ''));
const pageTitle = (p) => (typeof p === 'string' ? '' : (p.title || p.name || p.label || ''));
const pageDepth = (p) => (typeof p === 'string' ? null : (p.depth ?? p.level ?? null));
function discoverPages(res) {
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object') {
    for (const k of ['pages', 'urls', 'links', 'results', 'data', 'items', 'sitemap']) if (Array.isArray(res[k])) return res[k];
  }
  return [];
}
/* ---------- state ---------- */
let discovered = [];      // normalized {url, title, depth}
const picked = new Set(); // selected urls
let rootUrl = '';
let discLoading = false;
let discQuery = '';

function renderDiscoverIdle() {
  const w = document.getElementById('disc-result');
  if (!w) return;
  w.innerHTML = `<div class="disc-empty">${emptyState('🔍', 'No search yet', rootUrl ? `Pages will appear here once you discover <span class="mono">${escapeHtml(rootUrl)}</span>.` : 'Enter a website URL above to see the pages we can add.', '')}</div>`;
}
function renderDiscoverLoading() {
  const w = document.getElementById('disc-result');
  if (!w) return;
  w.innerHTML = `<div class="disc-status"><span class="spinner dark"></span><div><strong>Crawling ${escapeHtml(rootUrl)}…</strong><div class="tiny muted">Scanning the site for public pages. This can take a few seconds.</div></div></div>
    <div class="mt2">${skeletonList(2)}</div>`;
}
function renderDiscoverError(msg) {
  const w = document.getElementById('disc-result');
  if (!w) return;
  w.innerHTML = `<div class="alert alert-danger disc-error"><span>⚠️</span><div><strong>Discovery failed</strong><div class="tiny">${escapeHtml(msg)}</div></div><button class="btn btn-secondary btn-sm" id="disc-retry">Retry</button></div>`;
  w.querySelector('#disc-retry').onclick = () => runDiscover();
}
function visiblePages() {
  const q = discQuery.trim().toLowerCase();
  if (!q) return discovered;
  return discovered.filter(p => `${p.title} ${p.url}`.toLowerCase().includes(q));
}
function renderDiscoverResults() {
  const w = document.getElementById('disc-result');
  if (!w) return;
  const list = visiblePages();
  const allOn = list.length > 0 && list.every(p => picked.has(p.url));
  w.innerHTML = `
    <div class="disc-bar">
      <div class="disc-bar-info">
        <strong>${discovered.length} page${discovered.length === 1 ? '' : 's'} found</strong>
        <span class="tiny muted">· ${picked.size} selected</span>
        <span class="chip disc-root" title="${escapeHtml(rootUrl)}">${escapeHtml(rootUrl)}</span>
      </div>
      <div class="disc-bar-actions">
        <div class="search-input disc-search"><span>🔍</span><input id="disc-filter" placeholder="Filter pages…" value="${escapeHtml(discQuery)}"></div>
        <button class="btn btn-ghost btn-sm" id="disc-toggle-all">${allOn ? 'Clear all' : 'Select all'}</button>
        <button class="btn btn-ghost btn-sm" id="disc-rediscover">↻ Rescan</button>
      </div>
    </div>
    ${list.length ? `<div class="disc-list" role="group" aria-label="Discovered pages">${list.map(p => `
      <label class="page-pick${picked.has(p.url) ? ' selected' : ''}">
        <input type="checkbox" data-url="${escapeHtml(p.url)}" ${picked.has(p.url) ? 'checked' : ''}>
        <span class="page-ico" aria-hidden="true">📄</span>
        <span class="page-meta">
          <span class="page-title">${escapeHtml(p.title || p.url.split('/').filter(Boolean).pop() || p.url)}</span>
          <span class="page-url tiny muted mono" title="${escapeHtml(p.url)}">${escapeHtml(p.url)}</span>
        </span>
        ${p.depth != null ? `<span class="chip depth-chip">L${p.depth}</span>` : ''}
        <a class="icon-btn" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" title="Open in new tab" aria-label="Open ${escapeHtml(p.url)} in new tab">↗</a>
      </label>`).join('')}</div>`
      : `<div class="disc-none">${emptyState('🕳️', 'No matches', `No discovered page matches “${escapeHtml(discQuery)}”.`, '')}</div>`}
    <div class="disc-foot">
      <span class="tiny muted">${picked.size ? `${picked.size} page${picked.size === 1 ? '' : 's'} ready to scrape` : 'Select at least one page to continue'}</span>
      <div class="flex" style="gap:10px">
        <button class="btn btn-secondary btn-sm" data-close>Cancel</button>
        <button class="btn btn-primary btn-sm" id="disc-add" ${picked.size ? '' : 'disabled'}>Review ${picked.size || ''} page${picked.size === 1 ? '' : 's'}</button>
      </div>
    </div>`;
  const filter = w.querySelector('#disc-filter');
  filter.oninput = debounce((e) => { discQuery = e.target.value; const pos = e.target.selectionStart; renderDiscoverResults(); const nf = document.getElementById('disc-filter'); if (nf) { nf.focus(); nf.setSelectionRange(pos, pos); } }, 200);
  w.querySelector('#disc-toggle-all').onclick = () => {
    const list2 = visiblePages();
    if (list2.every(p => picked.has(p.url))) list2.forEach(p => picked.delete(p.url));
    else list2.forEach(p => picked.add(p.url));
    renderDiscoverResults();
  };
  w.querySelector('#disc-rediscover').onclick = () => runDiscover();
  w.querySelectorAll('.page-pick input').forEach(c => c.onchange = () => { c.checked ? picked.add(c.dataset.url) : picked.delete(c.dataset.url); renderDiscoverResults(); });
  const add = w.querySelector('#disc-add');
  add.onclick = () => startWebImport(add);
  w.querySelectorAll('[data-close]').forEach(b => b.onclick = resetDiscoverPanel);
}
/**
 * Step 2: submit the selected URLs, then hand off to the review screen. The
 * import id is carried in the route so a refresh restores the session.
 */
async function startWebImport(btn) {
  const urls = [...picked];
  if (!urls.length) return;
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Starting…`;
  try {
    const { importId } = await startWebImportRequest({
      urls,
      createImport: (list) => apiFetch(ENDPOINTS.webImports(orgId, kbId), { method: 'POST', body: { urls: list } }),
    });
    toast(`Import started for ${urls.length} page${urls.length === 1 ? '' : 's'}`, 'success');
    location.href = webImportUrl(kbId, importId);
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = label;
    toast(e.status === 403 ? 'Permission denied.' : (e.message || 'Could not start the import.'), 'error');
  }
}
/** Back to the upload source, discarding any discovery in progress. */
function resetDiscoverPanel() {
  discovered = []; picked.clear(); discQuery = ''; rootUrl = '';
  document.getElementById('src-website').hidden = true;
  document.getElementById('src-upload').hidden = false;
  page.querySelectorAll('[data-source]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.source === 'upload')));
  const input = document.getElementById('root-url');
  if (input) input.value = '';
  renderDiscoverIdle();
}
async function runDiscover() {
  if (discLoading) return;
  const input = document.getElementById('root-url');
  const btn = document.getElementById('discover-btn');
  const raw = input?.value || rootUrl;
  const url = normalizeRootUrl(raw);
  const hint = document.getElementById('disc-hint');
  if (!url) {
    input?.closest('.url-input')?.classList.add('invalid');
    hint.className = 'tiny mt1 disc-error-text';
    hint.textContent = 'Enter a valid website URL, e.g. https://docs.example.com';
    input?.focus();
    return;
  }
  input.closest('.url-input')?.classList.remove('invalid');
  input.value = url;
  rootUrl = url;
  hint.className = 'tiny muted mt1';
  hint.textContent = 'Works best on public docs or help-center sites. Sub-pages of the same host are included.';
  discLoading = true;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Discovering…`;
  renderDiscoverLoading();
  try {
    const res = await apiFetch(ENDPOINTS.discover(orgId, kbId), { method: 'POST', body: { root_url: url } });
    const seen = new Set();
    discovered = discoverPages(res).map(p => ({ url: pageUrl(p), title: pageTitle(p), depth: pageDepth(p) })).filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url); return true;
    });
    picked.clear();
    discQuery = '';
    if (!discovered.length) { renderDiscoverError('No pages were found on that site. Try the root domain or a different URL.'); return; }
    renderDiscoverResults();
  } catch (e) {
    renderDiscoverError(e.status === 403 ? 'Permission denied.' : (e.message || 'Could not reach the site.'));
  } finally {
    discLoading = false;
    btn.disabled = false;
    btn.innerHTML = `<span class="disc-ico" aria-hidden="true">🌐</span> Discover pages`;
  }
}
async function loadKb() {
  try { kb = await apiFetch(ENDPOINTS.kbDetail(orgId, kbId), { cacheTtl: 15000 }); }
  catch { const l = asList(await apiFetch(ENDPOINTS.kbs(orgId), { cacheTtl: 15000 }).catch(() => [])); kb = l.find(x => String(x.id) === String(kbId)) || { id: kbId, name: 'Knowledge Base' }; }
  return kb;
}
/** Polling stops at ready_for_review (open the editor) or a final state. */
const isFinal = (d) => isDocPollTerminal(docStatus(d));
function stopPoll(id) {
  const key = String(id);
  if (docTimers.has(key)) { clearTimeout(docTimers.get(key)); docTimers.delete(key); }
  inflight.delete(key);
}
function stopAllPolls() { [...docTimers.keys()].forEach(stopPoll); }
/** Doc ids whose review modal has been auto-opened this session (don't re-open on later polls). */
const reviewOpened = new Set();
/**
 * Reusable per-document poller. Fetches GET documentDetail every POLL_MS
 * until the doc reaches ready_for_review or a final state (ready/failed).
 * On ready_for_review it stops polling and opens the review editor.
 * Safe: no duplicate loops, no overlap, survives re-renders, cleans up.
 */
function pollDocumentStatus(id) {
  const key = String(id);
  if (docTimers.has(key)) return; // already polling this document
  const tick = async () => {
    docTimers.delete(key);
    if (inflight.has(key)) { docTimers.set(key, setTimeout(tick, POLL_MS)); return; }
    inflight.add(key);
    try {
      const fresh = await apiFetch(ENDPOINTS.documentDetail(orgId, kbId, id), { cacheTtl: 0 });
      inflight.delete(key);
      if (fresh && typeof fresh === 'object') {
        const i = docs.findIndex(d => String(docId(d)) === key);
        if (i !== -1) docs[i] = { ...docs[i], ...fresh };
        else docs.push(fresh);
        renderDocs();
        if (isFinal(fresh)) {
          if (docStatusInfo(docStatus(fresh)).key === 'review' && canManage && !reviewOpened.has(key)) {
            reviewOpened.add(key);
            openDocReview(key); // extraction done — review before embedding
          }
          return; // terminal — stop polling
        }
      }
    } catch {
      inflight.delete(key);
      // Network error during polling → graceful: keep polling silently.
      // If the doc was deleted locally, stop.
      if (!docs.some(d => String(docId(d)) === key)) return;
    }
    // Abort if doc removed or now terminal (e.g. deleted while polling)
    const cur = docs.find(d => String(docId(d)) === key);
    if (!cur || isFinal(cur)) return;
    docTimers.set(key, setTimeout(tick, POLL_MS));
  };
  docTimers.set(key, setTimeout(tick, POLL_MS));
}
function pollPendingDocs() { docs.filter(d => !isFinal(d)).forEach(d => pollDocumentStatus(docId(d))); }
async function loadDocs(silent, seedDetail) {
  try {
    // Reuse the kbDetail already fetched by loadKb() — zero extra requests
    // on first paint. Only hit network on explicit refresh / polling resume.
    const detail = seedDetail && typeof seedDetail === 'object' ? seedDetail : await apiFetch(ENDPOINTS.kbDetail(orgId, kbId), { cacheTtl: 0 });
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) kb = { ...kb, ...detail };
    // Preserve locally-known retrying flags across list refresh.
    docs = kbDocs(detail);
    renderDocs();
    pollPendingDocs(); // resume polling after refresh (user may reload mid-ingestion)
  } catch (e) { if (!silent) toast(e.message, 'error'); }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAllPolls();
  else pollPendingDocs();
});
window.addEventListener('pagehide', stopAllPolls);
window.addEventListener('beforeunload', stopAllPolls);
function fileIcon(fn = '') { const e = fn.split('.').pop().toLowerCase(); return e === 'pdf' ? '📕' : e === 'docx' ? '📘' : '📄'; }
function renderDocs() {
  const w = document.getElementById('docs');
  if (!w) return;
  if (!docs.length) { w.innerHTML = emptyState('📄', 'No documents yet', 'Upload PDFs, DOCX, MD or TXT. Documents are split using a recursive text splitter.', ''); return; }
  const hasPending = docs.some(d => !isFinal(d));
  const reviewDocs = docs.filter(d => docStatusInfo(docStatus(d)).key === 'review');
  const reviewBanner = reviewDocs.length && canManage ? `<div class="alert alert-info flex between mt1" style="align-items:center;gap:12px" role="status">
      <span>📄 <strong>${reviewDocs.length} document${reviewDocs.length === 1 ? '' : 's'} ready for review</strong> — check the extracted text, then confirm to start embedding.</span>
      <button class="btn btn-primary btn-sm" id="docs-review-all">Review now</button>
    </div>` : '';
  w.innerHTML = `${reviewBanner}<div class="table-wrap"><table><thead><tr><th>File</th><th>Status</th><th>Chunks</th><th>Uploaded</th><th></th></tr></thead><tbody>
    ${docs.map(d => {
      const id = docId(d);
      const st = docStatusInfo(docStatus(d));
      const failed = st.key === 'failed';
      const needsReview = st.key === 'review';
      const err = failed ? docError(d) : '';
      const busy = retrying.has(String(id));
      const chunks = docChunks(d);
      const ingested = docIngestedAt(d);
      const words = docWords(d);
      const confirmed = docConfirmedAt(d);
      // The badge itself is the primary "open the review" affordance.
      const statusCell = needsReview && canManage
        ? `<button class="badge ${st.badge} badge-link" data-review-doc="${id}" title="Open the review editor">${escapeHtml(statusLabel(d))} →</button>`
        : `<span class="badge ${st.badge}">${escapeHtml(statusLabel(d))}</span>`;
      return `<tr><td>${fileIcon(docName(d))} <strong>${escapeHtml(docName(d))}</strong><br><span class="tiny muted">${formatBytes(d.size_bytes || d.size)}${words ? ` · ${words.toLocaleString()} words` : ''}${confirmed ? ` · confirmed ${escapeHtml(timeAgo(confirmed))}` : ''}${ingested ? ` · ingested ${escapeHtml(String(ingested))}` : ''}</span>${err ? `<br><span class="tiny" style="color:var(--danger)">Failed: ${escapeHtml(String(err))}</span>` : ''}</td>
    <td>${statusCell}</td>
    <td class="mono">${chunks ?? '—'}</td><td class="small" title="${escapeHtml(d.created_at || d.uploaded_at || '')}">${timeAgo(d.created_at || d.uploaded_at)}${d.uploaded_by ? `<br><span class="tiny muted">${escapeHtml(d.uploaded_by)}</span>` : ''}</td>
    <td style="white-space:nowrap">${needsReview && canManage ? `<button class="btn btn-primary btn-sm" data-review-doc="${id}">Review</button> ` : ''}${failed && canManage ? `<button class="btn btn-secondary btn-sm" data-retry-doc="${id}" ${busy ? 'disabled' : ''}>${busy ? 'Retrying…' : 'Retry'}</button> ` : ''}${canManage ? `<button class="btn btn-ghost btn-sm" data-rm="${id}">Delete</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>
    ${hasPending ? `<p class="tiny muted mt1">⏳ Checking status every few seconds… <button class="btn btn-ghost btn-sm" id="docs-refresh">Refresh now</button></p>` : ''}`;
  const rf = w.querySelector('#docs-refresh');
  if (rf) rf.onclick = () => loadDocs(false);
  w.querySelector('#docs-review-all')?.addEventListener('click', () => {
    const first = reviewDocs[0];
    if (first) openDocReview(docId(first));
  });
  w.querySelectorAll('[data-review-doc]').forEach(b => b.onclick = () => openDocReview(b.dataset.reviewDoc));
  w.querySelectorAll('[data-retry-doc]').forEach(b => b.onclick = () => retryDoc(b.dataset.retryDoc, b));
  w.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({ title: 'Delete document?', body: 'The file and its chunks will be removed from search.', confirmText: 'Delete' })) return;
    const id = b.dataset.rm;
    try {
      await apiFetch(ENDPOINTS.documentDetail(orgId, kbId, id), { method: 'DELETE' });
      stopPoll(id); // do not poll after deletion; Qdrant cleanup runs in background
      docs = docs.filter(d => String(docId(d)) !== String(id));
      renderDocs();
      toast('Document deleted', 'success');
    }
    catch (e) { toast(e.status === 403 ? 'Permission denied.' : e.message, 'error'); }
  });
}
async function retryDoc(id, btn) {
  const key = String(id);
  if (retrying.has(key)) return; // prevent duplicate requests
  retrying.add(key);
  if (btn) btn.disabled = true;
  renderDocs();
  try {
    const res = await apiFetch(ENDPOINTS.documentRetry(orgId, kbId, id), { method: 'POST' });
    const i = docs.findIndex(d => String(docId(d)) === key);
    const next = (res && typeof res === 'object' && (res.status || res.document))
      ? { ...(res.document || res), status: res.status || res.document?.status || 'pending', error_message: '' }
      : { status: 'pending', error_message: '' };
    if (i !== -1) docs[i] = { ...docs[i], ...next };
    renderDocs();
    toast('Retry queued — watching status…', 'success');
    stopPoll(key);
    pollDocumentStatus(key); // resume polling after retry
  } catch (e) {
    // 409: ready_for_review — "edit it, then confirm…" (retry re-runs nothing there).
    toast(e.status === 403 ? 'Permission denied.' : (e.message || 'Retry failed.'), 'error');
    if (e.status === 409) loadDocs(true); // refresh row so the Review button appears
  }
  finally { retrying.delete(key); renderDocs(); }
}
/* ================= Document review (upload → ready_for_review) =================
 * Uploaded files park in ready_for_review after extraction. The review modal
 * fetches the extracted content, optionally PATCHes edits, then confirms
 * (freezes edits) and starts embedding — two calls, like web import.
 */
function setDocLocal(id, patch) {
  const i = docs.findIndex(d => String(docId(d)) === String(id));
  if (i !== -1) docs[i] = { ...docs[i], ...patch };
  renderDocs();
}
async function openDocReview(id) {
  const key = String(id);
  const doc = docs.find(d => String(docId(d)) === key);
  const fname = doc ? docName(doc) : 'Document';
  let state = { loading: true, content: '', original: '', words: 0, editable: true, extractError: '', saving: false, confirming: false, error: '', dirty: false };
  const { el, close } = openModal(`
    <div class="modal-head"><h3>Review document</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="modal-body" id="dr-body"></div>
    <div class="modal-foot" id="dr-foot"><button class="btn btn-secondary" data-close>Close</button></div>`, { wide: true });
  const body = el.querySelector('#dr-body');
  const foot = el.querySelector('#dr-foot');
  const render = () => {
    body.innerHTML = state.loading
      ? `<div class="flex"><span class="spinner dark"></span> <span class="muted small">Loading extracted content…</span></div>`
      : `<p class="small muted">Review the text extracted from <strong>${escapeHtml(fname)}</strong>. You can edit it before confirming — confirmation freezes the content and starts embedding.</p>
      ${state.extractError ? `<div class="alert alert-warning mt1" role="alert">${escapeHtml(state.extractError)}</div>` : ''}
      ${state.error ? `<div class="alert alert-danger mt1" role="alert">${escapeHtml(state.error)}</div>` : ''}
      <div class="wi-editor mt2">
        <div class="wi-editor-status" aria-live="polite">
          ${state.editable ? '' : '<span class="badge b-completed">Confirmed — read-only</span>'}
          ${state.dirty ? '<span class="badge b-warning">Unsaved changes</span>' : ''}
          <span class="tiny muted">${state.words.toLocaleString()} words</span>
        </div>
        <label class="sr-only" for="dr-text">Extracted content</label>
        <textarea id="dr-text" rows="18" spellcheck="false" ${state.editable && !state.saving && !state.confirming ? '' : 'disabled'}>${escapeHtml(state.content)}</textarea>
      </div>`;
    foot.innerHTML = state.editable
      ? `<button class="btn btn-secondary" data-close ${state.saving || state.confirming ? 'disabled' : ''}>Close</button>
         <button class="btn btn-secondary" id="dr-save" ${state.saving || state.confirming || !state.dirty ? 'disabled' : ''}>${state.saving ? '<span class="spinner"></span> Saving…' : 'Save'}</button>
         <button class="btn btn-primary" id="dr-confirm" ${state.saving || state.confirming || state.dirty || state.loading ? 'disabled' : ''}>${state.confirming ? '<span class="spinner"></span> Starting…' : 'Confirm & start embedding'}</button>`
      : `<button class="btn btn-secondary" data-close>Close</button>`;
    foot.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    el.querySelector('#dr-text')?.addEventListener('input', (e) => {
      state.content = e.target.value;
      state.dirty = state.content !== state.original;
      const save = foot.querySelector('#dr-save'); if (save) save.disabled = state.saving || !state.dirty;
      const conf = foot.querySelector('#dr-confirm'); if (conf) conf.disabled = state.saving || state.confirming || state.dirty;
      const st = body.querySelector('.wi-editor-status');
      if (st) st.innerHTML = `${state.editable ? '' : '<span class="badge b-completed">Confirmed — read-only</span>'}${state.dirty ? '<span class="badge b-warning">Unsaved changes</span>' : ''}<span class="tiny muted">${state.words.toLocaleString()} words</span>`;
    });
    foot.querySelector('#dr-save')?.addEventListener('click', saveContent);
    foot.querySelector('#dr-confirm')?.addEventListener('click', confirmAndEmbed);
  };
  async function saveContent() {
    if (state.saving || !state.dirty) return;
    state.saving = true; state.error = ''; render();
    try {
      const res = await saveDocContent(apiFetch, ENDPOINTS.documentContent(orgId, kbId, key), state.content);
      state.content = res.content; state.original = res.content;
      state.words = res.word_count || state.words;
      state.editable = res.editable !== false;
      state.dirty = false;
      setDocLocal(key, { word_count: state.words });
      toast('Content saved', 'success');
    } catch (e) {
      // 400 blank/oversized · 409 already confirmed
      state.error = e.status === 409
        ? 'This document was already confirmed — the content is now read-only.'
        : (e.message || 'Could not save the content.');
      if (e.status === 409) { state.editable = false; state.dirty = false; }
    } finally { state.saving = false; render(); }
  }
  async function confirmAndEmbed() {
    if (state.confirming || state.dirty) return;
    state.confirming = true; state.error = ''; render();
    try {
      const { confirmation, queued } = await confirmAndStartEmbedding({
        confirm: () => apiFetch(ENDPOINTS.documentConfirm(orgId, kbId, key), { method: 'POST', body: {} }),
        ingest: () => apiFetch(ENDPOINTS.documentIngest(orgId, kbId, key), { method: 'POST', body: {} }),
      });
      state.confirming = false;
      setDocLocal(key, {
        status: queued.status || 'pending',
        chunk_count: queued.chunk_count ?? null,
        confirmed_at: confirmation.confirmed_at,
        word_count: confirmation.word_count || state.words,
        error_message: '',
      });
      close();
      toast(queued.already_processing ? 'Already embedding — watching status…' : 'Confirmed — embedding started…', 'success');
      stopPoll(key);
      if (!isFinal(docs.find(d => String(docId(d)) === key) || {})) pollDocumentStatus(key);
    } catch (e) {
      state.confirming = false;
      // 409 on ingest = not confirmed yet; 409 on confirm = already confirmed elsewhere.
      state.error = e.status === 409
        ? (e.message || 'The server rejected this request — the document may already be confirmed or embedding.')
        : (e.message || 'Could not start embedding. Your content is unchanged; try again.');
      render();
    }
  }
  render();
  try {
    const res = await requestDocContent(apiFetch, ENDPOINTS.documentContent(orgId, kbId, key));
    // Editable only while the doc is still in review (not confirmed elsewhere).
    const stillReview = !doc || docStatusInfo(docStatus(doc)).key === 'review';
    state = { ...state, loading: false, content: res.content, original: res.original_content || res.content, words: res.word_count, editable: res.editable !== false && stillReview, extractError: res.error };
    render();
  } catch (e) {
    state.loading = false;
    state.error = e.status === 403 ? 'Permission denied.' : (e.message || 'Could not load the document content.');
    render();
  }
}
const uploads = new Map();
function renderUploads() {
  const w = document.getElementById('uploads'); if (!w) return;
  w.innerHTML = [...uploads.entries()].map(([id, u]) => `<div class="upload-row"><span>⏫</span><span style="flex:1"><strong>${escapeHtml(u.name)}</strong><div class="progress mt1"><div style="width:${u.p}%"></div></div><span class="tiny muted">${u.state} · ${u.p}%</span></span>${u.state === 'failed' ? `<button class="btn btn-secondary btn-sm" data-retry="${id}">Retry</button>` : ''}${u.state !== 'done' ? `<button class="btn btn-ghost btn-sm" data-cancel="${id}">Cancel</button>` : ''}</div>`).join('');
  w.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { uploads.get(b.dataset.cancel)?.ctrl.abort(); });
  w.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => { const u = uploads.get(b.dataset.retry); if (u) startUpload(u.file); });
}
async function startUpload(file) {
  const id = file.name + Date.now();
  const ctrl = new AbortController();
  uploads.set(id, { name: file.name, p: 0, state: 'uploading', file, ctrl }); renderUploads();
  const fd = new FormData(); fd.append('file', file);
  try {
    // Backend returns 202 Accepted — extraction runs server-side and the doc
    // parks in ready_for_review (like web-import drafts). No embedding yet.
    const created = await uploadWithProgress(ENDPOINTS.ingest(orgId, kbId), fd, (p) => { const u = uploads.get(id); if (u) { u.p = p; renderUploads(); } }, ctrl.signal);
    uploads.get(id).state = 'done'; uploads.get(id).p = 100; renderUploads();
    setTimeout(() => { uploads.delete(id); renderUploads(); }, 2500);
    if (created && typeof created === 'object' && docId(created)) {
      // Show the document immediately as pending/processing, then poll until ready_for_review.
      const optimistic = { status: 'pending', chunk_count: null, ...created };
      if (!docs.some(d => String(docId(d)) === String(docId(optimistic)))) docs.push(optimistic);
      renderDocs();
      toast(`${file.name} uploaded — extracting text…`, 'success');
      if (!isFinal(optimistic)) pollDocumentStatus(docId(optimistic));
      else if (docStatusInfo(docStatus(optimistic)).key === 'review' && canManage) openDocReview(docId(optimistic));
    } else {
      toast(`${file.name} uploaded — extracting text…`, 'success');
      await loadDocs(true); // fallback: refresh list, polling resumes for pending docs
    }
  } catch (e) { const u = uploads.get(id); if (u) { u.state = 'failed'; renderUploads(); } toast(`${file.name}: ${e.message}`, 'error'); }
}
function validFile(f) {
  const ext = '.' + f.name.split('.').pop().toLowerCase();
  if (!ACCEPTED_EXTS.includes(ext)) { toast(`${f.name}: unsupported type. Use ${ACCEPTED_EXTS.join(', ')}`, 'error'); return false; }
  if (f.size > MAX_FILE_MB * 1024 * 1024) { toast(`${f.name}: exceeds ${MAX_FILE_MB} MB.`, 'error'); return false; }
  return true;
}
await loadKb();
page.innerHTML = `
  <p><a href="knowledge-bases.html">← Knowledge Bases</a></p>
  <div class="page-head"><div><h2>${escapeHtml(kb.name)}</h2><p class="muted">${escapeHtml(kb.description || '')}</p></div>
  ${canManage ? `<button class="btn btn-secondary btn-sm" id="kb-edit">Edit KB</button>` : `<span class="badge b-member">🔒 Read-only</span>`}</div>
  <div class="tabs" role="tablist"><button class="tab" data-tab="documents" aria-selected="${tab === 'documents'}">Documents</button><button class="tab" data-tab="settings" aria-selected="${tab === 'settings'}">Settings</button></div>
  <div id="tab-documents" ${tab !== 'documents' ? 'hidden' : ''}>
    ${canManage ? `
    <div class="add-panel card">
      <div class="add-panel-head">
        <h3>Add data</h3>
        <div class="source-switch" role="tablist" aria-label="Add data source">
          <button class="source-opt" data-source="upload" role="tab" aria-selected="true"><span aria-hidden="true">📄</span> Upload files</button>
          <button class="source-opt" data-source="website" role="tab" aria-selected="false"><span aria-hidden="true">🌐</span> From website</button>
        </div>
      </div>
      <div id="src-upload">
        <div class="dropzone" id="dz" role="button" tabindex="0" aria-label="Upload documents"><strong>Drag & drop files here</strong> or <u>browse</u><br><span class="small muted">${ACCEPTED_EXTS.join(' · ')} · max ${MAX_FILE_MB} MB each · recursive text splitter</span><input type="file" id="fp" multiple hidden accept="${ACCEPTED_EXTS.join(',')}"></div>
        <div id="uploads" class="mt2"></div>
      </div>
      <div id="src-website" hidden>${DISCOVER_PANEL_HTML}</div>
    </div>` : `<div class="alert alert-info">You have read-only access. Only owners/admins can add data.</div>`}
    <div id="web-imports" class="mt2" hidden></div>
    <div id="docs" class="mt2">${skeletonList(2)}</div>
  </div>
  <div id="tab-settings" ${tab !== 'settings' ? 'hidden' : ''}><div class="card"><h3>KB Settings</h3><p class="small muted">ID <span class="mono">${escapeHtml(String(kb.id))}</span> · created ${escapeHtml(kb.created_at || '—')}</p></div></div>`;
page.querySelectorAll('[data-tab]').forEach(t => t.onclick = () => { tab = t.dataset.tab; page.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === t)); document.getElementById('tab-documents').hidden = tab !== 'documents'; document.getElementById('tab-settings').hidden = tab !== 'settings'; history.replaceState(null, '', `?id=${kbId}&tab=${tab}`); });
document.getElementById('kb-edit')?.addEventListener('click', () => {
  const { el, close } = openModal(`<div class="modal-head"><h3>Edit KB</h3><button class="icon-btn" data-close>✕</button></div><div class="modal-body"><div class="field"><label>Name</label><input id="kn" value="${escapeHtml(kb.name)}"></div><div class="field"><label>Description</label><textarea id="kd" rows="3">${escapeHtml(kb.description || '')}</textarea></div></div><div class="modal-foot"><button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="ksv">Save</button></div>`);
  el.querySelector('#ksv').onclick = async () => { try { await apiFetch(ENDPOINTS.kbDetail(orgId, kbId), { method: 'PATCH', body: { name: el.querySelector('#kn').value, description: el.querySelector('#kd').value } }); close(); toast('Saved', 'success'); location.reload(); } catch (e) { toast(e.message, 'error'); } };
});
const dz = document.getElementById('dz'), fp = document.getElementById('fp');
if (dz) {
  dz.onclick = () => fp.click();
  dz.onkeydown = (e) => { if (e.key === 'Enter') fp.click(); };
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => [...e.dataTransfer.files].filter(validFile).forEach(startUpload));
  fp.onchange = () => [...fp.files].filter(validFile).forEach(startUpload);
}
/* Upload files ⇄ Website URL switcher */
page.querySelectorAll('[data-source]').forEach(b => b.onclick = () => {
  const src = b.dataset.source;
  if (src === 'upload' && b.getAttribute('aria-selected') === 'true') return;
  page.querySelectorAll('[data-source]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  document.getElementById('src-upload').hidden = src !== 'upload';
  document.getElementById('src-website').hidden = src !== 'website';
  if (src === 'website' && !discovered.length && !discLoading) renderDiscoverIdle();
});
document.getElementById('root-url')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runDiscover(); } });
document.getElementById('discover-btn')?.addEventListener('click', runDiscover);
/* ================= Past webpage imports (revisit / remove) =================
 * Unconfirmed scrape sessions for this KB. Each can be reopened in the review
 * screen; nothing here has been added to the knowledge base.
 */
let wiList = [];
let wiTimer = null;
let wiLoading = false;
function stopWiPoll() { if (wiTimer) { clearTimeout(wiTimer); wiTimer = null; } }
function renderWebImports() {
  const w = document.getElementById('web-imports');
  if (!w) return;
  if (!wiList.length) { w.hidden = true; w.innerHTML = ''; stopWiPoll(); return; }
  w.hidden = false;
  const anyActive = wiList.some(s => !isSessionTerminal(s.status));
  w.innerHTML = `<div class="card wi-imports">
    <div class="wi-imports-head">
      <div><h3>Webpage imports</h3><p class="tiny muted">Drafts awaiting review — not added to this knowledge base yet.</p></div>
      <button class="btn btn-ghost btn-sm" id="wi-refresh">↻ Refresh</button>
    </div>
    <div class="wi-imports-list">
      ${wiList.map(s => {
        const prog = sessionProgress(s, []);
        const info = sessionStatusInfo(s.status);
        return `<div class="wi-import-row">
          <div class="wi-import-main">
            <div class="wi-import-top"><span class="badge ${info.badge}">${escapeHtml(info.label)}</span>
              <strong>${prog.total} page${prog.total === 1 ? '' : 's'}</strong></div>
            <div class="tiny muted">${escapeHtml(progressText(prog))}${prog.failed ? ` · ${prog.failed} failed` : ''} · created ${escapeHtml(timeAgo(s.created_at))}</div>
          </div>
          <div class="wi-import-actions">
            <a class="btn btn-secondary btn-sm" href="${webImportUrl(kbId, s.id)}">Review</a>
            ${canManage ? `<button class="btn btn-ghost btn-sm" data-remove-import="${escapeHtml(String(s.id))}">Remove</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
    ${anyActive ? `<p class="tiny muted mt1">⏳ Scraping in progress… this list updates automatically.</p>` : ''}
  </div>`;
  const rf = w.querySelector('#wi-refresh');
  if (rf) rf.onclick = () => loadWebImports(false);
  w.querySelectorAll('[data-remove-import]').forEach(b => b.onclick = () => removeWebImport(b.dataset.removeImport, b));
  stopWiPoll();
  if (anyActive) wiTimer = setTimeout(() => loadWebImports(true), POLL_MS);
}
async function loadWebImports(silent) {
  if (wiLoading) return;
  wiLoading = true;
  try {
    const res = await apiFetch(ENDPOINTS.webImports(orgId, kbId), { cacheTtl: 0 });
    wiList = normalizeImportList(res);
    renderWebImports();
  } catch (e) {
    if (!silent) toast(e.status === 403 ? 'Permission denied.' : e.message, 'error');
    else stopWiPoll();
  } finally { wiLoading = false; }
}
async function removeWebImport(id, btn) {
  const s = wiList.find(x => String(x.id) === String(id));
  const n = sessionProgress(s, []).total;
  if (!await confirmDialog({ title: 'Remove this import?', body: `The scraped drafts${n ? ` for ${n} page${n === 1 ? '' : 's'}` : ''} will be discarded. This does not affect documents already in the knowledge base.`, confirmText: 'Remove' })) return;
  if (btn) btn.disabled = true;
  try {
    await apiFetch(ENDPOINTS.webImportDetail(orgId, id), { method: 'DELETE' });
    wiList = wiList.filter(x => String(x.id) !== String(id));
    renderWebImports();
    toast('Import removed', 'success');
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.status === 403 ? 'Permission denied.' : (e.message || 'Could not remove the import.'), 'error');
  }
}
window.addEventListener('pagehide', stopWiPoll);
window.addEventListener('beforeunload', stopWiPoll);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopWiPoll(); else if (wiList.some(s => !isSessionTerminal(s.status))) loadWebImports(true); });
renderDiscoverIdle();
loadWebImports(true);
await loadDocs(true, kb);
