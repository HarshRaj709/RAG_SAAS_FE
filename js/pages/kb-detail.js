import { initTheme, store } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext, currentRole } from '../components/org-switcher.js';
import { apiFetch, asList, uploadWithProgress } from '../api.js';
import { ENDPOINTS, ACCEPTED_EXTS, MAX_FILE_MB, POLL_MS, FINAL_DOC_STATUSES, MAX_DOC_POLLS } from '../config.js';
import { toast, confirmDialog, skeletonList, emptyState, openModal } from '../ui.js';
import { escapeHtml, timeAgo, formatBytes, qp } from '../utils.js';
initTheme();
await guard('knowledge-bases.html');
const { orgId, org } = await getOrgContext();
const kbId = qp('id');
const page = document.getElementById('page');
const role = currentRole(org);
const canManage = role === 'owner' || role === 'admin';
if (!kbId) { page.innerHTML = emptyState('📚', 'No KB selected', '', `<a class="btn btn-primary" href="knowledge-bases.html">Back to list</a>`); throw 0; }
let kb = null, docs = [], tab = qp('tab', 'documents'), poller = null, pollCount = 0, stalled = false;
/** Doc field accessors — backend key names vary. */
const docId = (d) => d.id || d.doc_id || d.pk || d.uuid;
const docName = (d) => d.filename || d.file_name || d.name || 'Untitled';
const docStatus = (d) => String(
  d.status || d.ingestion_status || d.state || d.ingest_status
  || (d.ingested_at ? 'completed' : 'pending')
);
const docChunks = (d) => (d.chunk_count ?? d.chunks_count ?? d.chunks ?? null);
/** Documents come embedded in the KB detail (no separate list endpoint). */
function kbDocs(detail) {
  if (!detail || typeof detail !== 'object') return [];
  for (const k of ['documents', 'files', 'docs', 'uploads', 'items']) {
    if (Array.isArray(detail[k])) return detail[k];
  }
  return [];
}
async function loadKb() {
  try { kb = await apiFetch(ENDPOINTS.kbDetail(orgId, kbId)); }
  catch { const l = asList(await apiFetch(ENDPOINTS.kbs(orgId)).catch(() => [])); kb = l.find(x => String(x.id) === String(kbId)) || { id: kbId, name: 'Knowledge Base' }; }
}
const isFinal = (d) => FINAL_DOC_STATUSES.includes(docStatus(d).toLowerCase());
function stopPoll() { if (poller) { clearInterval(poller); poller = null; } }
async function loadDocs(silent, opts = {}) {
  if (opts.reset) { pollCount = 0; stalled = false; stopPoll(); }
  try {
    const detail = await apiFetch(ENDPOINTS.kbDetail(orgId, kbId));
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) kb = { ...kb, ...detail };
    docs = kbDocs(detail);
    const pending = docs.some(d => !isFinal(d));
    if (!pending) { stopPoll(); pollCount = 0; if (stalled) { stalled = false; } renderDocs(); return; }
    if (stalled) { renderDocs(); return; } // gave up auto-polling; wait for manual Refresh
    if (pollCount >= MAX_DOC_POLLS) {
      stopPoll(); stalled = true; renderDocs();
      toast('Ingestion is taking longer than usual — auto-check stopped. Hit Refresh to check again.', 'info');
      return;
    }
    renderDocs();
    if (!poller && !document.hidden) poller = setInterval(() => { pollCount++; loadDocs(true); }, POLL_MS);
  } catch (e) { if (!silent) toast(e.message, 'error'); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPoll(); else if (!document.hidden && !stalled) loadDocs(true); });
function fileIcon(fn = '') { const e = fn.split('.').pop().toLowerCase(); return e === 'pdf' ? '📕' : e === 'docx' ? '📘' : '📄'; }
function badgeFor(s) {
  const v = s.toLowerCase();
  if (['completed', 'complete', 'done', 'ready', 'indexed', 'processed', 'success', 'succeeded'].includes(v)) return 'b-completed';
  if (['failed', 'error', 'errored'].includes(v)) return 'b-failed';
  if (['processing', 'ingesting', 'running', 'queued', 'in_progress'].includes(v)) return 'b-processing';
  return 'b-pending';
}
function renderDocs() {
  const w = document.getElementById('docs');
  if (!w) return;
  if (!docs.length) { w.innerHTML = emptyState('📄', 'No documents yet', 'Upload PDFs, DOCX, MD or TXT. Documents are split using a recursive text splitter.', ''); return; }
  const hasPending = docs.some(d => !isFinal(d));
  w.innerHTML = `<div class="table-wrap"><table><thead><tr><th>File</th><th>Status</th><th>Chunks</th><th>Uploaded</th><th></th></tr></thead><tbody>
    ${docs.map(d => `<tr><td>${fileIcon(docName(d))} <strong>${escapeHtml(docName(d))}</strong><br><span class="tiny muted">${formatBytes(d.size_bytes || d.size)}</span></td>
    <td><span class="badge ${badgeFor(docStatus(d))}">${escapeHtml(docStatus(d))}</span></td>
    <td class="mono">${docChunks(d) ?? '—'}</td><td class="small" title="${escapeHtml(d.created_at || d.uploaded_at || '')}">${timeAgo(d.created_at || d.uploaded_at)}${d.uploaded_by ? `<br><span class="tiny muted">${escapeHtml(d.uploaded_by)}</span>` : ''}</td>
    <td>${canManage ? `<button class="btn btn-ghost btn-sm" data-rm="${docId(d)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${stalled ? `<div class="alert alert-warning mt2">Still showing non-final status after ~2 min of checks — auto-refresh stopped. The backend may be slow or stuck. <button class="btn btn-secondary btn-sm" id="docs-refresh">Refresh now</button></div>`
      : hasPending ? `<p class="tiny muted mt1">⏳ Checking ingestion status every few seconds… <button class="btn btn-ghost btn-sm" id="docs-refresh">Refresh now</button></p>` : ''}`;
  const rf = w.querySelector('#docs-refresh');
  if (rf) rf.onclick = () => loadDocs(false, { reset: true });
  w.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog({ title: 'Delete document?', body: 'The file and its chunks will be removed from search.', confirmText: 'Delete' })) return;
    try { await apiFetch(ENDPOINTS.documentDetail(orgId, kbId, b.dataset.rm), { method: 'DELETE' }); toast('Document deleted', 'success'); loadDocs(); }
    catch (e) { toast(e.status === 403 ? 'Permission denied.' : e.message, 'error'); }
  });
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
    await uploadWithProgress(ENDPOINTS.ingest(orgId, kbId), fd, (p) => { const u = uploads.get(id); if (u) { u.p = p; renderUploads(); } }, ctrl.signal);
    uploads.get(id).state = 'done'; uploads.get(id).p = 100; renderUploads();
    setTimeout(() => { uploads.delete(id); renderUploads(); }, 2500);
    toast(`${file.name} uploaded — processing…`, 'success'); loadDocs(true, { reset: true });
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
    ${canManage ? `<div class="dropzone" id="dz" role="button" tabindex="0" aria-label="Upload documents"><strong>Drag & drop files here</strong> or <u>browse</u><br><span class="small muted">${ACCEPTED_EXTS.join(' · ')} · max ${MAX_FILE_MB} MB each · recursive text splitter</span><input type="file" id="fp" multiple hidden accept="${ACCEPTED_EXTS.join(',')}"></div><div id="uploads" class="mt2"></div>` : `<div class="alert alert-info">You have read-only access. Only owners/admins can upload.</div>`}
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
await loadDocs();
