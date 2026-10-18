import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  pageStatusInfo,
  isPageTerminal,
  isSessionTerminal,
  sessionStatusInfo,
  sessionProgress,
  progressText,
  normalizeSession,
  normalizePages,
  normalizeImportList,
  pageDisplayTitle,
  shortUrl,
  failedPageMessage,
  resolveSelectedId,
  mergePolledPages,
  confirmationSummary,
  requestWebImportConfirmation,
  ingestionStatusInfo,
  ingestionPageStatusInfo,
  ingestionCounts,
  approvedPagesForDisplay,
  normalizeIngestionPage,
  requestWebImportIngestion,
  shouldPollImport,
  isIngestionTerminal,
  classifySessionError,
  webImportUrl,
  startWebImport,
  renderMarkdown,
  createImportPoller,
} from '../js/pages/web-import-controller.js';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/* ---------- fake timer for deterministic polling ---------- */
function fakeTimer() {
  let seq = 0;
  const jobs = new Map();
  return {
    set(fn) { const id = ++seq; jobs.set(id, fn); return id; },
    clear(id) { jobs.delete(id); },
    async runNext() {
      const first = jobs.entries().next();
      if (first.done) return false;
      const [id, fn] = first.value;
      jobs.delete(id);
      await fn();
      return true;
    },
    pending() { return jobs.size; },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/* ==================== start import / navigation ==================== */

test('startWebImport trims + de-dupes selected URLs and returns the import id', async () => {
  let sent = null;
  const { importId, pages } = await startWebImport({
    urls: ['https://a.com', 'https://a.com', ' https://b.com ', '', null],
    createImport: async (list) => {
      sent = list;
      return { import_id: 'imp-1', status: 'processing', total_pages: 2, pages: [{ id: 'p1', url: list[0], status: 'pending' }] };
    },
  });
  assert.deepEqual(sent, ['https://a.com', 'https://b.com']);
  assert.equal(importId, 'imp-1');
  assert.equal(pages.length, 1);
});

test('startWebImport rejects an empty selection', async () => {
  await assert.rejects(
    () => startWebImport({ urls: [], createImport: async () => ({}) }),
    (e) => /at least one page/i.test(e.message),
  );
});

test('startWebImport fails loudly when the server omits an import id', async () => {
  await assert.rejects(
    () => startWebImport({ urls: ['https://a.com'], createImport: async () => ({ status: 'processing' }) }),
    (e) => /import id/i.test(e.message),
  );
});

test('webImportUrl carries kb + import ids so a refresh can restore the session', () => {
  const u = webImportUrl('kb-9', 'imp-2');
  assert.match(u, /^web-import\.html\?/);
  const q = new URLSearchParams(u.split('?')[1]);
  assert.equal(q.get('kb'), 'kb-9');
  assert.equal(q.get('import'), 'imp-2');
});

/* ==================== status + progress ==================== */

test('pageStatusInfo maps every backend page status to a labeled badge', () => {
  assert.deepEqual(pageStatusInfo('pending'), { key: 'pending', label: 'Pending', badge: 'b-pending' });
  assert.equal(pageStatusInfo('processing').key, 'processing');
  assert.equal(pageStatusInfo('processing').label, 'Scraping');
  assert.equal(pageStatusInfo('completed').label, 'Scraped');
  assert.equal(pageStatusInfo('completed').badge, 'b-completed');
  assert.equal(pageStatusInfo('failed').key, 'failed');
  assert.equal(pageStatusInfo('').label, 'Pending');
  // Documents parked awaiting confirmation count as completed but are labelled distinctly.
  assert.deepEqual(pageStatusInfo('ready_for_review'), { key: 'completed', label: 'Ready for review', badge: 'b-warning' });
  assert.equal(isPageTerminal('ready_for_review'), true);
});

test('terminal checks use the backend status values', () => {
  assert.equal(isPageTerminal('completed'), true);
  assert.equal(isPageTerminal('failed'), true);
  assert.equal(isPageTerminal('processing'), false);
  assert.equal(isPageTerminal('pending'), false);
  assert.equal(isSessionTerminal('ready_for_review'), true);
  assert.equal(isSessionTerminal('partially_failed'), true);
  assert.equal(isSessionTerminal('failed'), true);
  assert.equal(isSessionTerminal('processing'), false);
  assert.equal(isSessionTerminal('pending'), false);
});

test('sessionProgress reconciles page list with session counts', () => {
  const prog = sessionProgress(
    { total_pages: 4, completed_pages: 2, failed_pages: 1, pending_pages: 1, processing_pages: 0 },
    [
      { status: 'completed' }, { status: 'completed' },
      { status: 'failed' }, { status: 'pending' },
    ],
  );
  assert.equal(prog.total, 4);
  assert.equal(prog.completed, 2);
  assert.equal(prog.failed, 1);
  assert.equal(prog.pending, 1);
  assert.equal(prog.settled, 3);
  assert.equal(prog.done, false);
  assert.equal(prog.percent, 75);
  assert.equal(progressText(prog), '2 of 4 pages scraped');
});

test('sessionProgress falls back to session counts for an empty/partial import', () => {
  const empty = sessionProgress({ total_pages: 0, completed_pages: 0, failed_pages: 0 }, []);
  assert.equal(progressText(empty), '0 of 0 pages scraped');
  assert.equal(empty.done, false);

  const partial = sessionProgress(
    { total_pages: 3, completed_pages: 1, failed_pages: 2 },
    [],
  );
  assert.equal(partial.completed, 1);
  assert.equal(partial.failed, 2);
  assert.equal(partial.done, true);
});

test('sessionProgress reports done when every page is terminal', () => {
  const prog = sessionProgress({ total_pages: 2 }, [{ status: 'completed' }, { status: 'failed' }]);
  assert.equal(prog.done, true);
  assert.equal(prog.percent, 100);
});

test('sessionStatusInfo labels the overall session states', () => {
  assert.equal(sessionStatusInfo('ready_for_review').key, 'ready');
  assert.equal(sessionStatusInfo('partially_failed').key, 'partial');
  assert.equal(sessionStatusInfo('failed').key, 'failed');
  assert.equal(sessionStatusInfo('processing').key, 'processing');
});

/* ==================== normalizers ==================== */

test('normalizeSession tolerates missing/odd fields', () => {
  const s = normalizeSession({ import_id: 'i', status: 'processing', total_pages: '3' });
  assert.equal(s.importId, 'i');
  assert.equal(s.total_pages, 3);
  assert.equal(normalizeSession(null).status, 'pending');
});

test('normalizePages accepts an array or a wrapped {pages} payload', () => {
  const direct = normalizePages([{ id: 'a', url: 'u', status: 'completed', content: 'x' }]);
  assert.equal(direct[0].id, 'a');
  const wrapped = normalizePages({ import_id: 'i', pages: [{ page_id: 'b', original_url: 'u2', status: 'failed', error_message: 'nope' }] });
  assert.equal(wrapped[0].id, 'b');
  assert.equal(wrapped[0].url, 'u2');
  assert.equal(wrapped[0].error, 'nope');
  assert.deepEqual(normalizePages(null), []);
});

test('normalizeImportList reads the paginated results and keeps the session id', () => {
  const list = normalizeImportList({
    count: 1, next: null, previous: null,
    results: [{ import_id: 'imp-7', status: 'partially_failed', total_pages: 3, completed_pages: 2, failed_pages: 1, created_at: '2026-01-01T00:00:00Z' }],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'imp-7');
  assert.equal(list[0].importId, 'imp-7');
  assert.equal(list[0].status, 'partially_failed');
  assert.equal(list[0].total_pages, 3);
  assert.deepEqual(normalizeImportList(null), []);
});

test('pageDisplayTitle falls back title -> hostname -> segment', () => {
  assert.equal(pageDisplayTitle({ title: 'Docs', url: 'https://x.com/a' }), 'Docs');
  assert.equal(pageDisplayTitle({ url: 'https://www.example.com/a/b' }), 'example.com');
});

test('shortUrl drops the scheme and trims long paths', () => {
  assert.equal(shortUrl('https://example.com/docs/'), 'example.com/docs');
  assert.ok(shortUrl('https://example.com/' + 'a'.repeat(120)).length <= 72);
});

/* ==================== render states ==================== */

test('failedPageMessage only surfaces the safe backend error (never invents one)', () => {
  assert.equal(failedPageMessage({ error: 'The page could not be fetched (HTTP 404).' }), 'The page could not be fetched (HTTP 404).');
  assert.equal(failedPageMessage({ error: '   ' }), '');
  assert.equal(failedPageMessage({}), '');
});

test('resolveSelectedId keeps the current page and falls back to the first', () => {
  const pages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(resolveSelectedId(pages, 'b'), 'b');
  assert.equal(resolveSelectedId(pages, 'missing'), 'a');
  assert.equal(resolveSelectedId([], 'b'), null);
});

test('normalizePages restores persisted inclusion state and defaults older responses to included', () => {
  assert.equal(normalizePages([{ id: 'a', is_included: false }])[0].is_included, false);
  assert.equal(normalizePages([{ id: 'b' }])[0].is_included, true);
});

test('poll merging preserves editor text and pending inclusion changes', () => {
  const current = [{ id: 'a', status: 'completed', content: 'saved', is_included: true, title: 'Old' }];
  const polled = [{ id: 'a', status: 'completed', content: 'stale', is_included: true, title: 'New' }];
  const merged = mergePolledPages(polled, current, { editingId: 'a', editorText: 'unsaved', pendingInclusion: new Map([['a', false]]) });
  assert.equal(merged[0].content, 'unsaved');
  assert.equal(merged[0].is_included, false);
  assert.equal(merged[0].title, 'New');
});

test('poll merging uses server state when no local mutation is pending', () => {
  const merged = mergePolledPages([{ id: 'a', content: 'new', is_included: false }], [{ id: 'a', content: 'old', is_included: true }]);
  assert.equal(merged[0].content, 'new');
  assert.equal(merged[0].is_included, false);
});

test('confirmation summary counts scraped pages, missing content and scrape failures', () => {
  const pages = [
    { id: 'a', status: 'ready_for_review', content: '# A' },
    { id: 'b', status: 'failed', content: '' },
    { id: 'c', status: 'failed', content: '' },
  ];
  // Failed scrapes no longer block: every page is staged and confirm only needs
  // at least one page with content and nothing still scraping.
  assert.deepEqual(confirmationSummary({ status: 'partially_failed' }, pages), {
    total: 3, included: 3, excluded: 0, eligible: 1, attention: 0, scraping: false, confirmed: false, canConfirm: true,
  });

  const mixed = [
    { id: 'a', status: 'ready_for_review', content: '# A' },
    { id: 'b', status: 'ready_for_review', content: '   ' },
    { id: 'c', status: 'processing', content: '' },
  ];
  const sum = confirmationSummary({ status: 'processing' }, mixed);
  assert.equal(sum.eligible, 1);
  assert.equal(sum.attention, 1); // scraped but empty
  assert.equal(sum.scraping, true); // one page still processing
  assert.equal(sum.canConfirm, false);
});

test('confirmation is disabled for empty, no-content, scraping, unsaved and confirmed imports', () => {
  const ready = [{ status: 'ready_for_review', content: 'Saved markdown' }];
  assert.equal(confirmationSummary({ status: 'ready_for_review' }, []).canConfirm, false);
  assert.equal(confirmationSummary({ status: 'ready_for_review' }, [{ status: 'ready_for_review', content: '' }]).canConfirm, false);
  assert.equal(confirmationSummary({ status: 'processing' }, ready).canConfirm, false);
  assert.equal(confirmationSummary({ status: 'ready_for_review' }, ready, { unsaved: true }).canConfirm, false);
  assert.equal(confirmationSummary({ status: 'ready_for_review' }, ready, { confirming: true }).canConfirm, false);
  assert.equal(confirmationSummary({ status: 'confirmed' }, ready).canConfirm, false);
  assert.equal(confirmationSummary({ status: 'ready_for_review' }, ready).canConfirm, true);
});

test('confirmation API helper posts an empty body and requires backend confirmed status', async () => {
  let call;
  const result = await requestWebImportConfirmation(async (...args) => {
    call = args;
    return { status: 'confirmed', confirmed_at: '2026-10-16T12:00:00Z', page_count: 2, already_confirmed: false };
  }, '/confirm/');
  assert.deepEqual(call, ['/confirm/', { method: 'POST', body: {} }]);
  assert.deepEqual(result, { status: 'confirmed', confirmed_at: '2026-10-16T12:00:00Z', page_count: 2, already_confirmed: false });
  await assert.rejects(
    () => requestWebImportConfirmation(async () => ({ status: 'ready_for_review' }), '/confirm/'),
    (err) => /did not confirm/i.test(err.message),
  );
  await assert.rejects(
    () => requestWebImportConfirmation(async () => { throw { status: 0, message: 'network unavailable' }; }, '/confirm/'),
    (err) => err.status === 0 && err.message === 'network unavailable',
  );
});

test('confirmed session metadata restores a read-only confirmed state after reload', () => {
  const session = normalizeSession({ status: 'confirmed', included_pages: 4 });
  assert.equal(isSessionTerminal(session.status), true);
  assert.equal(sessionStatusInfo(session.status).label, 'Import confirmed');
  assert.equal(session.included_pages, 4);
  assert.equal(confirmationSummary(session, []).confirmed, true);
});

test('confirmation dialog offers cancel and describes snapshot-only approval', () => {
  const page = src('../js/pages/web-import.js');
  assert.match(page, /data-cancel/);
  assert.match(page, /records an approved snapshot/);
  assert.match(page, /later processing step/);
  assert.match(page, /if \(confirming\) return/);
  assert.match(page, /const readOnly = session.status === 'confirmed'/);
  assert.match(page, /Approved snapshot · read-only/);
  assert.match(page, /const controls = readOnly/);
  assert.match(page, /status: 'confirmed'/);
});

test('ingestion status labels match the Part 5A session and snapshot statuses', () => {
  assert.equal(ingestionStatusInfo('not_started').label, 'Confirmed, awaiting ingestion');
  assert.equal(ingestionStatusInfo('queued').label, 'Queued');
  assert.equal(ingestionStatusInfo('processing').label, 'Processing');
  assert.equal(ingestionStatusInfo('partially_failed').label, 'Completed with failures');
  assert.equal(ingestionStatusInfo('failed').label, 'Failed');
  assert.equal(ingestionStatusInfo('completed').label, 'Completed');
  assert.equal(ingestionPageStatusInfo('pending').label, 'Waiting');
  assert.equal(ingestionPageStatusInfo('ready').label, 'Indexed');
  assert.equal(ingestionPageStatusInfo('failed').label, 'Failed');
});

test('ingestion can start only for a confirmed import and polls only while active', () => {
  assert.equal(shouldPollImport({ status: 'confirmed', ingestion_status: 'queued' }), true);
  assert.equal(shouldPollImport({ status: 'confirmed', ingestion_status: 'processing' }), true);
  assert.equal(shouldPollImport({ status: 'confirmed', ingestion_status: 'not_started' }), false);
  assert.equal(shouldPollImport({ status: 'confirmed', ingestion_status: 'completed' }), false);
  assert.equal(shouldPollImport({ status: 'ready_for_review' }), false);
  assert.equal(isIngestionTerminal('completed'), true);
  assert.equal(isIngestionTerminal('partially_failed'), true);
  assert.equal(isIngestionTerminal('failed'), true);
  assert.equal(isIngestionTerminal('queued'), false);
});

test('approved page display uses immutable snapshot page statuses and only approved drafts', () => {
  const displayed = approvedPagesForDisplay([
    { id: 'd1', content: 'approved body', is_included: true },
    { id: 'd2', content: 'excluded body', is_included: false },
  ], [{ id: 's1', source_draft_id: 'd1', ingestion_status: 'ready', url: 'https://a.test' }]);
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].id, 'd1');
  assert.equal(displayed[0].snapshot_id, 's1');
  assert.equal(displayed[0].content, 'approved body');
  assert.equal(displayed[0].ingestion_status, 'ready');
});

test('approved page display keeps content when the snapshot keys pages by document id', () => {
  // Current backend: ingestion_pages carry the document id (no source_draft_id)
  // and expose the document `status` instead of `ingestion_status`.
  const displayed = approvedPagesForDisplay(
    [{ id: 'doc1', content: '# Confirmed body', word_count: 3, status: 'ready_for_review' }],
    [{ id: 'doc1', status: 'ready_for_review', url: 'https://a.test' }],
  );
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].content, '# Confirmed body');
  assert.equal(displayed[0].id, 'doc1');
});

