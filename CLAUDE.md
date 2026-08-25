# Project Memory — Event Station Tracker

This file is written to be dropped at the repo root as `CLAUDE.md`, where Claude Code loads it automatically at the start of a session — no need to point it here explicitly. It captures the architecture decisions, rejected alternatives, known bugs already fixed, and open items from the project's design conversation, so that context isn't lost between sessions.

## What this project is

A QR-code-based event gamification app. Participants register, visit physical stations at an event, scan each station's QR code with their phone, earn points, and see themselves on a leaderboard. Built for an event scale of roughly 500–3,000 participants.

## Current architecture (this is what's actually deployed)

- **Frontend**: Vite + vanilla JavaScript SPA (no framework), hash-based client-side routing (`#landing`, `#login`, `#register`, `#dashboard`, `#scan`, `#leaderboard`). Repo: `github.com/kchpomp/event-station-tracker`.
- **Hosting**: GitHub Pages, deployed via GitHub Actions on every push to `main` (official `configure-pages`/`upload-pages-artifact`/`deploy-pages` workflow, not the older `gh-pages` branch method).
- **Backend**: **Supabase Cloud** (managed) — not self-hosted.
- **Database**: Postgres via Supabase, schema described below.
- **Auth**: Supabase Auth (email+password under the hood), with a nickname-based login UX layered on top — see "Key design decisions."
- **Email delivery**: Supabase Auth's SMTP is configured to send through a Yandex mailbox (Yandex 360 / Yandex Mail), not Supabase's default shared sender, because the default sender's rate limits are far too low for a 1,000+ signup event.
- **UI language**: Russian, throughout. Supabase SDK error messages are English by default and are translated via a lookup map in the frontend — extend that map for new error cases rather than letting raw English strings leak into the UI.

## Architectures considered and explicitly rejected

Don't re-propose these without a new, stated reason — they were each evaluated and moved away from:

- **Self-hosted Supabase (Docker Compose) on a Yandex Cloud VM** — worked, but added real ongoing ops burden (patching, uptime, 13 containers) for no benefit at this scale. Replaced by Supabase Cloud.
- **Self-hosted Supabase via Beget's VPS marketplace template** — same reasoning as above; also considered migrating an existing local Supabase instance to it, decided against.
- **Self-hosted Supabase pointed at a manually-installed local Postgres** (instead of the bundled Postgres container) — investigated in depth; requires manually replicating Supabase's internal roles/schemas/init SQL onto a vanilla Postgres install, which is genuinely complex for no real benefit. Not pursued.
- **Hosting the frontend on a Russian server instead of GitHub Pages** — considered (alongside a capacity check for 1,000–3,000 users), but the project continued on GitHub Pages; no migration happened.
- **An earlier full Django + Postgres implementation plan** (with a 12-phase roadmap) — this was the *original* design before the project pivoted to a Supabase-based architecture. Fully superseded; not in use.
- **Django Admin as the admin interface** — moot now; Supabase Studio's Table Editor is the admin interface (manual event/station creation, manual visit overrides, CSV export).

## Database schema

Tables: `events`, `stations`, `profiles`, `station_visits`. Functions: `scan_station()`, `get_leaderboard()`, `get_email_by_nickname()`, `handle_new_user()` (trigger), `set_updated_at()` (trigger). The complete, current, authoritative SQL for all of this lives in **`production_setup.md`** in this repo/conversation — treat that file, not any earlier draft, as the source of truth for schema state. If `production_setup.md` isn't present in the repo yet, it needs to be added or its SQL needs to be (re)applied via the Supabase SQL Editor.

## Key design decisions and why (read before changing these)

- **`profiles` never stores email** — only `auth.users` has it, and `auth.users` is deliberately not exposed through the REST API. This is intentional privacy design, not an oversight.
- **`get_email_by_nickname()`** is a `security definer` function granted to the `anon` role, resolving nickname → email so login can accept a nickname even though Supabase Auth only understands email+password natively. **Known, accepted trade-off**: anyone who knows or guesses a nickname can retrieve the email behind it. Judged acceptable for this event's scale; if that ever changes, the fix is rate-limiting this function (e.g. a Supabase Edge Function), not a schema redesign.
- **`profiles.nickname` uniqueness is case-insensitive**, via a functional unique index on `lower(nickname)`, not a plain `unique` constraint. A plain constraint caused real login failures in testing — mobile keyboards auto-capitalize the first letter by default, so "kchpomp" typed at registration and "Kchpomp" typed at login (via autocapitalize) wouldn't match. The nickname `<input>` fields also have `autocapitalize="off" autocorrect="off" spellcheck="false"` for the same reason.
- **`get_leaderboard()` is a function, not a view.** Postgres views run with their owner's privileges by default, silently bypassing RLS — Supabase's own linter flags this pattern (`security_definer_view`). The bypass is genuinely needed (a leaderboard has to aggregate every participant's points, not just the caller's own row), so it's made explicit in a function instead, scoped to return only `display_name` + `total_points` — never raw `station_visits` rows, which would leak individual movement/timing data.
- **`scan_station()` had a real, since-fixed bug**: its `RETURNS TABLE` declares an output column named `points_awarded`, and PL/pgSQL exposes `RETURNS TABLE` columns as implicit variables throughout the function body — so a reference to `station_visits.points_awarded` inside the function was ambiguous with that output variable. Fixed via a table alias (`station_visits sv`, then `sv.points_awarded`). Any future PL/pgSQL function with an output column name that might also exist as a real table column needs the same care.
- **`flowType: 'pkce'` is required** in `supabaseClient.js`. The app's router is hash-based (`#dashboard`, `#scan`, ...); Supabase's *default* auth flow also delivers session tokens via a URL hash fragment (`#access_token=...`) after an email confirmation click, which collides with the router and would strand the user on an unrecognized route instead of the dashboard. PKCE moves that to a `?code=...` query parameter instead, which doesn't touch the hash. Don't remove this without solving that collision another way.
- **QR camera scanning uses `Html5Qrcode` directly, not `Html5QrcodeScanner`**, with `{ facingMode: 'environment' }`. This was a deliberate choice to skip the multi-camera picker dropdown that `Html5QrcodeScanner` shows by default — participants just get the rear camera immediately.
- **Desktop/file-based QR testing** uses `Html5Qrcode.scanFile()` via a dedicated file input, rather than relying on `Html5QrcodeScanner`'s built-in (inconsistent) file-scan toggle.
- **Every `security definer` function sets `search_path = ''`** — hardening against search-path hijacking, and required to pass Supabase's own database linter cleanly.
- **Explicit `revoke`/`grant` statements exist on every table and function**, rather than relying solely on Supabase's default privileges + RLS. Defense in depth: makes the access model auditable directly from the SQL, and adds a second layer if RLS is ever accidentally disabled on a table.
- **`station_visits` has no `created_at`** — only `scanned_at`. An earlier draft had both; they were always identical (a visit is only ever created at scan time), so `created_at` was dropped as redundant.
- **QR tokens (`stations.qr_token`) must be random** (`gen_random_uuid()::text`), never sequential/human-guessable strings — an early test seed used `'test-station-001'`-style tokens, which would let someone guess other stations' tokens and claim points without visiting them.

