# FIFA World Cup 2026 — Accessible Dashboard

A 100% screen-reader-accessible dashboard for the 2026 FIFA World Cup
(USA · Canada · Mexico, 11 June – 19 July 2026). Single self-contained
`index.html` — no build step, no dependencies, no tracking, no storage. Open it
locally, drop it on any static host, or run it as an artifact.

---

## What it does

- **"Now" view** — always surfaces the most relevant match (a live match if one
  is playing, otherwise the next kickoff, otherwise the latest result) with
  score, status, kickoff time, and venue.
- **Manual refresh only** — the dashboard never polls on a timer. Opening the
  page makes no API call; live scores are fetched only when you press
  **“Refresh live scores.”** This keeps usage to one request per explicit
  refresh, so a free-tier API key stays practical. Match clocks/status are
  recomputed locally (no network) as you navigate.
- **Groups** — all 12 groups; open one for a live-computed standings table
  (played, W/D/L, goals for/against, goal difference, points) plus group stats
  (goals, average, current leader).
- **Matches** — open any match for full detail: score, status/minute, matchday,
  kickoff, venue, events, and a statistics section that fills in for live and
  finished matches.
- **Teams** — open any of the 48 teams for its info, tournament stats, and squad
  section.
- **English & German** — full UI translation; auto-detects from the browser and
  can be toggled. The page's `lang` attribute updates so screen readers switch
  pronunciation.
- **German TV listings** — when the language is German, each match shows where to
  watch it in Germany (MagentaTV for all 104 matches; ARD/ZDF free-to-air for
  Germany's games, the opener, both semi-finals, and the final).

---

## Accessibility

Built to WCAG 2.1 AA practices, verified for screen-reader use:

- Semantic landmarks (`header`/`nav`/`main`/`footer`), a single `h1`, and a
  logical heading order in every view.
- A **skip link** to main content, full keyboard operability, and visible focus.
- On navigation, focus moves to the new view's heading and the document title
  updates, so screen-reader users are oriented immediately.
- A dedicated polite live region (`role="status"`) announces score changes,
  match-status changes, and view changes — without re-reading whole panels.
- Standings are a **real `<table>`** with a `<caption>`, `scope`-d headers, and
  abbreviation expansions (e.g. "GD" → "Goal difference").
- Every drill-down is a real `<button>` with a descriptive `aria-label`
  ("View Group A", "Match details: Germany versus Curaçao", …).
- `Esc` goes back. No meaning is conveyed by color alone. High-contrast palette,
  with light/dark/system themes and `prefers-reduced-motion` respected.

---

## Where the data comes from

An in-browser page can't hold a secret API key, and an artifact sandbox may block
outbound network calls. The dashboard is designed around that:

1. **Verified snapshot (always present).** The confirmed 48 teams, all 12 final
   groups (including the resolved March 2026 playoff winners), and the confirmed
   opening fixtures are bundled in. This is the correct floor — it works with no
   network at all.
2. **Best-effort live overlay.** On load, the page tries public,
   CORS-friendly sources (the openfootball/worldcup.json dataset, and an open
   community feed) and overlays any live scores/results it gets.
3. **Official live data (optional, recommended).** Run the included backend
   proxy (`backend/`) to serve an official, key-protected API. The page reads it
   if present.

Whatever the source, the dashboard **announces it** — "Live data" with a
timestamp, or "Verified snapshot" — so a screen-reader user always knows how
fresh the numbers are. If a live fetch is blocked (e.g. artifact CSP), it simply
falls back to the snapshot and says so.

---

## Hosting

**Open locally** — double-click `index.html`. Done.

**Any static host** — upload `index.html` to Netlify, GitHub Pages, S3, nginx,
or any web server. No build, no config.

**As an artifact** — the file renders directly.

### Turning on official live data

1. Deploy the proxy in [`backend/`](backend/README.md) (one Node file, no
   dependencies) with your official API key in an environment variable.
2. Add one line before the dashboard script:
   ```html
   <script>window.WC2026_OPENFOOTBALL_URL = "https://your-proxy-host/worldcup.json";</script>
   ```

That's it — the secret key stays on the server, the static page stays hostable
anywhere, and live official data flows in.

---

## Project layout

```
wc2026-dashboard/
├── index.html          # the entire dashboard (open or host this)
├── README.md           # this file
└── backend/
    ├── server.js       # zero-dependency official-API proxy
    └── README.md       # deploy-anywhere proxy instructions
```

---

## Notes

- Times are stored in UTC and rendered in the viewer's local time zone.
- Standings and stats are computed in the browser from match results, so they
  stay consistent with whatever data source is active.
- No analytics, cookies, or local storage are used.