test('normalizeIngestionPage maps a document status into the ingestion vocabulary', () => {
  assert.equal(normalizeIngestionPage({ id: 'doc1', status: 'ready_for_review' }).ingestion_status, 'pending');
  assert.equal(normalizeIngestionPage({ id: 'doc1', status: 'processing' }).ingestion_status, 'processing');
  assert.equal(normalizeIngestionPage({ id: 'doc1', status: 'ready' }).ingestion_status, 'ready');
  assert.equal(normalizeIngestionPage({ id: 'doc1', status: 'failed' }).ingestion_status, 'failed');
  // Reads error from either key.
  assert.equal(normalizeIngestionPage({ id: 'doc1', error: 'boom' }).ingestion_error, 'boom');
});


test('ingestion summary counts approved, indexed, failed, processing and waiting pages', () => {
  assert.deepEqual(ingestionCounts({
    approved_page_count: 3, indexed_pages: 1, ingestion_failed_pages: 1,
    ingestion_pages: [{ ingestion_status: 'processing' }, { ingestion_status: 'pending' }, { ingestion_status: 'ready' }],
  }), { approved: 3, indexed: 1, processing: 1, waiting: 1, failed: 1 });
});

test('ingestion API helper posts an empty body and uses returned backend status/counts', async () => {
  let call;
  const result = await requestWebImportIngestion(async (...args) => {
    call = args;
    return { import_id: 'imp-1', status: 'confirmed', ingestion_status: 'queued', approved_page_count: 3, indexed_pages: 0, failed_pages: 0, already_processing: false };
  }, '/ingest/');
  assert.deepEqual(call, ['/ingest/', { method: 'POST', body: {} }]);
  assert.deepEqual(result, { import_id: 'imp-1', status: 'confirmed', ingestion_status: 'queued', approved_page_count: 3, indexed_pages: 0, ingestion_failed_pages: 0, already_processing: false });
  await assert.rejects(
    () => requestWebImportIngestion(async () => { throw { status: 0, message: 'network unavailable' }; }, '/ingest/'),
    (err) => err.status === 0 && err.message === 'network unavailable',
  );
  await assert.rejects(
    () => requestWebImportIngestion(async () => ({ status: 'confirmed' }), '/ingest/'),
    (err) => /unrecognized ingestion status/i.test(err.message),
  );
});

