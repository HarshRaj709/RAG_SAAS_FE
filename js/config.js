/** Central API configuration. Edit ONLY here when backend paths differ. */
try { localStorage.removeItem('rag_api_base'); } catch { /* ignore — stale override from removed Settings UI */ }
export const API_BASE_URL = (localStorage.getItem('rag_api_base') || 'https://rag-chat-bot-5yva.onrender.com/').trim().replace(/\/+$/, '');
export const USE_MOCK = false; // set true to demo UI offline with fake data
/** Google OAuth client ID. Paste your Web client ID here, or set localStorage 'rag_google_cid'. Empty = Google buttons hidden. */
export const GOOGLE_CLIENT_ID = (localStorage.getItem('rag_google_cid') || '1098189772889-3mpemau29ut364viqh3nd86oqkt6c0sk.apps.googleusercontent.com').trim();
export const MAX_FILE_MB = 50;
export const ACCEPTED_EXTS = ['.pdf', '.docx', '.md', '.txt'];
export const POLL_MS = 4000;

const org = (id) => `/api/organization/orgs/${id}/`;
export const ENDPOINTS = {
  signup: () => '/api/auth/register/',
  login: () => '/api/auth/login/',
  refresh: () => '/api/auth/token/refresh/', // TODO(verify): confirm against Postman docs
  google: () => '/api/auth/google/', // POST {id_token} — signup + login in one call
  me: () => '/api/auth/me/', // TODO(verify): may be /api/users/me/
  orgs: () => '/api/organization/orgs/',
  orgCreate: () => '/api/organization/orgs/create/',
  orgDetail: (id) => org(id),
  orgUpdate: (id) => `/api/organization/orgs/${id}/update/`,
  orgDelete: (id) => `/api/organization/orgs/${id}/delete/`,
  members: (id) => org(id), // no separate endpoint: members embedded in org detail
  memberUpdate: (orgId, userId) => `/api/organization/orgs/${orgId}/members/update/${userId}/`,
  memberRemove: (orgId, userId) => `/api/organization/orgs/${orgId}/members/remove/${userId}/`,
  invites: (id) => `/api/organization/orgs/${id}/invites/`, // GET pending list, POST {email, role}
  inviteDetail: (orgId, iid) => `/api/organization/orgs/${orgId}/invites/${iid}/`, // DELETE revoke
  acceptInvite: () => '/api/organization/invites/accept/', // POST {token}
  kbs: (id) => `/api/knowledge_base/orgs/${id}/kbs/`, // GET list, POST create {name, description}
  kbDetail: (orgId, kbId) => `/api/knowledge_base/orgs/${orgId}/kbs/${kbId}/`, // GET detail, PATCH {name, description}, DELETE
  ingest: (orgId, kbId) => `/api/knowledge_base/orgs/${orgId}/kbs/${kbId}/ingest/`, // POST multipart {file}
  discover: (orgId, kbId) => `/api/knowledge_base/orgs/${orgId}/kbs/${kbId}/discover/`, // POST {root_url} -> discovered page list
  // Web import (scrape -> review).
  webImports: (orgId, kbId) => `/api/knowledge_base/orgs/${orgId}/kbs/${kbId}/web-imports/`, // GET -> past sessions (paginated); POST {urls} -> 202 {import_id, pages}
  webImportDetail: (orgId, importId) => `/api/knowledge_base/orgs/${orgId}/web-imports/${importId}/`, // GET session status + counts; DELETE discards unconfirmed drafts
  webImportPages: (orgId, importId) => `/api/knowledge_base/orgs/${orgId}/web-imports/${importId}/pages/`, // GET persisted drafts
  documentDetail: (orgId, kbId, docId) => `/api/knowledge_base/orgs/${orgId}/kbs/${kbId}/documents/${docId}/`, // GET status, DELETE single doc
  documentRetry: (orgId, kbId, docId) => `/api/knowledge_base/orgs/${orgId}/kbs/${kbId}/documents/${docId}/retry/`, // POST retry failed ingestion
  bots: (id) => `/api/chat/orgs/${id}/bots/`,
  botDetail: (orgId, botId) => `/api/chat/orgs/${orgId}/bots/${botId}/`,
  regenerateKey: (orgId, botId) => `/api/chat/orgs/${orgId}/bots/${botId}/keys/rotate/`, // POST: rotates key, raw key returned once
  // Public chat — customer-facing, bot secret key in Authorization header.
  publicChat: (slug) => `/api/chat/bot/${slug}/chat/`, // TODO(verify) against Postman
  // Internal test chat — dashboard playground only, owner/member user-JWT.
  botTestChat: (orgId, botId) => `/api/chat/orgs/${orgId}/bots/${botId}/test-chat/`,
};
export const BOT_DOMAINS_FIELD = 'allowed_domains';
export const FINAL_DOC_STATUSES = ['completed', 'complete', 'done', 'ready', 'indexed', 'processed', 'success', 'succeeded', 'failed', 'error', 'errored'];
export const MAX_DOC_POLLS = 30; // ~2 min at POLL_MS; then polling stops with a manual Refresh

/* ---- Web import (scrape -> review) statuses ---- */
// A page draft is done once it is completed or failed.
export const FINAL_PAGE_STATUSES = ['completed', 'complete', 'done', 'ready', 'success', 'succeeded', 'failed', 'error', 'errored'];
// The import session is terminal once every page has finished (all-ok, partial, or all-failed).
export const TERMINAL_SESSION_STATUSES = ['ready_for_review', 'partially_failed', 'failed'];
export const WEB_IMPORT_POLL_MS = 3000;
export const WEB_IMPORT_MAX_FAILURES = 3; // consecutive poll failures before giving up
