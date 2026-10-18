/**
 * Pure, DOM-free logic for the webpage review screen.
 *
 * Everything here is framework-agnostic and dependency-injected so it can be
 * unit-tested in Node without a browser: response normalizers, status/progress
 * mapping, a small safe Markdown renderer, the polling loop, and the "start an
 * import" call. The page module (web-import.js) only wires this to the DOM.
 *
 * Security: extracted HTML is NEVER trusted. Markdown is escaped first, then a
 * conservative subset of markdown syntax is expanded, then (in the browser) the
 * result is passed through DOMPurify. The backend is the source of truth for
 * draft content — no scraping happens here.
 */
import { escapeHtml } from '../utils.js';

const FILE_ICON = '📄';

/* ==================== status + progress ==================== */

const PENDING = ['pending', 'queued', 'waiting', 'created'];
const PROCESSING = ['processing', 'scraping', 'running', 'in_progress', 'in-progress'];
const COMPLETED = ['completed', 'complete', 'done', 'ready', 'success', 'succeeded', 'scraped'];
const FAILED = ['failed', 'error', 'errored'];

/** Map a raw page status to a stable {key,label,badge} used by the UI. */
export function pageStatusInfo(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (PROCESSING.includes(v)) return { key: 'processing', label: 'Scraping', badge: 'b-processing' };
  if (COMPLETED.includes(v)) return { key: 'completed', label: 'Scraped', badge: 'b-completed' };
  if (FAILED.includes(v)) return { key: 'failed', label: 'Failed', badge: 'b-failed' };
  if (PENDING.includes(v)) return { key: 'pending', label: 'Pending', badge: 'b-pending' };
  return { key: 'pending', label: raw ? String(raw) : 'Pending', badge: 'b-pending' };
}

export function isPageTerminal(raw) {
  return pageStatusInfo(raw).key === 'completed' || pageStatusInfo(raw).key === 'failed';
}

export function isSessionTerminal(raw) {
  return ['ready_for_review', 'partially_failed', 'failed', 'confirmed'].includes(String(raw ?? '').toLowerCase());
}

/** Human label for an overall session status. */
export function sessionStatusInfo(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'ready_for_review') return { key: 'ready', label: 'Ready for review', badge: 'b-completed' };
  if (v === 'partially_failed') return { key: 'partial', label: 'Partially failed', badge: 'b-warning' };
  if (v === 'failed') return { key: 'failed', label: 'Failed', badge: 'b-failed' };
  if (v === 'confirmed') return { key: 'confirmed', label: 'Import confirmed', badge: 'b-completed' };
  if (v === 'processing') return { key: 'processing', label: 'Scraping…', badge: 'b-processing' };
  if (v === 'pending') return { key: 'pending', label: 'Starting…', badge: 'b-pending' };
  return { key: 'unknown', label: raw ? String(raw) : 'Unknown', badge: 'b-pending' };
}

const INGESTION_ACTIVE = ['queued', 'processing'];
const INGESTION_TERMINAL = ['partially_failed', 'failed', 'completed'];

export function ingestionStatusInfo(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'not_started') return { key: v, label: 'Confirmed, awaiting ingestion', badge: 'b-pending' };
  if (v === 'queued') return { key: v, label: 'Queued', badge: 'b-pending' };
  if (v === 'processing') return { key: v, label: 'Processing', badge: 'b-processing' };
  if (v === 'completed') return { key: v, label: 'Completed', badge: 'b-completed' };
  if (v === 'partially_failed') return { key: v, label: 'Completed with failures', badge: 'b-warning' };
  if (v === 'failed') return { key: v, label: 'Failed', badge: 'b-failed' };
  return { key: 'unknown', label: raw ? String(raw) : 'Status unavailable', badge: 'b-pending' };
}

export function isIngestionActive(raw) { return INGESTION_ACTIVE.includes(String(raw ?? '').toLowerCase()); }
export function isIngestionTerminal(raw) { return INGESTION_TERMINAL.includes(String(raw ?? '').toLowerCase()); }
export function shouldPollImport(session = {}) {
  if (String(session.status || '').toLowerCase() === 'confirmed') return isIngestionActive(session.ingestion_status);
  return !isSessionTerminal(session.status);
}