test('session normalization restores Part 5A import and snapshot status contract', () => {
  const session = normalizeSession({
    status: 'confirmed', ingestion_status: 'processing', approved_page_count: 2,
    indexed_pages: 1, ingestion_failed_pages: 0,
    ingestion_started_at: '2026-10-16T12:00:00Z',
    ingestion_pages: [{ id: 's1', source_draft_id: 'd1', ingestion_status: 'ready', document_id: 'doc1' }],
  });
  assert.equal(session.ingestion_status, 'processing');
  assert.equal(session.approved_page_count, 2);
  assert.equal(session.indexed_pages, 1);
  assert.equal(session.ingestion_pages[0].source_draft_id, 'd1');
  assert.equal(session.ingestion_pages[0].document_id, 'doc1');
});

test('polling continues for confirmed queued imports and stops at ingestion terminal status', async () => {
  const timer = fakeTimer();
  const updates = [];
  const statuses = ['queued', 'processing', 'completed'];
  const poller = createImportPoller({
    fetchStatus: async () => ({ status: 'confirmed', ingestion_status: statuses.shift(), approved_page_count: 1 }),
    fetchPages: async () => ({ pages: [{ id: 'd1', status: 'completed', is_included: true }] }),
    onUpdate: value => updates.push(value),
    interval: 1000,
    timer,
  });
  poller.start({ immediate: true });
  await flush();
  assert.equal(poller.state.stopped, false);
  await timer.runNext();
  assert.equal(poller.state.stopped, false);
  await timer.runNext();
  assert.equal(poller.state.stopped, true);
  assert.equal(updates.length, 3);
});

