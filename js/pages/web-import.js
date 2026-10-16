import { initTheme } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext } from '../components/org-switcher.js';
import { apiFetch } from '../api.js';
import { ENDPOINTS, WEB_IMPORT_POLL_MS, WEB_IMPORT_MAX_FAILURES } from '../config.js';
import { toast, emptyState, skeletonList } from '../ui.js';
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
  w.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Review webpage content</h2>
        <p class="muted">Review the content extracted from your selected webpages before adding it to your knowledge base.</p>
      </div>
      <div class="wi-progress" role="group" aria-label="Scraping progress">
        <div class="wi-progress-top">
          <strong id="wi-progress-text">${escapeHtml(progressText(prog))}</strong>
          <span class="badge ${sInfo.badge}">${escapeHtml(sInfo.label)}</span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prog.percent}" aria-label="Pages scraped">
          <div style="width:${prog.percent}%"></div>
        </div>
        <div class="tiny muted mt1">These pages are drafts — nothing is added to the knowledge base yet.</div>
      </div>
    </div>
    <div id="wi-poll-warn"></div>`;
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
          ${wc}
        </span>
      </button>`;
  }).join('');
  w.querySelectorAll('.wi-row').forEach((b) => {
    b.onclick = () => { selectedId = b.dataset.pageId; renderList(); renderContent(); };
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
    if (p.content && p.content.trim()) {
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

  w.innerHTML = `<div class="card wi-content">${header}<div class="wi-content-body">${body}</div></div>`;
  const copy = w.querySelector('#wi-copy');
  if (copy) copy.onclick = async () => {
    if (await copyText(src)) toast('Source URL copied', 'success');
  };
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
  session = s;
  pages = p;
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
window.addEventListener('beforeunload', () => { mounted = false; stopPolling(); });

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