export function ingestionPageStatusInfo(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'pending') return { key: v, label: 'Waiting', badge: 'b-pending' };
  if (v === 'processing') return { key: v, label: 'Processing', badge: 'b-processing' };
  if (v === 'ready') return { key: v, label: 'Indexed', badge: 'b-completed' };
  if (v === 'failed') return { key: v, label: 'Failed', badge: 'b-failed' };
  return { key: 'unknown', label: raw ? String(raw) : 'Status unavailable', badge: 'b-pending' };
}

/**
 * Reconcile the aggregate counts from the status endpoint with the fetched
 * page list. The page list wins for states when available, because it is the
 * same data the UI renders; the session counts are the fallback.
 */
export function sessionProgress(session = {}, pages = []) {
  const list = Array.isArray(pages) ? pages : [];
  let completed = 0, failed = 0, processing = 0, pending = 0;
  for (const p of list) {
    const k = pageStatusInfo(p?.status).key;
    if (k === 'completed') completed++;
    else if (k === 'failed') failed++;
    else if (k === 'processing') processing++;
    else pending++;
  }
  const total = list.length || Number(session?.total_pages) || 0;
  if (!list.length) {
    completed = Number(session?.completed_pages) || 0;
    failed = Number(session?.failed_pages) || 0;
    processing = Number(session?.processing_pages) || 0;
    pending = Number(session?.pending_pages) || 0;
  }
  const settled = completed + failed;
  const done = total > 0 && settled >= total;
  return { total, completed, failed, processing, pending, settled, done, percent: total ? Math.round((settled / total) * 100) : 0 };
}

/** `5 of 8 pages scraped` (word "page(s)" included). */
export function progressText(progress) {
  const { completed, total } = progress;
  return `${completed} of ${total} page${total === 1 ? '' : 's'} scraped`;
}

/* ==================== response normalizers ==================== */

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.pages)) return data.pages;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/** Normalize the create/detail session payload; never throws on odd shapes. */
export function normalizeSession(res) {
  const r = res && typeof res === 'object' ? res : {};
  return {
    importId: r.import_id || r.id || null,
    status: r.status || 'pending',
    total_pages: Number(r.total_pages) || 0,
    pending_pages: Number(r.pending_pages) || 0,
    processing_pages: Number(r.processing_pages) || 0,
    completed_pages: Number(r.completed_pages) || 0,
    failed_pages: Number(r.failed_pages) || 0,
    included_pages: Number(r.included_pages) || 0,
    confirmed_at: r.confirmed_at || null,
    page_count: Number(r.page_count) || 0,
    already_confirmed: Boolean(r.already_confirmed),
    ingestion_status: r.ingestion_status || 'not_started',
    approved_page_count: Number(r.approved_page_count ?? r.confirmed_page_count ?? r.page_count) || 0,
    indexed_pages: Number(r.indexed_pages) || 0,
    ingestion_failed_pages: Number(r.ingestion_failed_pages ?? r.failed_pages) || 0,
    ingestion_started_at: r.ingestion_started_at || null,
    ingestion_completed_at: r.ingestion_completed_at || null,
    ingestion_pages: Array.isArray(r.ingestion_pages) ? r.ingestion_pages.map(normalizeIngestionPage) : null,
    created_at: r.created_at || null,
    updated_at: r.updated_at || null,
  };
}

export function normalizeIngestionPage(p) {
  const r = p && typeof p === 'object' ? p : {};
  return {
    id: r.id || null,
    source_draft_id: r.source_draft_id || null,
    url: r.url || '',
    final_url: r.final_url || '',
    title: r.title || '',
    ingestion_status: r.ingestion_status || 'pending',
    ingestion_error: typeof r.ingestion_error === 'string' ? r.ingestion_error : '',
    ingestion_started_at: r.ingestion_started_at || null,
    ingested_at: r.ingested_at || null,
    document_id: r.document_id || null,
  };
}