test('classifySessionError distinguishes 404/403/401/network', () => {
  assert.equal(classifySessionError({ status: 404 }), 'not_found');
  assert.equal(classifySessionError({ status: 403 }), 'forbidden');
  assert.equal(classifySessionError({ status: 401 }), 'unauthorized');
  assert.equal(classifySessionError({ status: 0 }), 'network');
  assert.equal(classifySessionError({ status: 500 }), 'unknown');
});

/* ==================== markdown rendering ==================== */

test('renderMarkdown renders headings, lists, blockquotes, links, code, tables', () => {
  const md = [
    '# Title',
    '',
    'A **bold** and *em* paragraph with a [link](https://example.com).',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '| Plan | Price |',
    '| --- | --- |',
    '| Free | $0 |',
  ].join('\n');
  const html = renderMarkdown(md);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer nofollow">link<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<pre class="code-block"><code class="language-js">const x = 1;<\/code><\/pre>/);
  assert.match(html, /<table>.*<th>Plan<\/th>.*<td>Free<\/td>.*<\/table>/s);
});

test('renderMarkdown escapes raw HTML and refuses unsafe link schemes', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.ok(!/<img/i.test(html), 'raw html must not survive');
  assert.match(html, /&lt;img/);
  assert.ok(!/href="javascript:/i.test(html), 'javascript: links must not be rendered as anchors');
});

