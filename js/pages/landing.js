import { initTheme, getTheme, setTheme } from '../state.js';

initTheme();
const b = document.getElementById('theme-btn');
if (b) {
  b.textContent = getTheme() === 'dark' ? '☀️' : '🌙';
  b.onclick = () => { const n = getTheme() === 'dark' ? 'light' : 'dark'; setTheme(n); b.textContent = n === 'dark' ? '☀️' : '🌙'; };
}

const EP = 'http://localhost:8000/api/chat/bot/YOUR-SLUG/chat/';
const snips = {
  curl: `curl -N -X POST "${EP}" \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"query": "What is your refund policy?", "session_id": "550e8400-e29b-41d4-a716-446655440000"}'\n\n# -N disables buffering so you receive each chunk live.`,
  js: `const res = await fetch('${EP}', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer YOUR_API_KEY' },\n  body: JSON.stringify({ query: 'What is your refund policy?', session_id: crypto.randomUUID() })\n});\n\n// Streamed NDJSON chunks: {"token": "...", "session_id": "..."}\nconst reader = res.body.getReader();\nconst decoder = new TextDecoder();\nlet buf = '', answer = '';\nwhile (true) {\n  const { done, value } = await reader.read();\n  if (done) break;\n  buf += decoder.decode(value, { stream: true });\n  for (const line of buf.split('\\n')) {\n    const t = line.trim().replace(/^data:\\s*/, '');\n    if (!t || t === '[DONE]') continue;\n    try {\n      const o = JSON.parse(t);\n      if (o.done) break;\n      if (o.token) { answer += o.token; process.stdout?.write?.(o.token); }\n    } catch { /* partial chunk — wait for more */ }\n  }\n}`,
  py: `import requests, json\nr = requests.post(\n  '${EP}',\n  headers={'Authorization': 'Bearer YOUR_API_KEY'},\n  json={'query': 'What is your refund policy?', 'session_id': 'uuid-here'},\n  stream=True,\n)\nanswer = ''\nfor line in r.iter_lines():\n    if not line:\n        continue\n    o = json.loads(line)  # {"token": "...", "session_id": "..."}\n    if o.get('done'):\n        break\n    answer += o.get('token', '')\nprint(answer)`,
};
const pre = document.getElementById('snip');
if (pre) {
  const render = (k) => { pre.textContent = snips[k]; };
  render('curl');
  document.querySelectorAll('[data-snip]').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('[data-snip]').forEach(x => x.setAttribute('aria-selected', 'false'));
    t.setAttribute('aria-selected', 'true');
    render(t.dataset.snip);
  }));
}

const mockBody = document.getElementById('mock-body');
if (mockBody && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let i = 0;
  const convo = [
    ['Do you ship internationally?', 'Yes — we ship to 40+ countries in 3–5 business days.'],
    ['How do I reset my password?', 'Go to Settings → Security → Change password; the link expires in 1 hour.'],
  ];
  setInterval(() => {
    const [q, a] = convo[i++ % convo.length];
    mockBody.innerHTML = `<div class="chat-bubble chat-user">${q}</div><div class="chat-bubble chat-assistant">${a}</div>`;
  }, 5000);
}
