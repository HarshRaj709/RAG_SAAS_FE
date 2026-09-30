# RAG SaaS — Frontend

Plain HTML + CSS + vanilla JS (ES2022 modules). No build step.

## Run

```powershell
cd Rag_Saas_fe
python -m http.server 5500
# open http://127.0.0.1:5500/index.html
```

Or use VS Code Live Server.

## Change API base URL

Edit `js/config.js` → `API_BASE_URL`, or override at runtime in Settings → API base (stored in `localStorage.rag_api_base`). All endpoint paths live in `ENDPOINTS` in the same file — fix them there to match the Postman docs. Items marked `// TODO(verify)` are uncertain: token refresh, invite shapes, regenerate-key, public chat path.

Set `USE_MOCK = true` in `config.js` to demo the UI offline with fake data.

## Backend CORS note

Frontend runs on e.g. `http://127.0.0.1:5500`, Django on `http://localhost:8000`. Backend needs:

```
pip install django-cors-headers
# settings.py: INSTALLED_APPS += ['corsheaders'], MIDDLEWARE insert CorsMiddleware
CORS_ALLOWED_ORIGINS = ["http://127.0.0.1:5500", "http://localhost:5500"]
# Authorization is in default CORS_ALLOW_HEADERS.
```

## Folder map

- `index.html` landing; `login/signup/accept-invite.html` auth; `dashboard/members/settings.html` app; `knowledge-bases/-base.html`, `bots/bot.html`
- `css/`: tokens, base, components, layout, pages
- `js/`: config, api (fetch+refresh+upload progress), auth, state (theme/org/user), ui (toast/modal/confirm), router-guard, utils
- `js/components/`: sidebar, topbar, org-switcher, chat-widget (playground)
- `js/pages/`: one module per page

## Features

Signup/login/JWT + silent refresh, org switcher, dashboard stats + checklist, KB CRUD + drag-drop upload with progress + status polling, bot wizard + one-time key modal + integration snippets + playground (session UUID, markdown, sources), members/invites with role matrix, settings, light/dark theme, toasts/skeletons/empty/error states, responsive + a11y (focus trap, Esc, `/` search, reduced-motion).

## Known backend gaps

- Per-key usage tracking → "Coming soon" placeholder.
- LLM settings (system prompt/temperature/max tokens) → disabled "Coming soon" in wizard.
- Exact field names for signup/invites/regenerate-key may differ — see `TODO(verify)` in `config.js`.

## Add a new page

1. Copy `dashboard.html` shell → `mypage.html`, point script to `js/pages/mypage.js`.
2. Add nav entry in `js/components/sidebar.js` + crumb in `topbar.js`.
3. Guard with `await guard('mypage.html')` + `getOrgContext()` for org scope.
