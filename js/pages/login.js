import { initTheme } from '../state.js';
import { login, getNext } from '../auth.js';
import { toast, setFieldError, withLoading } from '../ui.js';
initTheme();
document.querySelector('.toggle-pw').onclick = (e) => { const i = document.getElementById('pw'); i.type = i.type === 'password' ? 'text' : 'password'; };
const form = document.getElementById('f');
document.getElementById('sub').onclick = withLoading(document.getElementById('sub'), async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('pw').value;
  if (!email || !password) { toast('Enter email and password.', 'error'); return; }
  try { await login(email, password); toast('Welcome back!', 'success'); location.href = getNext(); }
  catch (err) { setFieldError(form, err); toast(err.message || 'Login failed', 'error'); document.getElementById('pw').focus(); }
});
form.addEventListener('submit', (e) => { e.preventDefault(); document.getElementById('sub').click(); });