test('renderMarkdown always terminates on block-like lines that no handler consumes', () => {
  // A lone "|" line looks like a table but isn't one; the renderer must still
  // advance instead of spinning forever (which hung the review page).
  assert.equal(renderMarkdown('| foo | bar |'), '<p>| foo | bar |</p>');
  assert.equal(renderMarkdown('text\n| lone | pipe |\nmore'), '<p>text</p>\n<p>| lone | pipe |<br>more</p>');
  // A malformed fence (info string with spaces) must not stall either.
  assert.equal(renderMarkdown('```js extra\ntext'), '<p>```js extra<br>text</p>');
});

test('renderMarkdown applies an injected sanitizer as the final step', () => {
  const seen = [];
  renderMarkdown('# Hi', { sanitize: (h) => { seen.push(h); return `${h}<!--sanitized-->`; } });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /<h1>Hi<\/h1>/);
});

/* ==================== polling ==================== */

test('poller updates progress on each tick and stops at a terminal session status', async () => {
  const timer = fakeTimer();
  const updates = [];
  const sessions = [
    { status: 'processing', total_pages: 2 },
    { status: 'ready_for_review', total_pages: 2, completed_pages: 2 },
  ];
  const pageSets = [
    [{ id: 'a', status: 'completed' }, { id: 'b', status: 'processing' }],
    [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }],
  ];
  let s = 0, p = 0;
  const poller = createImportPoller({
    fetchStatus: async () => sessions[s++],
    fetchPages: async () => ({ pages: pageSets[p++] }),
    onUpdate: (d) => updates.push(d),
    interval: 1000,
    timer,
  });
  poller.start();
  assert.equal(timer.pending(), 1);
  await timer.runNext();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].session.status, 'processing');
  assert.equal(updates[0].pages[1].status, 'processing');
  assert.equal(timer.pending(), 1); // still polling — not terminal yet
  await timer.runNext();
  assert.equal(updates.length, 2);
  assert.equal(updates[1].session.status, 'ready_for_review');
  assert.equal(poller.state.terminal, true);
  assert.equal(timer.pending(), 0); // terminal → no further ticks
});

