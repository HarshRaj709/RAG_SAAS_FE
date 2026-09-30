/** Tiny store for user + current org, persisted. */
const K = { user: 'rag_user', org: 'rag_org_id', theme: 'rag_theme', sidebar: 'rag_sidebar' };
export const store = {
  getUser() { try { return JSON.parse(localStorage.getItem(K.user)); } catch { return null; } },
  setUser(u) { localStorage.setItem(K.user, JSON.stringify(u)); },
  getOrgId() { return localStorage.getItem(K.org); },
  setOrgId(id) { if (id) localStorage.setItem(K.org, id); else localStorage.removeItem(K.org); },
  clear() { localStorage.removeItem(K.user); localStorage.removeItem(K.org); },
};
export function getTheme() {
  return localStorage.getItem(K.theme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
export function setTheme(t) { localStorage.setItem(K.theme, t); document.documentElement.dataset.theme = t; }
export function initTheme() { document.documentElement.dataset.theme = getTheme(); }