export function approvedPagesForDisplay(drafts = [], snapshotPages = null) {
  const source = Array.isArray(drafts) ? drafts : [];
  if (!Array.isArray(snapshotPages)) return source.filter(p => p.is_included);
  const byDraftId = new Map(source.map(p => [String(p.id), p]));
  return snapshotPages.map((snapshot) => {
    const draft = byDraftId.get(String(snapshot.source_draft_id));
    return {
      ...(draft || {}),
      id: draft?.id || snapshot.source_draft_id || snapshot.id,
      snapshot_id: snapshot.id,
      source_draft_id: snapshot.source_draft_id,
      url: snapshot.url || draft?.url || '',
      final_url: snapshot.final_url || draft?.final_url || '',
      title: snapshot.title || draft?.title || '',
      is_included: true,
      ingestion_status: snapshot.ingestion_status,
      ingestion_error: snapshot.ingestion_error,
      ingestion_started_at: snapshot.ingestion_started_at,
      ingested_at: snapshot.ingested_at,
      document_id: snapshot.document_id,
    };
  });
}

export function ingestionCounts(session = {}) {
  const pages = Array.isArray(session.ingestion_pages) ? session.ingestion_pages : [];
  const approved = Number(session.approved_page_count ?? session.confirmed_page_count) || pages.length || 0;
  const indexed = Number(session.indexed_pages) || 0;
  const failed = Number(session.ingestion_failed_pages) || 0;
  const processing = pages.filter(p => p.ingestion_status === 'processing').length;
  const waiting = pages.filter(p => p.ingestion_status === 'pending').length;
  return { approved, indexed, processing, waiting, failed };
}

/** Queue or requeue the backend's existing snapshot ingestion workflow. */
export async function requestWebImportIngestion(request, endpoint) {
  const response = await request(endpoint, { method: 'POST', body: {} });
  const validStatuses = ['not_started', 'queued', 'processing', 'partially_failed', 'failed', 'completed'];
  if (!response || !validStatuses.includes(String(response.ingestion_status || ''))) {
    throw { status: 0, message: 'The server returned an unrecognized ingestion status.' };
  }
  return {
    import_id: response.import_id || null,
    status: response.status || null,
    ingestion_status: response.ingestion_status,
    approved_page_count: Number(response.approved_page_count) || 0,
    indexed_pages: Number(response.indexed_pages) || 0,
    ingestion_failed_pages: Number(response.failed_pages) || 0,
    already_processing: Boolean(response.already_processing),
  };
}

/** Counts and eligibility for the Part 4 confirmation action. */
export function confirmationSummary(session = {}, pages = [], { unsaved = false, confirming = false } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const included = list.filter(p => p?.is_included);
  const excluded = list.length - included.length;
  const attention = included.filter(p => pageStatusInfo(p?.status).key !== 'completed' || !String(p?.content || '').trim()).length;
  const eligible = included.length - attention;
  const scraping = ['pending', 'processing'].includes(String(session?.status || '').toLowerCase()) ||
    list.some(p => ['pending', 'processing'].includes(pageStatusInfo(p?.status).key));
  const confirmed = String(session?.status || '').toLowerCase() === 'confirmed';
  const canConfirm = !confirmed && !scraping && eligible > 0 && attention === 0 && !unsaved && !confirming;
  return { total: list.length, included: included.length, excluded, eligible, attention, scraping, confirmed, canConfirm };
}

/** Send the Part 4A confirmation request and accept only its confirmed response. */
export async function requestWebImportConfirmation(request, endpoint) {
  const response = await request(endpoint, { method: 'POST', body: {} });
  if (response?.status !== 'confirmed') {
    throw { status: 0, message: 'The server did not confirm the import.' };
  }
  return {
    status: response.status,
    confirmed_at: response.confirmed_at || null,
    page_count: Number(response.page_count) || 0,
    already_confirmed: Boolean(response.already_confirmed),
  };
}

/** Normalize a page draft, tolerating alternate backend key names. */
export function normalizePage(p) {
  const r = p && typeof p === 'object' ? p : {};
  return {
    id: r.id || r.page_id || r.pk || r.uuid || null,
    url: r.url || r.original_url || r.source_url || '',
    final_url: r.final_url || r.resolved_url || '',
    title: r.title || r.name || '',
    status: r.status || 'pending',
    content: typeof r.content === 'string' ? r.content : (typeof r.markdown === 'string' ? r.markdown : ''),
    content_format: r.content_format || r.format || 'markdown',
    word_count: Number(r.word_count) || 0,
    is_included: r.is_included !== false,
    error: r.error || r.error_message || '',
    scraped_at: r.scraped_at || null,
  };
}