test('poller stops when every page individually reaches a terminal state', async () => {
  const timer = fakeTimer();
  const poller = createImportPoller({
    fetchStatus: async () => ({ status: 'processing', total_pages: 1 }),
    fetchPages: async () => ({ pages: [{ id: 'a', status: 'failed' }] }),
    onUpdate: () => {},
    interval: 1000,
    timer,
  });
  poller.start();
  await timer.runNext();
  assert.equal(poller.state.terminal, true);
  assert.equal(timer.pending(), 0);
});

test('stop() cleans up polling (navigation away) and no further ticks fire', async () => {
  const timer = fakeTimer();
  const poller = createImportPoller({
    fetchStatus: async () => ({ status: 'processing' }),
    fetchPages: async () => ({ pages: [{ id: 'a', status: 'processing' }] }),
    onUpdate: () => {},
    interval: 1000,
    timer,
  });
  poller.start();
  await timer.runNext();
  poller.stop();
  assert.equal(timer.pending(), 0);
  assert.equal(await timer.runNext(), false);
  assert.equal(poller.state.stopped, true);
});

test('poller retries temporary failures then recovers without spamming fatal errors', async () => {
  const timer = fakeTimer();
  const errors = [];
  const updates = [];
  let calls = 0;
  const poller = createImportPoller({
    fetchStatus: async () => {
      calls++;
      if (calls < 3) throw { status: 0, message: 'network' };
      return { status: 'ready_for_review', total_pages: 1 };
    },
    fetchPages: async () => ({ pages: [{ id: 'a', status: 'completed' }] }),
    onUpdate: (d) => updates.push(d),
    onError: (e, info) => errors.push(info),
    interval: 1000,
    maxConsecutiveFailures: 3,
    timer,
  });
  poller.start();
  await timer.runNext(); // fail 1
  await timer.runNext(); // fail 2
  assert.equal(errors.length, 2);
  assert.equal(errors.every((e) => !e.fatal), true);
  await timer.runNext(); // success → terminal
  assert.equal(updates.length, 1);
  assert.equal(poller.state.failures, 0);
  assert.equal(timer.pending(), 0);
});

