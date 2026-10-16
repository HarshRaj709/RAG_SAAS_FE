# RAG SaaS — Frontend

Plain HTML + CSS + vanilla JS (ES2022 modules). No build step.

## Run

```powershell
cd Rag_Saas_fe
python -m http.server 5500
# open http://127.0.0.1:5500/index.html
```

Or use VS Code Live Server.

## Test

```bash
npm test   # Node's built-in test runner (node:test) — no dependencies
```

Tests cover the web-import review flow (start import, routing by import id, status
mapping/progress, markdown rendering, polling lifecycle + failures, list
normalization, and scope guards). They mock the API and never hit real webpages
or Jina.

## Change API base URL

Edit `js/config.js` → `API_BASE_URL`. Single source of truth — no runtime override.

## Bot allowed domains (website whitelist)

Per-bot, owner user-JWT (not bot key): **Bots → open bot → Overview → Allowed domains**, or set at creation (wizard step 3, Settings). One bare hostname per line (`mysite.com`, `www.mysite.com` — each subdomain separately). Scheme/ports are normalized automatically; wildcards (`*.example.com`) return 400. Sent as `allowed_domains` via `GET` (read) / `PATCH` (update) `/api/chat/orgs/<org_uuid>/bots/<bot_uuid>/` and `POST /api/chat/orgs/<org_uuid>/bots/` at creation. Only `kb_ids` + `allowed_domains` are PATCH-writable.

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

Signup/login/JWT + silent refresh, org switcher, dashboard stats + checklist, KB CRUD + drag-drop upload with progress + status polling, KB data sources (file upload / website URL discovery → `POST /kbs/<id>/discover/` with `root_url`, selectable page list; **selected pages → scrape → review**), bot wizard + one-time key modal + integration snippets + playground (session UUID, markdown, sources), members/invites with role matrix, settings, light/dark theme, toasts/skeletons/empty/error states, responsive + a11y (focus trap, Esc, `/` search, reduced-motion).

### Webpage scrape → review

From a KB's **Add data → From website**, discover pages, pick the ones you want,
then **Review selected pages**. That `POST /kbs/<id>/web-imports/` with
`{urls}` and routes to `web-import.html?kb=<kbId>&import=<importId>`.

`js/pages/web-import.js` is the review screen: it polls
`GET /web-imports/<id>/` and `GET /web-imports/<id>/pages/` (persisted drafts —
never re-scrapes), shows per-page status/word-count, renders Markdown (escaped
then DOMPurify-sanitized), and stops polling on terminal states or unmount. The
import id lives in the route, so refreshing restores the session. Pure logic
(normalizers, status/progress mapping, markdown, poller) is in
`js/pages/web-import-controller.js` and unit-tested.

The review screen supports editing saved Markdown, including or excluding a
draft, and deleting a staged draft. **Confirm Import** posts to
`POST /kbs/<kbId>/web-imports/<importId>/confirm/`; the backend records an
immutable snapshot and returns `status`, `confirmed_at`, `page_count`, and
`already_confirmed`. Confirmation ends this frontend workflow. It does not run
ingestion, chunking, embeddings, or indexing. A confirmed session is restored
as read-only when reopened.

The KB **Documents** tab also lists past webpage imports
(`GET /kbs/<id>/web-imports/`), so an unconfirmed scrape can be reopened later
(**Review**) or discarded (**Remove** → `DELETE /web-imports/<id>/`, owner/admin).
Removing a session only drops its unconfirmed drafts; documents already in the KB
are untouched.

Out of scope for this screen: chunking, embeddings, and vector indexing.

## Known backend gaps

- Per-key usage tracking → "Coming soon" placeholder.
- LLM settings (system prompt/temperature/max tokens) → disabled "Coming soon" in wizard.
- Exact field names for signup/invites/regenerate-key may differ — see `TODO(verify)` in `config.js`.

## Add a new page

1. Copy `dashboard.html` shell → `mypage.html`, point script to `js/pages/mypage.js`.
2. Add nav entry in `js/components/sidebar.js` + crumb in `topbar.js`.
3. Guard with `await guard('mypage.html')` + `getOrgContext()` for org scope.