export function normalizePages(res) {
  return asArray(res).map(normalizePage);
}

/** Normalize the KB's import-session list (paginated or array). */
export function normalizeImportList(res) {
  let arr = [];
  if (Array.isArray(res)) arr = res;
  else if (res && Array.isArray(res.results)) arr = res.results;
  else if (res && Array.isArray(res.data)) arr = res.data;
  return arr.map((r) => {
    const s = normalizeSession(r);
    return { ...s, id: s.importId };
  });
}

/* ==================== display helpers ==================== */

export function hostnameOf(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Title falling back to hostname, then last path segment, then the URL. */
export function pageDisplayTitle(page = {}) {
  if (page.title) return page.title;
  const host = hostnameOf(page.url);
  if (host) return host;
  try {
    const seg = new URL(page.url).pathname.split('/').filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
  } catch { /* ignore */ }
  return page.url || 'Untitled page';
}

/** Short, readable URL for the list (drops the scheme, trims long paths). */
export function shortUrl(url = '', max = 72) {
  let s = String(url).replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

/** Safe, non-invented error text for a failed page. */
export function failedPageMessage(page = {}) {
  const msg = typeof page.error === 'string' ? page.error.trim() : '';
  return msg || '';
}

/** The page currently selected, or the first available page, or null. */
export function resolveSelectedId(pages = [], currentId = null) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return null;
  if (currentId != null && list.some(p => String(p.id) === String(currentId))) return currentId;
  return list[0].id;
}

/** Merge a poll response without replacing an active local editor or pending inclusion update. */
export function mergePolledPages(nextPages, currentPages, { editingId = null, editorText = '', pendingInclusion = new Map() } = {}) {
  const current = new Map((currentPages || []).map(p => [String(p.id), p]));
  return (nextPages || []).map(p => {
    const old = current.get(String(p.id));
    if (!old) return p;
    const merged = { ...old, ...p };
    if (String(p.id) === String(editingId)) merged.content = editorText;
    if (pendingInclusion.has(String(p.id))) merged.is_included = pendingInclusion.get(String(p.id));
    return merged;
  });
}

/** Classify an API error for the invalid/unauthorized session states. */
export function classifySessionError(err) {
  const status = err && typeof err === 'object' ? err.status : 0;
  if (status === 404) return 'not_found';
  if (status === 403) return 'forbidden';
  if (status === 401) return 'unauthorized';
  if (status === 0) return 'network';
  return 'unknown';
}

/** Build the review-screen route from ids (stable across refresh). */
export function webImportUrl(kbId, importId) {
  const p = new URLSearchParams();
  if (kbId) p.set('kb', String(kbId));
  if (importId) p.set('import', String(importId));
  return `web-import.html?${p.toString()}`;
}

/* ==================== start import ==================== */

/**
 * Start an import session from the selected URLs. `createImport(urls)` must
 * resolve to the backend create response. Returns {importId, session, pages}.
 * Throws an {status,message}-shaped error the UI can toast.
 */
export async function startWebImport({ createImport, urls }) {
  const list = [...new Set(
    (Array.isArray(urls) ? urls : [])
      .filter(u => typeof u === 'string' && u.trim())
      .map(u => u.trim()),
  )];
  if (!list.length) throw { status: 0, message: 'Select at least one page to import.' };
  const res = await createImport(list);
  const importId = (res && (res.import_id || res.id)) || null;
  if (!importId) throw { status: 0, message: 'The server did not return an import id.' };
  return { importId, session: normalizeSession(res), pages: normalizePages(res) };
}

/* ==================== markdown ==================== */

/**
 * Escape-then-expand markdown. Input HTML is escaped first so raw HTML from a
 * scraped page can never execute; then a conservative subset of markdown is
 * expanded. `sanitize` (default: DOMPurify when present) runs last as defense
 * in depth.
 */
export function renderMarkdown(md, { sanitize } = {}) {
  const src = typeof md === 'string' ? md : String(md ?? '');
  const escaped = escapeHtml(src);
  const html = mdToHtml(escaped);
  const fn = sanitize || defaultSanitize();
  return typeof fn === 'function' ? fn(html) : html;
}

function defaultSanitize() {
  const dp = globalThis.DOMPurify;
  return dp && typeof dp.sanitize === 'function' ? (h) => dp.sanitize(h) : null;
}

const SAFE_HREF = /^https?:\/\/[^\s)]+$/i;