test('poller gives up after maxConsecutiveFailures with a single fatal signal', async () => {
  const timer = fakeTimer();
  const errors = [];
  const poller = createImportPoller({
    fetchStatus: async () => { throw { status: 0, message: 'down' }; },
    fetchPages: async () => ({ pages: [] }),
    onUpdate: () => {},
    onError: (e, info) => errors.push(info),
    interval: 1000,
    maxConsecutiveFailures: 2,
    timer,
  });
  poller.start();
  await timer.runNext();
  await timer.runNext();
  assert.equal(errors.length, 2);
  assert.equal(errors[1].fatal, true);
  assert.equal(poller.state.stopped, true);
  assert.equal(timer.pending(), 0);
});

test('poller drops an in-flight result when stopped mid-request', async () => {
  const timer = fakeTimer();
  const updates = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const poller = createImportPoller({
    fetchStatus: () => gate,
    fetchPages: () => gate,
    onUpdate: (d) => updates.push(d),
    interval: 1000,
    timer,
  });
  poller.start({ immediate: true });
  poller.stop(); // unmount while the request is pending
  release({ status: 'processing' });
  await flush();
  assert.equal(updates.length, 0);
});

/* ==================== scope guards ==================== */

test('the review page never scrapes client-side or calls Jina', () => {
  const page = src('../js/pages/web-import.js').toLowerCase();
  assert.ok(!page.includes('jina'), 'must not reference Jina');
  assert.ok(!page.includes('r.jina.ai'), 'must not call Jina Reader');
  assert.ok(!/fetch\s*\(\s*['"`]https?:/.test(page), 'must not fetch arbitrary external URLs');
});

test('the review page only uses the explicit import-ingestion endpoint and never calls embeddings directly', () => {
  const page = src('../js/pages/web-import.js').toLowerCase();
  for (const bad of ['embedding', 'embed(', 'qdrant', 'documentretry']) {
    assert.ok(!page.includes(bad), `must not reference ${bad}`);
  }
  assert.match(page, /endpoints\.webimportingest/);
  assert.match(page, /if \(ingestionstarting\) \{ close\(\); return; \}/);
  assert.match(page, /session\.status === 'confirmed'/);
});

test('the review page edits/deletes via document endpoints, not the removed page route', () => {
  const page = src('../js/pages/web-import.js').toLowerCase();
  const cfg = src('../js/config.js').toLowerCase();
  assert.match(page, /endpoints\.documentcontent/);
  assert.match(page, /endpoints\.documentdetail/);
  assert.ok(!page.includes('webimportpage('), 'must not call the removed page PATCH/DELETE route');
  assert.ok(!cfg.includes('webimportpage:'), 'the removed page route must not be exposed');
});

