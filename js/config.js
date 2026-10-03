/** Central API configuration. Edit ONLY here when backend paths differ. */
export const API_BASE_URL = localStorage.getItem('rag_api_base') || 'http://localhost:8000';
export const USE_MOCK = false; // set true to demo UI offline with fake data
export const MAX_FILE_MB = 50;
export const ACCEPTED_EXTS = ['.pdf', '.docx', '.md', '.txt'];
export const POLL_MS = 4000;

const org = (id) => `/api/organization/orgs/${id}/`;
export const ENDPOINTS = {
  signup: () => '/api/auth/register/',
  login: () => '/api/auth/login/',
  refresh: () => '/api/auth/token/refresh/', // TODO(verify): confirm against Postman docs
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
  documentDetail: (orgId, kbId, docId) => `/api/knowledge_base/orgs/${orgId}/kbs/${kbId}/documents/${docId}/`, // GET status, DELETE single doc
  documentRetry: (orgId, kbId, docId) => `/api/knowledge_base/orgs/${orgId}/kbs/${kbId}/documents/${docId}/retry/`, // POST retry failed ingestion
  bots: (id) => `/api/chat/orgs/${id}/bots/`,
  botDetail: (orgId, botId) => `/api/chat/orgs/${orgId}/bots/${botId}/`,
  regenerateKey: (orgId, botId) => `/api/chat/orgs/${orgId}/bots/${botId}/keys/rotate/`, // POST: rotates key, raw key returned once
  // Public chat — verified pattern from plan; alt: /api/bots/{id}/chat/
  publicChat: (slug) => `/api/chat/bot/${slug}/chat/`, // TODO(verify) against Postman
};
export const FINAL_DOC_STATUSES = ['completed', 'complete', 'done', 'ready', 'indexed', 'processed', 'success', 'succeeded', 'failed', 'error', 'errored'];
export const MAX_DOC_POLLS = 30; // ~2 min at POLL_MS; then polling stops with a manual Refresh