/** Inline formatting on already-escaped text. Code spans are protected first. */
function inline(s) {
  const codes = [];
  let out = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
    const raw = href.replace(/&amp;/g, '&');
    if (!SAFE_HREF.test(raw)) return m;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
}

/** Block-level markdown -> HTML, on already-escaped text. */
function mdToHtml(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlank = (l) => /^\s*$/.test(l);
  const startsBlock = (l) =>
    /^\s*```/.test(l) || /^\s{0,3}#{1,6}\s+/.test(l) || /^\s*(?:&gt;|>)/.test(l) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
    /\|/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // closing fence (or EOF)
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre class="code-block"><code${cls}>${body.join('\n')}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // Heading
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*(?:&gt;|>)/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*(?:&gt;|>)/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*(?:&gt;|>)\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // Table (header row + separator row)
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        `<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }

    // Lists (ordered / unordered, single level)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ol || ul) {
      const ordered = !!ol;
      const items = [];
      while (i < lines.length) {
        const m = ordered ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/) : lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    if (isBlank(line)) { i++; continue; }

    // Paragraph: consecutive plain lines
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join('<br>'))}</p>`);
  }
  return out.join('\n');
}

/* ==================== polling ==================== */

/**
 * Poll an import session while scraping or confirmed-snapshot ingestion is active.
 *
 * All timing + IO is injected so it is deterministic in tests and uses the
 * project's existing setTimeout/clearTimeout in the browser.
 *
 * @param {object} opts
 * @param {() => Promise<any>} opts.fetchStatus  session status request
 * @param {() => Promise<any>} opts.fetchPages   persisted pages request
 * @param {(data:{session:object,pages:object[]}) => void} opts.onUpdate
 * @param {(err:any, info:{failures:number,fatal?:boolean}) => void} [opts.onError]
 * @param {number} [opts.interval]
 * @param {number} [opts.maxConsecutiveFailures]
 * @param {{set:Function, clear:Function}} [opts.timer]
 */
export function createImportPoller({
  fetchStatus,
  fetchPages,
  onUpdate,
  onError = () => {},
  interval = 4000,
  maxConsecutiveFailures = 3,
  timer = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (id) => clearTimeout(id),
  },
} = {}) {
  let timerId = null;
  let stopped = true;
  let busy = false;
  let failures = 0;
  let terminal = false;

  function schedule() {
    if (stopped || terminal || timerId != null) return;
    timerId = timer.set(tick, interval);
  }

  async function tick() {
    timerId = null;
    if (stopped) return;
    if (busy) { schedule(); return; }
    busy = true;
    try {
      const [statusRes, pagesRes] = await Promise.all([fetchStatus(), fetchPages()]);
      busy = false;
      if (stopped) return; // unmounted while in flight — drop the result
      failures = 0;
      const session = normalizeSession(statusRes);
      const pages = normalizePages(pagesRes);
      onUpdate({ session, pages });
      const sessionDone = !shouldPollImport(session);
      const pagesDone = session.status !== 'confirmed' && pages.length > 0 && pages.every(p => isPageTerminal(p.status));
      if (sessionDone || pagesDone) { terminal = true; stopInternal(); return; }
    } catch (err) {
      busy = false;
      if (stopped) return;
      failures += 1;
      if (failures >= maxConsecutiveFailures) {
        onError(err, { failures, fatal: true });
        stopInternal();
        return;
      }
      onError(err, { failures });
    }
    schedule();
  }

  function stopInternal() {
    stopped = true;
    if (timerId != null) { timer.clear(timerId); timerId = null; }
  }

  return {
    /** Begin polling. `immediate` fires the first tick right away. */
    start({ immediate = false } = {}) {
      stopped = false; terminal = false; failures = 0;
      if (immediate) tick(); else schedule();
    },
    /** Fetch now (e.g. a manual refresh), without waiting for the interval. */
    refreshNow() {
      stopped = false;
      if (timerId != null) { timer.clear(timerId); timerId = null; }
      tick();
    },
    stop: stopInternal,
    get state() { return { stopped, busy, failures, terminal }; },
  };
}