## Known bugs already fixed — don't reintroduce

- **Blank deployed page**: caused by missing/misnamed GitHub repo secrets (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`), which made `createClient()` throw at import time, crashing the whole script before anything rendered. Also possible if Settings → Pages → Source isn't set to "GitHub Actions."
- **`Uncaught Error: supabaseUrl is required`**: same root cause as above.
- **`Failed to execute 'fetch' ... non ISO-8859-1 code point`**: a malformed/corrupted `VITE_SUPABASE_ANON_KEY` GitHub secret (stray character from a copy-paste), since the anon key ends up in the `apikey`/`Authorization` HTTP headers on every request, and header values are restricted to Latin-1. Fixed by re-copying the key cleanly and replacing the secret.
- **Yandex SMTP username misconfigured**: was set to a project/password-like string instead of the actual mailbox address. Yandex SMTP auth requires the **full email address** as the username, not an arbitrary label.
- **The live GitHub repo lagging behind the design conversation**: at one point the actual deployed `main.js` was still the old English, single-combined-auth-form version, while testing/debugging was happening against the *intended* new version described in chat — they'd diverged because changes were being discussed/written here but not always actually pushed to the repo. Always verify the live repo's actual file contents before debugging further, rather than assuming the latest discussed version is what's deployed.

## Outstanding / not yet built

- **Password reset ("forgot password") flow** — not implemented in the frontend.
- **Admin UI beyond Supabase Studio** — event/station creation and manual visit overrides are done manually via Studio's Table Editor; no custom admin panel exists.
- **Landing page visual design** — currently functional but plain (single centered card, flat background). A redesign was discussed (hero visual, better typography, branded color, 3-step explainer) but not implemented.
- **Verify current SMTP + secrets state**: multiple credential issues were found and fixed over the course of this project (SMTP username, GitHub secrets); worth confirming current state is actually correct rather than assuming past fixes are still in place, especially if picking this up after a gap.

## Repo structure

```
event-station-tracker/
├── .github/workflows/deploy.yml   # GitHub Actions -> GitHub Pages
├── index.html
├── package.json
├── vite.config.js                 # base: '/event-station-tracker/' — must match repo name
├── src/
│   ├── main.js                    # entire app: router + all screens
│   ├── supabaseClient.js          # createClient with flowType: 'pkce'
│   └── style.css
```

No `supabase/migrations/` folder currently exists in the repo — schema changes have been applied by hand via the Supabase SQL Editor throughout this project, tracked in conversation/markdown files rather than versioned migration files. Worth setting up properly (`supabase migration new ...`) if this project continues to evolve.

## Reference docs from this project's design conversation

- **`production_setup.md`** — the authoritative, current "run this now" SQL + config reference. Use this over any of the below for exact current schema state.
- `supabase_github_pages_guide.md` — the detailed step-by-step build guide (schema walkthrough, frontend code, troubleshooting, GitHub Pages setup). Some SQL in it has been superseded by `production_setup.md`; useful for the *explanations* it contains, not as the SQL source of truth.
- `yandex_cloud_supabase_build_guide.md`, `beget_supabase_guide.md`, `local_dev_guide.md` — exploratory guides for self-hosted architectures that were ultimately **not adopted**. Kept for reference only, in case self-hosting is revisited later.
- `event_station_tracking_system_design.md` — the original Django-based design document. Fully superseded architecturally; may still contain useful business-rule/requirements thinking (e.g. concurrency test expectations, security review notes) independent of the tech stack.

## Environment/secrets reference (names only)

- **GitHub repo secrets** (Settings → Secrets and variables → Actions): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- **Supabase dashboard**: Authentication → SMTP Settings (Yandex), Authentication → URL Configuration (Site URL + Redirect URLs must match the GitHub Pages URL exactly), Authentication → Email Templates → Confirm signup (Russian template).

## Testing conventions established

- The seeded test event is named `'Test Event'` — new test stations should look it up by name (`where name = 'Test Event' order by created_at desc limit 1`) rather than inserting a duplicate event.
- A manual email-confirmation escape hatch exists for testing without waiting on SMTP: `update auth.users set email_confirmed_at = now() where email = '...';` — testing convenience only, not a substitute for working SMTP before the real event.
