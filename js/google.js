import { GOOGLE_CLIENT_ID } from './config.js';

let scriptP = null;
/** Load Google Identity Services once (lazy, non-blocking). Resolves false if blocked/offline. */
export function loadGsi() {
  if (window.google?.accounts?.id) return Promise.resolve(true);
  if (!scriptP) {
    scriptP = new Promise((res) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; res(v); } };
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = () => finish(!!window.google?.accounts?.id);
      s.onerror = () => finish(false);
      document.head.appendChild(s);
      setTimeout(() => finish(!!window.google?.accounts?.id), 8000);
    });
  }
  return scriptP;
}

/**
 * Render the official Google button into `el`.
 * No-ops gracefully when GOOGLE_CLIENT_ID is unset or GSI is blocked —
 * password login keeps working. `mode`: 'signin' | 'signup' (button label).
 */
export async function mountGoogleButton(el, { mode = 'signin', onCredential }) {
  if (!el) return false;
  if (!GOOGLE_CLIENT_ID) return false; // hidden until client ID is configured
  const ok = await loadGsi();
  if (!ok || !window.google?.accounts?.id) return false;
  try {
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (resp) => resp?.credential && onCredential?.(resp.credential),
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    window.google.accounts.id.renderButton(el, {
      theme: 'outline',
      size: 'large',
      text: mode === 'signup' ? 'signup_with' : 'signin_with',
      shape: 'rectangular',
      logo_alignment: 'left',
    });
    return true;
  } catch {
    return false;
  }
}
