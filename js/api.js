import { API_BASE_URL, ENDPOINTS, USE_MOCK } from './config.js';

/** Normalize DRF paginated vs array responses to array. */
export function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}
function getAccess() { return localStorage.getItem('rag_access'); }

/* ---- GET cache + in-flight dedup ----
 * Hard refresh fired 3-4 identical GETs (guard → topbar → org-context)
 * plus N sequential kbDetail calls. This layer collapses concurrent
 * identical GETs into one network request and serves short-TTL cached
 * results (memory + sessionStorage so same-tab hard refresh still hits).
 * Any non-GET mutation busts the cache so creates/deletes never go stale.
 */
const MEM_CACHE = new Map(); // key -> { expiry, data }
const INFLIGHT = new Map(); // key -> Promise
const DEFAULT_TTL = 20000;
const SS_PREFIX = 'rag_cache:';

function cacheKey(method, url) { return `${method.toUpperCase()} ${url}`; }
function ssGet(key) {
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + key);
    if (!raw) return null;
    const { expiry, data } = JSON.parse(raw);
    if (!expiry || Date.now() > expiry) { sessionStorage.removeItem(SS_PREFIX + key); return null; }
    return data;
  } catch { return null; }
}
function ssSet(key, data, ttl) {
  try { sessionStorage.setItem(SS_PREFIX + key, JSON.stringify({ expiry: Date.now() + ttl, data })); } catch { /* quota/full — ignore */ }
}
export function invalidateCache(prefix = '') {
  for (const k of [...MEM_CACHE.keys()]) if (!prefix || k.includes(prefix)) MEM_CACHE.delete(k);
  try {
    if (!prefix) {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(SS_PREFIX)) sessionStorage.removeItem(k);
      }
    }
  } catch { /* ignore */ }
}

