/**
 * Pure, DOM-free logic for the uploaded-document review flow.
 *
 * File uploads no longer auto-embed: the backend parks the document in
 * `ready_for_review` (same idea as web-import drafts). The user optionally
 * edits the extracted content (PATCH), then confirms (freezes edits) and
 * starts embedding as two separate calls — mirroring the web-import
 * confirm → ingest sequence.
 *
 * Everything here is dependency-injected (`request` = apiFetch) so it can be
 * unit-tested in Node without a browser.
 */

const READY = ['completed', 'complete', 'done', 'ready', 'indexed', 'processed', 'success', 'succeeded'];
const FAILED = ['failed', 'error', 'errored'];
const PENDING = ['pending', 'queued', 'waiting', 'created'];
const PROCESSING = ['processing', 'ingesting', 'running', 'in_progress', 'in-progress'];
export const REVIEW_STATUS = 'ready_for_review';

/** Map a raw document status to a stable {key,label,badge} used by the UI. */
export function docStatusInfo(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (v === REVIEW_STATUS) return { key: 'review', label: 'Needs review', badge: 'b-warning' };
  if (FAILED.includes(v)) return { key: 'failed', label: 'Failed', badge: 'b-failed' };
  if (READY.includes(v)) return { key: 'ready', label: 'Completed', badge: 'b-completed' };
  if (PROCESSING.includes(v)) return { key: 'processing', label: 'Processing', badge: 'b-processing' };
  if (PENDING.includes(v)) return { key: 'pending', label: 'Queued', badge: 'b-pending' };
  return { key: 'unknown', label: raw ? String(raw) : 'Unknown', badge: 'b-pending' };
}

/** Polling stops at ready_for_review (open the editor) or a final state. */
export function isDocPollTerminal(raw) {
  const k = docStatusInfo(raw).key;
  return k === 'review' || k === 'ready' || k === 'failed';
}

/** Normalize the content GET payload; never throws on odd shapes. */
export function normalizeDocContent(res) {
  const r = res && typeof res === 'object' ? res : {};
  return {
    content: typeof r.content === 'string' ? r.content : '',
    original_content: typeof r.original_content === 'string' ? r.original_content : (typeof r.content === 'string' ? r.content : ''),
    word_count: Number(r.word_count) || 0,
    editable: r.editable !== false,
    error: r.error || r.error_message || '',
  };
}

/** GET the extracted content for review. */
export async function requestDocContent(request, endpoint) {
  const res = await request(endpoint, { cacheTtl: 0 });
  return normalizeDocContent(res);
}

/**
 * PATCH edited content. Only `content` is sent — the server owns everything
 * else. 400 = blank/oversized, 409 = already confirmed. Returns normalized
 * content on success.
 */
export async function saveDocContent(request, endpoint, content) {
  const res = await request(endpoint, { method: 'PATCH', body: { content } });
  if (res && typeof res === 'object' && 'content' in res) return normalizeDocContent(res);
  return normalizeDocContent({ ...res, content });
}

/** POST confirm — freezes edits. 200 {confirmed_at, word_count, already_confirmed}. */
export async function confirmDoc(request, endpoint) {
  const res = await request(endpoint, { method: 'POST', body: {} });
  const r = res && typeof res === 'object' ? res : {};
  return {
    confirmed_at: r.confirmed_at || null,
    word_count: Number(r.word_count) || 0,
    already_confirmed: Boolean(r.already_confirmed),
  };
}

/**
 * POST ingest — starts embedding of the confirmed content.
 * 202 {status, chunk_count, already_processing}; 200 if already ready;
 * 409 if the document is not confirmed yet.
 */
export async function ingestDoc(request, endpoint) {
  const res = await request(endpoint, { method: 'POST', body: {} });
  const r = res && typeof res === 'object' ? res : {};
  return {
    status: String(r.status || 'pending'),
    chunk_count: r.chunk_count ?? null,
    already_processing: Boolean(r.already_processing),
  };
}

/**
 * Confirm then start embedding — two calls, like web-import. Throws the
 * original error (409 on ingest = not confirmed; confirm always first).
 */
export async function confirmAndStartEmbedding({ confirm, ingest }) {
  const confirmation = await confirm();
  const queued = await ingest();
  return { confirmation, queued };
}

/** True when a retry was rejected because the doc still needs review. */
export function isRetryBlockedForReview(err) {
  return err?.status === 409;
}
