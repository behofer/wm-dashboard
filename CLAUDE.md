# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

An **accessible (screen-reader-first) dashboard for the FIFA World Cup 2026**
(USA · Canada · Mexico, 11 June – 19 July 2026). It is built to WCAG 2.1 AA
practices and is the central artifact of the project.

The whole frontend is **one self-contained `index.html`** — no build step, no
dependencies, no framework, no tracking, no cookies, no local storage. You can
open it by double-clicking, drop it on any static host, or render it as an
artifact. An **optional** `server.js` is a zero-dependency Node proxy that adds
official, key-protected live data.

## Layout

```
wm-dashboard/
├── index.html   # the ENTIRE dashboard — HTML + CSS + JS in one file (~1040 lines)
├── server.js    # optional zero-dependency Node proxy for official live data
├── README.md    # product/usage/accessibility overview
├── CLAUDE.md    # this file
└── mnt/user-data/outputs/wc2026-dashboard/backend/README.md   # proxy deploy guide
```

> Note: `server.js` lives at the repo root here, but the docs refer to a
> `backend/` folder. They are the same file; the backend README is under
> `mnt/.../backend/`.

## Architecture (the part that matters)

Everything below lives inside `index.html`. Key anchors (line numbers drift —
grep the identifier, don't trust the number):

- **`TEAMS`** (~line 326) — all 48 teams as `[code, en, de, group, conf, pot]`,
  mapped to objects `{code, en, de, group, conf, pot}`. `code` is the canonical
  3-letter id used everywhere.
- **`GROUPS`** (~342) — `"A".."L"`, the 12 groups.
- **`CONFIRMED`** (~346) — researched real fixtures: ISO-UTC kickoff, a
  human `local` string, `venue`, matchday `md`, `opening` flag, and `freeTv`
  (German free-to-air broadcasters). Only the confirmed opening fixtures are
  listed; the rest are generated.
- **`MODEL`** (~362) — the in-memory single source of truth:
  `{ source, asOf, teams{}, groups{}, matches[] }`. `source` is `"snapshot"`,
  `"live"`, or `"loading"`.
- **`buildFixtures()`** (~374) — generates the full round-robin group-stage
  fixture list per group using the standard WC pairing order, then overlays any
  `CONFIRMED` details onto matching pairs. Matches carry
  `{id, group, stage, md, a, b, utc, local, venue, status, scoreA, scoreB, minute, events, stats}`.
- **`recomputeStandings()`** (~410) — recomputes W/D/L, GF/GA/GD, points purely
  from match scores in `MODEL`. **Live matches are counted provisionally.**
  Standings are never fetched; they are always derived locally so they stay
  consistent with whatever data source is active.

### Data provider (best-effort live overlay)

- **`SOURCES`** (~496) — the live feeds, each overridable via a `window.*` global
  set *before* the script runs. `openfootball` is resolved by
  `defaultOpenfootball()`: an explicit `window.WC2026_OPENFOOTBALL_URL` wins;
  otherwise, when served over **http(s)** it defaults to the same-origin proxy
  `/worldcup.json` (so "just run server.js" works), and only falls back to the
  public raw JSON when opened from `file://`.
  - `WC2026_OPENFOOTBALL_URL` → openfootball/worldcup.json shape
  - `WC2026_WC26_GAMES_URL`, `WC2026_WC26_GROUPS_URL` → worldcup26.ir feeds
- **`loadData()`** (~579) — the main network entry point. Fetches the primary
  openfootball-shaped feed (proxy or public), and if that yields nothing tries
  the public openfootball feed as a fallback, then overlays the worldcup26.ir
  live games. Overlays scores/status/utc + upstream ids onto `MODEL`, recomputes
  standings, sets `MODEL.source`, re-renders, announces. Also **ingests knockout
  fixtures**: feed matches whose `stage !== "group"` are added as new `MODEL.matches`
  (group fixtures pre-exist and are matched by team pair).
- **Refresh model** — the heavy lifting is **server-side**: the proxy polls
  API-Football on an adaptive timer and serves every visitor from a warm cache,
  so no user/bot request costs upstream quota. The client calls `loadData()` once
  on load (`boot()`), on explicit Refresh, and via `liveTick()` — a light poll of
  the cheap server cache every 60s **only while a match is live and the tab is
  visible** (`startLivePolling`). No client poll hits upstream.
- **`NAME2CODE` / `code()`** (~505) — fuzzy team-name → code resolver, normalized
  (accent/case-insensitive) with hand-maintained aliases (e.g. "Czech Republic",
  "IR Iran", "Türkiye"). Any new team-name spelling from a feed must resolve here
  or its score is silently dropped.

### Routing & views

Hash-based router. `renderRoute()` (~641) dispatches on `location.hash`:
`home`, `groups`, `group/:id`, `matches`, `rounds`, `match/:id`, `teams`,
`team/:code`, `player/:id`. Each `view*()` function renders into `<main>`. Nav
links carry `data-route`; drill-down buttons carry `data-go`. (There is no
"About & data" view and no footer — the app deliberately surfaces no API/data
-source internals in the UI.)

- **Rounds** (`viewRounds`) — group-stage link + the knockout schedule from the
  static `KO_ROUNDS` table (official 2026 dates; Final at MetLife). Real KO
  pairings/scores appear automatically once the feed publishes them.
- **Player** (`viewPlayerDetail`) — opened from a clickable squad player; lazily
  fetches the proxy `/player` endpoint (full first/last name, birth date/place,
  club, nationality, height/weight). `PLAYER_TEAM`/`PLAYER_NAME`/`PLAYER_CACHE`
  maps are populated as squads load (so the page can link back to the team).

### Internationalization

- **`I18N`** (~246) — `{ en: {...}, de: {...} }` string tables.
- `STATE.lang`, `dict()`, `t(key)`, `nameOf(code)` resolve the active language.
- Switching language updates the document `lang` attribute so screen readers
  switch pronunciation. German mode additionally surfaces **German TV listings**
  (MagentaTV for all matches; ARD/ZDF for Germany's games, opener, semis, final).

## Accessibility — DO NOT REGRESS

This is the project's core value. Any change must preserve:

- Semantic landmarks (`header`/`nav`/`main`/`footer`), a single `h1`, logical
  heading order per view.
- Skip link to main, full keyboard operability, visible focus rings
  (`--focus` token), `Esc` to go back.
- On navigation, focus moves to the new view's heading and `document.title`
  updates.
- A polite live region (`role="status"`) announces score/status/view changes —
  scoped, never re-reading whole panels.
- Standings are a real `<table>` with `<caption>`, `scope`-d headers, and
  abbreviation expansions (e.g. "GD" → "Goal difference").
- Every drill-down is a real `<button>` with a descriptive `aria-label`.
- No meaning conveyed by color alone. Honor `prefers-reduced-motion` and
  light/dark/system themes.

When editing, verify with a screen reader / keyboard-only pass, not just visually.

## Conventions

- Vanilla JS, no dependencies, terse style. Match the surrounding idiom
  (short helper functions, `esc()` for any user/feed-derived string going into
  HTML, single-quote-free template strings where practical).
- Team identity flows through `code` (3-letter). Use `nameOf(code)` to display.
- All times stored UTC (`utc`), rendered in the viewer's local zone.
- Never introduce a build step, a framework, network polling, cookies, storage,
  or analytics. The single-file, zero-dependency, no-tracking nature is a feature.

## The backend proxy (`server.js`)

Zero-dependency Node 18+ server (built-ins only — no `npm install`). It holds a
secret football-API key in an env var, calls the upstream **API-Football**
(`v3.football.api-sports.io`) server-side, and re-serves it with permissive CORS,
**normalized to the openfootball/worldcup.json shape** the frontend already
understands. The frontend degrades gracefully if it is absent or blocked.

- Endpoints: `GET /` and `/index.html` (serves the dashboard `index.html` from
  disk, so visiting `http://localhost:PORT` shows the page), `GET /worldcup.json`
  (normalized fixtures — each match also carries the upstream `id` and team
  `id`s), `GET /fixture?id=<fixtureId>` (on-demand **statistics + line-ups +
  events** for one match, normalized to `{home,away,stats[],lineups{home,away},
  events[]}`), `GET /squad?team=<teamId>` (on-demand squad `{team,players[]}`),
  `GET /player?id=<playerId>` (full player profile `{firstname,lastname,birth,
  nationality,height,weight,clubs[],…}` — combines `/players/profiles` +
  `/players?id=&season=PLAYER_CLUB_SEASON` for the club), `GET /health`. The
  frontend lazily calls `/fixture` (match opened), `/squad` (team opened) and
  `/player` (squad player opened) via `ensureMatchDetail`/`ensureSquad`/`ensurePlayer`,
  gated on the `PROXY` constant.
- **Active polling**: a background `pollFixtures()` loop refreshes the fixtures
  cache on an adaptive timer (30s while a match is live, 60s near kickoffs, 10min
  idle) so `/worldcup.json` is always served from a warm cache and user/bot
  requests never trigger upstream. `/fixture` TTL is status-aware (20s live, 6h
  finished). `/squad` and `/player` cache 6h.
- **Anti-abuse**: `/fixture`, `/squad`, `/player` only serve ids that exist in the
  tournament (`validFixtureIds`/`validTeamIds` from each poll, `validPlayerIds`
  registered as squads load) — so a bot can't make us enumerate arbitrary ids
  upstream. Plus a small per-IP token bucket (`rateOk`, honours `X-Forwarded-For`).
- When served by `server.js` (i.e. over http(s)), `index.html` **automatically**
  routes through the same-origin proxy `/worldcup.json` — no edit or uncomment
  needed (`defaultOpenfootball()` handles it). If the proxy returns nothing, the
  frontend falls back to the public openfootball feed + worldcup26.ir live.
  Opened from `file://`, it uses the public feeds directly. This project runs on
  a **PAID API-Football plan** (the FREE plan has no 2026 data), so the proxy
  serves real official 2026 fixtures/scores.
- To swap providers, edit only `fetchUpstream()` and `normalize()` — keep the
  output shape `{ rounds: [ { name, matches: [ { date, time, group,
  team1:{name}, team2:{name}, score:{ ft:[h,a] }, status, minute, venue } ] } ] }`
  where `status` ∈ `scheduled | live | finished`.
- In-memory 30s cache protects free-tier rate limits.

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `API_FOOTBALL_KEY` | _(none)_ | api-sports.io key (required for live data) |
| `API_FOOTBALL_HOST` | `v3.football.api-sports.io` | Upstream host |
| `WC_LEAGUE_ID` | `1` | World Cup league id |
| `WC_SEASON` | `2026` | Season |
| `CACHE_TTL_MS` | `30000` | Fixtures cache window (also poll floor) |
| `ALLOW_ORIGIN` | `*` | Restrict to your origin in production |
| `LIVE_POLL_MS` | `30000` | Background poll interval while a match is live |
| `SOON_POLL_MS` | `60000` | Poll interval within ~2h of a kickoff |
| `IDLE_POLL_MS` | `600000` | Poll interval when nothing is near |
| `DETAIL_TTL_MS` | `300000` | Cache for scheduled-match detail |
| `PLAYER_CLUB_SEASON` | `2025` | Season used to resolve a player's club |
| `RL_BURST` / `RL_REFILL_PER_SEC` | `30` / `3` | Per-IP rate limit for detail endpoints |

## Run / develop

**Frontend only (no key needed):** just open `index.html`. It runs on the
verified bundled snapshot and best-effort public feeds.

**With official live data:**

```powershell
# PowerShell (Windows)
$env:API_FOOTBALL_KEY = "<your-key>"; node server.js
# -> WC2026 proxy on :8787  ->  GET /worldcup.json  (key set)
```

```bash
# bash / macOS / Linux
API_FOOTBALL_KEY=<your-key> node server.js
```

Then add one line before the dashboard `<script>` in `index.html` (or inject at
your host):

```html
<script>window.WC2026_OPENFOOTBALL_URL = "http://localhost:8787/worldcup.json";</script>
```

Smoke-test the proxy:

```
curl http://localhost:8787/health
curl http://localhost:8787/worldcup.json
```

Without a key the proxy returns `{ "rounds": [] }` (or a 502 with empty rounds)
on purpose — the dashboard falls back to the snapshot and announces it.

> Requires Node 18+. If `node` is missing on Windows:
> `winget install OpenJS.NodeJS.LTS`.

## Gotchas

- `League id 1` is API-Football's World Cup. This project uses a **PAID plan**,
  so `season=2026` returns the real tournament (72 group fixtures, live
  scores/status/minute). The FREE plan only exposes seasons 2022–2024 and would
  yield `rounds: []` (the dashboard then falls back to the bundled snapshot).
- A feed score is applied only if BOTH team names resolve through `code()` and
  the pair matches an existing `MODEL.matches` entry — otherwise it's dropped
  silently. New spellings need a `NAME2CODE` alias. Note API-Football spells some
  teams differently than the snapshot (e.g. "Cape Verde Islands", "Congo DR") —
  those aliases are already mapped.
- Standings count live matches provisionally; they will shift as scores change.
- Times are **always** rendered in the viewer's own zone via `kickoffText()`
  (from `utc` only — the bundled `local` venue-time strings are no longer shown).
  A one-line `tzLabel()` hint in the status bar states the zone (e.g. "MESZ").
- **Knockout fixtures don't exist in API-Football until the group stage ends**
  (pairings are TBD). Until then the Rounds view shows the static `KO_ROUNDS`
  schedule; `normalize()` tags each fixture with a `stage`, and the frontend
  ingests real KO matches automatically when they appear. KO ingestion has been
  verified with a synthetic feed but not against live API data yet.
- Squad lists show the source's abbreviated names ("O. Baumann"); full first
  names + birth date + club are on the per-player page (`/player`). Enriching the
  whole list would cost one upstream call per player — deliberately avoided.
- Daily budget is ~7,500 upstream requests. The server poller spends roughly
  1,500–3,000/day (adaptive); on-demand detail/squad/player calls are id-bounded
  and cached. Client polls hit only the warm server cache, never upstream.
