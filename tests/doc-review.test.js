import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  docStatusInfo,
  isDocPollTerminal,
  normalizeDocContent,
  requestDocContent,
  saveDocContent,
  confirmDoc,
  ingestDoc,
  confirmAndStartEmbedding,
  isRetryBlockedForReview,
  REVIEW_STATUS,
} from '../js/pages/doc-review-controller.js';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/* ==================== status mapping ==================== */

test('ready_for_review maps to a review badge and stops polling', () => {
  const info = docStatusInfo('ready_for_review');
  assert.equal(info.key, 'review');
  assert.equal(info.badge, 'b-warning');
  assert.ok(isDocPollTerminal('ready_for_review'));
});

test('poll terminal covers review + ready + failed but not in-flight states', () => {
  for (const s of ['ready_for_review', 'ready', 'completed', 'failed', 'error']) {
    assert.equal(isDocPollTerminal(s), true, s);
  }
  for (const s of ['pending', 'processing', 'queued', 'running', '', null, undefined]) {
    assert.equal(isDocPollTerminal(s), false, String(s));
  }
});

test('REVIEW_STATUS is the wire value the backend uses', () => {
  assert.equal(REVIEW_STATUS, 'ready_for_review');
  assert.equal(docStatusInfo(REVIEW_STATUS).key, 'review');
});

/* ==================== content normalization ==================== */

test('normalizeDocContent accepts the documented payload', () => {
  const n = normalizeDocContent({ content: '# Hi', original_content: '# Hi\n\nbody', word_count: 12, editable: true, error: '' });
  assert.equal(n.content, '# Hi');
  assert.equal(n.original_content, '# Hi\n\nbody');
  assert.equal(n.word_count, 12);
  assert.equal(n.editable, true);
  assert.equal(n.error, '');
});

test('normalizeDocContent never throws on odd shapes and defaults editable=true', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const n = normalizeDocContent(bad);
    assert.equal(n.content, '');
    assert.equal(n.word_count, 0);
    assert.equal(n.editable, true);
    assert.equal(n.error, '');
  }
  assert.equal(normalizeDocContent({ content: 'a', original_content: 9 }).original_content, 'a');
  assert.equal(normalizeDocContent({ editable: false }).editable, false);
  assert.equal(normalizeDocContent({ error: 'extraction failed' }).error, 'extraction failed');
});

/* ==================== request wrappers ==================== */

test('requestDocContent fetches fresh (no cache) and normalizes', async () => {
  const calls = [];
  const res = await requestDocContent(async (path, opts) => { calls.push([path, opts]); return { content: 'hello world', word_count: 2 }; }, '/doc/content/');
  assert.deepEqual(calls, [['/doc/content/', { cacheTtl: 0 }]]);
  assert.equal(res.content, 'hello world');
  assert.equal(res.word_count, 2);
});

test('saveDocContent PATCHes only {content} and normalizes the 200', async () => {
  let sent = null;
  const res = await saveDocContent(async (path, opts) => { sent = { path, opts }; return { content: 'edited', word_count: 1, editable: true }; }, '/doc/content/', 'edited');
  assert.equal(sent.path, '/doc/content/');
  assert.equal(sent.opts.method, 'PATCH');
  assert.deepEqual(sent.opts.body, { content: 'edited' }); // only content is accepted
  assert.equal(res.content, 'edited');
});

test('saveDocContent propagates 400 (blank/oversized) and 409 (already confirmed)', async () => {
  const reject = (err) => async () => { throw err; };
  await assert.rejects(
    () => saveDocContent(reject({ status: 400, message: 'This field may not be blank.' }), '/doc/content/', ''),
    (e) => e.status === 400,
  );
  await assert.rejects(
    () => saveDocContent(reject({ status: 409, message: 'Already confirmed.' }), '/doc/content/', 'x'),
    (e) => e.status === 409,
  );
});

test('confirmDoc returns confirmed_at, word_count, already_confirmed', async () => {
  const conf = await confirmDoc(async () => ({ confirmed_at: '2026-01-01T00:00:00Z', word_count: 33, already_confirmed: true }), '/doc/confirm/');
  assert.deepEqual(conf, { confirmed_at: '2026-01-01T00:00:00Z', word_count: 33, already_confirmed: true });
});

test('ingestDoc normalizes the 202 (and tolerates empty bodies)', async () => {
  const q = await ingestDoc(async () => ({ status: 'processing', chunk_count: 5, already_processing: false }), '/doc/ingest/');
  assert.deepEqual(q, { status: 'processing', chunk_count: 5, already_processing: false });
  const empty = await ingestDoc(async () => null, '/doc/ingest/');
  assert.equal(empty.status, 'pending');
  assert.equal(empty.chunk_count, null);
  assert.equal(empty.already_processing, false);
});

test('confirmAndStartEmbedding runs confirm before ingest, like web import', async () => {
  const order = [];
  const { confirmation, queued } = await confirmAndStartEmbedding({
    confirm: async () => { order.push('confirm'); return { confirmed_at: 't', word_count: 10, already_confirmed: false }; },
    ingest: async () => { order.push('ingest'); return { status: 'processing', chunk_count: 2, already_processing: false }; },
  });
  assert.deepEqual(order, ['confirm', 'ingest']);
  assert.equal(confirmation.confirmed_at, 't');
  assert.equal(queued.status, 'processing');
});

test('confirmAndStartEmbedding does not ingest when confirm fails (409 not confirmed path stays safe)', async () => {
  let ingested = false;
  await assert.rejects(
    () => confirmAndStartEmbedding({
      confirm: async () => { throw { status: 409, message: 'Already confirmed.' }; },
      ingest: async () => { ingested = true; },
    }),
    (e) => e.status === 409,
  );
  assert.equal(ingested, false);
});

test('isRetryBlockedForReview detects the 409 retry guard', () => {
  assert.equal(isRetryBlockedForReview({ status: 409, message: 'edit it, then confirm…' }), true);
  assert.equal(isRetryBlockedForReview({ status: 500 }), false);
  assert.equal(isRetryBlockedForReview(undefined), false);
});

/* ==================== scope guards ==================== */

test('kb-detail wires the review flow endpoints and stops polling at ready_for_review', () => {
  const page = src('../js/pages/kb-detail.js').toLowerCase();
  assert.match(page, /endpoints\.documentcontent/);
  assert.match(page, /endpoints\.documentconfirm/);
  assert.match(page, /endpoints\.documentingest/);
  assert.ok(page.includes('opendocreview'), 'review editor must be openable');
  assert.ok(!page.includes("'/embed"), 'must not call an embed endpoint directly');
  assert.ok(!/fetch\s*\(\s*['"`]https?:/.test(page), 'must not fetch arbitrary external URLs');
});

test('the upload response is not treated as embedding-started (no "ingestion continues" wording)', () => {
  const page = src('../js/pages/kb-detail.js').toLowerCase();
  assert.ok(!page.includes('ingestion continues in celery'), 'upload must park in review, not embed');
  assert.match(page, /extracting text/);
});

test('config exposes the three new document review endpoints', () => {
  const cfg = src('../js/config.js');
  assert.match(cfg, /documentContent:/);
  assert.match(cfg, /documentConfirm:/);
  assert.match(cfg, /documentIngest:/);
});
