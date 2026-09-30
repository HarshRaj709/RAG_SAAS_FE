import { apiFetch } from './api.js';
import { ENDPOINTS } from './config.js';
import { store } from './state.js';

export function getNext(defaultTo = 'dashboard.html') {
  const n = new URLSearchParams(location.search).get('next');
  // Allow same-origin targets: "dashboard.html", "/dashboard.html",
  // "/invites/accept/?token=...". Reject "//evil.com" and "https://...".
  if (n && !n.includes('://') && !n.startsWith('//')) return n;
  return defaultTo;
}
export async function login(usernameOrEmail, password) {
  const v = (usernameOrEmail || '').trim();
  // Send both keys: some backends expect `username`, others `email`.
  const data = await apiFetch(ENDPOINTS.login(), { method: 'POST', body: { username: v, email: v, password }, auth: false });
  const t = data?.tokens || data?.user?.tokens || data?.data?.tokens || {};
  // Backend returns tokens nested as user.tokens.{access_token, refresh};
  // also support flat {access, refresh} / {access_token, refresh_token}.
  const access = data.access || data.access_token || data.token
    || t.access || t.access_token || t.accessToken
    || data?.data?.access || data?.data?.access_token;
  const refresh = data.refresh || data.refresh_token
    || t.refresh || t.refresh_token || t.refreshToken;
  if (!access) throw { status: 400, message: 'Unexpected login response from server.' };
  localStorage.setItem('rag_access', access);
  if (refresh) localStorage.setItem('rag_refresh', refresh);
  const u = data.user || data?.data?.user || null;
  if (u) store.setUser({ name: u.username || u.name, email: u.email, role: u.role, ...u });
  return data;
}
export async function signup(payload) {
  return apiFetch(ENDPOINTS.signup(), { method: 'POST', body: payload, auth: false });
}
export function logout() {
  localStorage.removeItem('rag_access'); localStorage.removeItem('rag_refresh');
  sessionStorage.clear(); store.clear();
  location.href = 'login.html';
}
export function isAuthed() { return !!localStorage.getItem('rag_access'); }