async function refreshOnce() {
  const refresh = localStorage.getItem('rag_refresh');
  if (!refresh) return false;
  try {
    const r = await fetch(API_BASE_URL + ENDPOINTS.refresh(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    const next = j.access || j.access_token || j?.data?.access || j?.data?.access_token;
    if (next) { localStorage.setItem('rag_access', next); return true; }
  } catch { /* ignore */ }
  return false;
}

/** Humanize DRF errors. Returns {message, fields} */
export function parseError(status, payload) {
  const fields = {};
  if (!payload) return { message: `Request failed (${status})`, fields };
  if (typeof payload === 'string') return { message: payload, fields };
  if (payload.detail) return { message: String(payload.detail), fields };
  if (Array.isArray(payload.non_field_errors)) return { message: payload.non_field_errors.join(' '), fields };
  const msgs = [];
  for (const [k, v] of Object.entries(payload)) {
    const t = Array.isArray(v) ? v.join(' ') : String(v);
    if (['count', 'next', 'previous', 'results'].includes(k)) continue;
    fields[k] = t; msgs.push(`${k}: ${t}`);
  }
  return { message: msgs.join(' · ') || `Request failed (${status})`, fields };
}

let mockSeed = 3;
function mockResponse(method, path, body) {
  if (path.includes('/kbs/') && (path.includes('/documents') || path.includes('/ingest'))) return body instanceof FormData ? { id: 'd' + (mockSeed++), filename: 'upload.pdf', status: 'pending', chunk_count: 0, created_at: new Date().toISOString() } : [];
  if (path.endsWith('/kbs/')) return method === 'POST' ? { id: 'kb1', ...body, document_count: 0, total_chunks: 0, created_at: new Date().toISOString() } : [{ id: 'kb1', name: 'Help Center', description: 'Support docs', document_count: 4, total_chunks: 128, created_at: new Date().toISOString() }];
  if (path.endsWith('/bots/')) return method === 'POST' ? { id: 'b1', slug: 'acme-support', api_key: 'rag_demo_key_123456', ...body } : [{ id: 'b1', name: 'Support Bot', slug: 'acme-support', knowledge_bases: ['kb1'], created_at: new Date().toISOString() }];
  if (path.includes('/chat/')) return { answer: 'This is a **mock answer** grounded in your docs. (Enable backend for real RAG.)', sources: [{ filename: 'help.md', score: 0.91 }] };
  if (path.includes('/members')) return [{ id: 'm1', name: 'Ava Owner', email: 'ava@acme.com', role: 'owner' }];
  if (path.includes('/orgs/') && !path.endsWith('/orgs/')) return { id: 'org1', name: 'Acme Inc', user_role: 'owner', members: [{ id: 'm1', username: 'ava', email: 'ava@acme.com', role: 'owner' }] };
  if (path.includes('/orgs/')) return [{ id: 'org1', name: 'Acme Inc', role: 'owner' }];
  return {};
}

/**
 * Authenticated fetch wrapper.
 * @param {string} path endpoint path (from config.js)
 * @param {object} opts {method, body, auth=true, signal, botKey, cacheTtl}
 *  - GETs are deduped (concurrent identical) + cached for `cacheTtl` ms
 *    (default 20s). Pass cacheTtl: 0 to bypass cache for fresh data.
 */
export async function apiFetch(path, { method = 'GET', body, auth = true, signal, botKey, isForm = false, cacheTtl } = {}) {
  if (USE_MOCK) { await new Promise(r => setTimeout(r, 350)); return mockResponse(method, path, body); }
  const url = path.startsWith('http') ? path : API_BASE_URL + path;
  const m = method.toUpperCase();
  const useCache = m === 'GET' && (cacheTtl ?? DEFAULT_TTL) > 0;
  const ttl = cacheTtl ?? DEFAULT_TTL;
  const key = cacheKey(m, url);
  if (useCache) {
    const mem = MEM_CACHE.get(key);
    if (mem && Date.now() < mem.expiry) return mem.data;
    if (INFLIGHT.has(key)) return INFLIGHT.get(key);
    const ss = ssGet(key);
    if (ss !== null) { MEM_CACHE.set(key, { expiry: Date.now() + Math.min(ttl, 15000), data: ss }); return ss; }
  }
  const exec = (async () => {
    const headers = {};
    if (!isForm) headers['Content-Type'] = 'application/json';
    if (auth && getAccess()) headers['Authorization'] = `Bearer ${getAccess()}`;
    if (botKey) headers['Authorization'] = `Bearer ${botKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    if (signal) signal.addEventListener('abort', () => controller.abort());
    const doFetch = () => fetch(url, { method, headers, signal: controller.signal, body: body == null ? undefined : (isForm ? body : JSON.stringify(body)) });
    let res;
    try { res = await doFetch(); }
    catch (e) { clearTimeout(timer); throw { status: 0, message: e.name === 'AbortError' ? 'Request timed out. Try again.' : 'Network error. Is the backend running?' }; }
    clearTimeout(timer);
    if (res.status === 401 && auth && getAccess()) {
      const ok = await refreshOnce();
      if (ok) { headers['Authorization'] = `Bearer ${getAccess()}`; res = await fetch(url, { method, headers, body: body == null ? undefined : (isForm ? body : JSON.stringify(body)) }); }
      else { localStorage.removeItem('rag_access'); localStorage.removeItem('rag_refresh'); const n = encodeURIComponent(location.pathname + location.search); location.href = `login.html?next=${n}`; throw { status: 401, message: 'Session expired. Please log in.' }; }
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const { message, fields } = parseError(res.status, data);
      const err = { status: res.status, message, fields };
      throw err;
    }
    return data;
  })();
  if (useCache) {
    INFLIGHT.set(key, exec);
    try {
      const data = await exec;
      MEM_CACHE.set(key, { expiry: Date.now() + ttl, data });
      ssSet(key, data, ttl);
      return data;
    } finally { INFLIGHT.delete(key); }
  }
  // Mutations: bust GET cache so later reads never serve stale lists.
  try { return await exec; }
  finally { invalidateCache(); }
}

/** XHR upload with progress (fetch can't report progress). */
export function uploadWithProgress(path, formData, onProgress, signal) {
  if (USE_MOCK) return new Promise(res => { let p = 0; const t = setInterval(() => { p += 25; onProgress?.(p); if (p >= 100) { clearInterval(t); res({ id: 'd' + Date.now(), filename: 'upload.pdf', status: 'pending', chunk_count: 0 }); } }, 200); });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE_URL + path);
    const tok = getAccess(); if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
    if (signal) signal.addEventListener('abort', () => xhr.abort());
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } }
      else { try { const { message } = parseError(xhr.status, JSON.parse(xhr.responseText)); reject({ status: xhr.status, message }); } catch { reject({ status: xhr.status, message: 'Upload failed' }); } }
    };
    xhr.onerror = () => reject({ status: 0, message: 'Network error during upload' });
    xhr.onabort = () => reject({ status: 0, message: 'Upload cancelled' });
    xhr.send(formData);
  });
}
