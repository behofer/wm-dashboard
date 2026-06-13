# WC 2026 Dashboard — Backend Proxy

A tiny, **zero-dependency** Node server (built-ins only — no `npm install`) that
turns an official, key-protected football API into a feed the static dashboard
can read directly from the browser.

It exists so the project can satisfy two requirements at once:

1. **"Use official APIs in the backend."** The secret API key lives here, in an
   environment variable, and is never sent to the browser.
2. **"Host it anywhere."** The dashboard stays a single static file; this proxy
   is optional and can run on any host that runs Node.

The proxy normalizes the upstream response to the **same shape** as the
[`openfootball/worldcup.json`](https://github.com/openfootball/worldcup.json)
dataset the frontend already understands, so **no frontend code changes** are
needed — you only point one URL at it.

---

## 1. Run it locally

Requires Node 18 or newer.

```bash
cd backend
API_FOOTBALL_KEY=your_key_here node server.js
# -> WC2026 proxy on :8787  ->  GET /worldcup.json  (key set)
```

Check it:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/worldcup.json
```

Without a key, `/worldcup.json` returns `{ "rounds": [] }`. That is intentional:
the dashboard simply falls back to its verified bundled snapshot and tells the
user so. Nothing breaks.

---

## 2. Point the dashboard at it

The dashboard reads an optional global. Add **one line** before the dashboard's
own `<script>` in `index.html` (or inject it at your host/CDN):

```html
<script>
  window.WC2026_OPENFOOTBALL_URL = "https://your-proxy-host/worldcup.json";
</script>
```

That's the only wiring needed. The page will fetch live official data from your
proxy, overlay it on the verified snapshot, and announce "live" + a timestamp to
screen-reader users. If the proxy is ever down, it announces the snapshot
fallback instead.

> Optional extra feeds the frontend also recognizes (leave unset to ignore):
> `window.WC2026_WC26_GAMES_URL`, `window.WC2026_WC26_GROUPS_URL`.

---

## 3. Choosing / swapping the upstream API

The default upstream is **API-Football** (`api-sports.io`), official-grade with
live in-play data. To use a different provider, edit two functions in
`server.js`:

- `fetchUpstream()` — make the authenticated request to your provider.
- `normalize()` — map the provider's JSON to the openfootball shape:
  `{ rounds: [ { name, matches: [ { date, time, group, team1:{name},
  team2:{name}, score:{ ft:[h,a] }, status, minute, venue } ] } ] }`
  where `status` is one of `scheduled` | `live` | `finished`.

As long as `normalize()` returns that shape, the dashboard works unchanged.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `API_FOOTBALL_KEY` | _(none)_ | Your api-sports.io key (required for live data) |
| `API_FOOTBALL_HOST` | `v3.football.api-sports.io` | Upstream host |
| `WC_LEAGUE_ID` | `1` | World Cup league id at the provider |
| `WC_SEASON` | `2026` | Season |
| `CACHE_TTL_MS` | `30000` | In-memory cache to respect rate limits |
| `ALLOW_ORIGIN` | `*` | Restrict to your site's origin in production |

A 30-second cache is deliberate: live scores don't need sub-30s polling, and it
keeps you comfortably inside typical free-tier rate limits. Because the
dashboard fetches only on an explicit user refresh (no background polling),
upstream calls are driven by how often people press the button — and repeated
presses within the cache window are served from memory, costing nothing
upstream. In practice a single viewer can follow a whole match on a free-tier
key.

---

## 4. Deploy anywhere

It's one file with no dependencies, so almost any host works.

**Render / Railway / Fly.io / a VPS**

- Start command: `node server.js`
- Set env var `API_FOOTBALL_KEY` (and `ALLOW_ORIGIN` to your site).
- No build step.

**Docker**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server.js .
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
```

```bash
docker build -t wc2026-proxy .
docker run -e API_FOOTBALL_KEY=your_key -p 8787:8787 wc2026-proxy
```

**systemd (VPS)** — point `ExecStart` at `node /app/server.js`, set
`Environment=API_FOOTBALL_KEY=...`, and put nginx/Caddy in front for TLS.

---

## Endpoints

| Path | Returns |
|---|---|
| `/worldcup.json` | Live fixtures normalized to openfootball shape |
| `/health` | `{ ok, hasKey, ttlMs }` for uptime checks |

All responses include permissive CORS headers so the static dashboard can read
them from any origin.
