#!/usr/bin/env node
/*
 * FIFA World Cup 2026 — Accessible Dashboard
 * Official-API backend proxy (zero dependencies, Node 18+ built-ins only).
 *
 * WHY THIS EXISTS
 * ----------------
 * The dashboard (index.html) is a static, self-contained file. A browser
 * artifact cannot hold a secret API key, and many official football APIs
 * require one. This proxy is the "backend" half: it holds the key in an
 * environment variable (never shipped to the browser), calls the official
 * API server-side, and re-serves the data:
 *   - with permissive CORS so the static page can read it from anywhere, and
 *   - normalized to the SAME shape as the openfootball/worldcup.json dataset
 *     the frontend already understands, so NO frontend code changes are needed.
 *
 * Point the frontend at this proxy by defining, before the dashboard script:
 *     <script>window.WC2026_OPENFOOTBALL_URL = "https://your-host/worldcup.json";</script>
 * (see backend/README.md).
 *
 * The frontend degrades gracefully: if this proxy is absent or blocked, it
 * falls back to its verified bundled snapshot and announces the data source
 * to screen-reader users. So running this is OPTIONAL but gives true live,
 * official data.
 *
 * SUPPORTED UPSTREAM (default): API-Football (api-sports.io), a widely used
 * official-grade source. Swap fetchUpstream()/normalize() for any provider;
 * as long as normalize() returns the openfootball shape, the page just works.
 *
 * ENV VARS
 *   PORT              default 8787
 *   API_FOOTBALL_KEY  your api-sports.io key (required for live data)
 *   API_FOOTBALL_HOST default v3.football.api-sports.io
 *   WC_LEAGUE_ID      default 1  (API-Football's World Cup league id)
 *   WC_SEASON         default 2026
 *   CACHE_TTL_MS      default 30000 (be kind to rate limits; 30s is plenty)
 *   ALLOW_ORIGIN      default *  (restrict to your site in production)
 *
 * RUN
 *   API_FOOTBALL_KEY=xxxx node server.js
 * Then open: http://localhost:8787/worldcup.json
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// The static dashboard, served at "/" so visiting the proxy shows the page.
const INDEX_HTML = path.join(__dirname, 'index.html');

const PORT = parseInt(process.env.PORT || '8787', 10);
const API_KEY = process.env.API_FOOTBALL_KEY || '';
const API_HOST = process.env.API_FOOTBALL_HOST || 'v3.football.api-sports.io';
const LEAGUE_ID = process.env.WC_LEAGUE_ID || '1';
const SEASON = process.env.WC_SEASON || '2026';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '30000', 10);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
// Season whose statistics carry a player's CLUB (national-team seasons don't).
const PLAYER_CLUB_SEASON = process.env.PLAYER_CLUB_SEASON || '2025';

// ---- active background polling intervals (keep the cache warm server-side) ----
// The server refreshes fixtures on its own schedule so user/bot requests are
// always served from a warm cache and never cost upstream quota. Adaptive:
// fast while a match is live, medium around kickoffs, slow when idle.
const LIVE_POLL_MS = parseInt(process.env.LIVE_POLL_MS || '30000', 10); // 30s
const SOON_POLL_MS = parseInt(process.env.SOON_POLL_MS || '60000', 10); // 60s
const IDLE_POLL_MS = parseInt(process.env.IDLE_POLL_MS || '600000', 10); // 10 min

// ---- tiny in-memory cache (protects upstream rate limits) ----
// Keyed cache so fixtures, per-match detail, squads and players cache independently.
const caches = new Map();
// Detail (stats/lineups/squads/players) changes slowly; cache longer than live scores.
const DETAIL_TTL_MS = parseInt(process.env.DETAIL_TTL_MS || '300000', 10); // 5 min
const DETAIL_LIVE_TTL_MS = 20000; // live match detail: 20s
const DETAIL_DONE_TTL_MS = 21600000; // finished match / player bio: 6h (won't change)
function cacheGet(key, ttl) {
  const c = caches.get(key);
  return c && Date.now() - c.at < ttl ? c.body : null;
}
function cacheSet(key, body) {
  caches.set(key, { at: Date.now(), body });
  return body;
}

// ---- valid-id sets (built from each fixtures poll) — anti-abuse guard so a bot
// can't make us call upstream for arbitrary ids. Only real tournament entities
// (the 72 fixtures, their teams, and players seen in fetched squads) are allowed.
const validFixtureIds = new Set();
const validTeamIds = new Set();
const validPlayerIds = new Set();
const fixtureStatus = new Map(); // fixtureId -> scheduled|live|finished
let fixtureMeta = []; // [{ kickoffMs }]
function indexIds(norm) {
  validFixtureIds.clear();
  validTeamIds.clear();
  fixtureStatus.clear();
  fixtureMeta = [];
  for (const rd of norm.rounds || []) {
    for (const m of rd.matches || []) {
      if (m.id != null) {
        validFixtureIds.add(String(m.id));
        fixtureStatus.set(String(m.id), m.status);
      }
      if (m.team1 && m.team1.id != null) validTeamIds.add(String(m.team1.id));
      if (m.team2 && m.team2.id != null) validTeamIds.add(String(m.team2.id));
      const koMs = m.date ? Date.parse(m.date + 'T' + (m.time || '00:00') + ':00Z') : NaN;
      if (!isNaN(koMs)) fixtureMeta.push({ kickoffMs: koMs });
    }
  }
}

// ---- minimal per-IP token bucket for the upstream-capable endpoints ----
const RL_BURST = parseInt(process.env.RL_BURST || '30', 10);
const RL_REFILL_PER_SEC = parseFloat(process.env.RL_REFILL_PER_SEC || '3');
const rlBuckets = new Map();
function rateOk(ip) {
  const now = Date.now();
  let b = rlBuckets.get(ip);
  if (!b) { b = { tokens: RL_BURST, ts: now }; rlBuckets.set(ip, b); }
  b.tokens = Math.min(RL_BURST, b.tokens + ((now - b.ts) / 1000) * RL_REFILL_PER_SEC);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=15',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

// ---- upstream fetch (API-Football) ----
// Generic keyed GET against API-Football, used for fixtures and the on-demand
// statistics / lineups / events / squads endpoints.
function apiGet(pathAndQuery) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      reject(new Error('API_FOOTBALL_KEY not set'));
      return;
    }
    const req = https.request(
      { method: 'GET', host: API_HOST, path: pathAndQuery, headers: { 'x-apisports-key': API_KEY } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Upstream returned non-JSON'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Upstream timeout')));
    req.end();
  });
}
function fetchUpstream() {
  return apiGet(`/fixtures?league=${encodeURIComponent(LEAGUE_ID)}&season=${encodeURIComponent(SEASON)}`);
}

// ---- normalize API-Football -> openfootball/worldcup.json shape ----
// openfootball shape the frontend consumes:
//   { name, rounds: [ { name, matches: [ {
//       date, time, group, team1:{name}, team2:{name},
//       score:{ ft:[h,a] }, status, minute } ] } ] }
function normalize(apiFootball) {
  const list = (apiFootball && apiFootball.response) || [];
  const byRound = new Map();

  for (const item of list) {
    const fx = item.fixture || {};
    const lg = item.league || {};
    const teams = item.teams || {};
    const goals = item.goals || {};
    const roundName = lg.round || 'Group stage';

    // Derive a group label like "Group A" if present in round text.
    let group = '';
    const gm = /group\s+([a-l])/i.exec(roundName);
    if (gm) group = 'Group ' + gm[1].toUpperCase();

    // Derive a stage tag from the round text so the frontend can ingest knockout
    // fixtures (group fixtures already match by team pair).
    const r = roundName.toLowerCase();
    let stage = 'group';
    if (/3rd|third|place/.test(r)) stage = 'third';
    else if (/\bfinal\b/.test(r) && !/semi|quarter/.test(r)) stage = 'final';
    else if (/semi/.test(r)) stage = 'sf';
    else if (/quarter/.test(r)) stage = 'qf';
    else if (/16/.test(r)) stage = 'r16';
    else if (/32/.test(r)) stage = 'r32';

    const dt = fx.date ? new Date(fx.date) : null;
    const date = dt ? dt.toISOString().slice(0, 10) : '';
    const time = dt ? dt.toISOString().slice(11, 16) : '';

    const st = (fx.status && fx.status.short) || 'NS';
    // Map upstream status -> frontend vocabulary.
    let status = 'scheduled';
    if (['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(st)) status = 'live';
    else if (['FT', 'AET', 'PEN'].includes(st)) status = 'finished';

    const match = {
      id: fx.id,
      date,
      time,
      group,
      stage,
      team1: { name: (teams.home && teams.home.name) || '', id: teams.home && teams.home.id },
      team2: { name: (teams.away && teams.away.name) || '', id: teams.away && teams.away.id },
      status,
      minute: (fx.status && fx.status.elapsed) || null,
      venue: (fx.venue && (fx.venue.name || '')) || '',
      score: {},
    };
    if (goals.home != null && goals.away != null) {
      match.score.ft = [goals.home, goals.away];
    }

    if (!byRound.has(roundName)) byRound.set(roundName, []);
    byRound.get(roundName).push(match);
  }

  const rounds = [];
  for (const [name, matches] of byRound) rounds.push({ name, matches });
  return { name: 'FIFA World Cup 2026', rounds, _source: 'api-football', _asOf: new Date().toISOString() };
}

async function getNormalized() {
  // Serve whatever the background poller last stored — user requests never block
  // on or trigger upstream once the cache is warm. Cold start: fetch once.
  const hit = cacheGet('fixtures', Infinity);
  if (hit) return hit;
  const norm = normalize(await fetchUpstream());
  indexIds(norm);
  return cacheSet('fixtures', JSON.stringify(norm));
}

// ---- background poller: refreshes fixtures on an adaptive schedule ----
let pollTimer = null;
let lastPollOk = 0;
function anyLive() {
  for (const s of fixtureStatus.values()) if (s === 'live') return true;
  return false;
}
function nextPollDelay() {
  if (!API_KEY) return IDLE_POLL_MS;
  if (anyLive()) return LIVE_POLL_MS;
  const now = Date.now();
  for (const m of fixtureMeta) {
    if (m.kickoffMs && Math.abs(m.kickoffMs - now) < 2 * 3600000) return SOON_POLL_MS;
  }
  return IDLE_POLL_MS;
}
async function pollFixtures() {
  try {
    const norm = normalize(await fetchUpstream());
    indexIds(norm);
    cacheSet('fixtures', JSON.stringify(norm));
    lastPollOk = Date.now();
  } catch (e) {
    // keep serving the last good cache; just log
    // eslint-disable-next-line no-console
    console.error('[poll] fixtures failed:', e.message);
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollFixtures, nextPollDelay());
}

// ---- per-match detail: statistics + line-ups + events ----
function normalizeDetail(stats, lineups, events) {
  const out = { home: '', away: '', stats: [], lineups: {}, events: [] };

  const sresp = (stats && stats.response) || [];
  if (sresp.length >= 1) {
    const H = sresp[0] || {}, A = sresp[1] || {};
    out.home = (H.team && H.team.name) || '';
    out.away = (A.team && A.team.name) || '';
    const byType = new Map();
    (H.statistics || []).forEach((s) => byType.set(s.type, { type: s.type, home: s.value, away: null }));
    (A.statistics || []).forEach((s) => {
      const e = byType.get(s.type) || { type: s.type, home: null, away: null };
      e.away = s.value;
      byType.set(s.type, e);
    });
    out.stats = Array.from(byType.values());
  }

  const lresp = (lineups && lineups.response) || [];
  lresp.forEach((tn, i) => {
    const side = i === 0 ? 'home' : 'away';
    const name = (tn.team && tn.team.name) || '';
    if (side === 'home' && !out.home) out.home = name;
    if (side === 'away' && !out.away) out.away = name;
    const player = (x) => ({ n: x.player && x.player.number, name: x.player && x.player.name, pos: x.player && x.player.pos });
    out.lineups[side] = {
      team: name,
      formation: tn.formation || '',
      start: (tn.startXI || []).map(player),
      subs: (tn.substitutes || []).map(player),
    };
  });

  const eresp = (events && events.response) || [];
  out.events = eresp.map((ev) => {
    const el = ev.time && ev.time.elapsed;
    const extra = ev.time && ev.time.extra;
    return {
      minute: el != null ? String(el) + (extra ? '+' + extra : '') : '',
      team: ev.team && ev.team.name,
      player: ev.player && ev.player.name,
      assist: ev.assist && ev.assist.name,
      type: ev.type,
      detail: ev.detail,
    };
  });

  return out;
}
async function getFixtureDetail(id) {
  const key = 'fx:' + id;
  const status = fixtureStatus.get(String(id));
  const ttl = status === 'live' ? DETAIL_LIVE_TTL_MS
    : status === 'finished' ? DETAIL_DONE_TTL_MS
    : DETAIL_TTL_MS;
  const hit = cacheGet(key, ttl);
  if (hit) return hit;
  const [stats, lineups, events] = await Promise.all([
    apiGet('/fixtures/statistics?fixture=' + encodeURIComponent(id)).catch(() => null),
    apiGet('/fixtures/lineups?fixture=' + encodeURIComponent(id)).catch(() => null),
    apiGet('/fixtures/events?fixture=' + encodeURIComponent(id)).catch(() => null),
  ]);
  return cacheSet(key, JSON.stringify(normalizeDetail(stats, lineups, events)));
}

// ---- squad for a team id ----
function normalizeSquad(sq) {
  const resp = (sq && sq.response) || [];
  const team = resp[0] || {};
  const players = (team.players || []).map((p) => ({ id: p.id, name: p.name, n: p.number, pos: p.position, age: p.age }));
  return { team: (team.team && team.team.name) || '', players };
}
async function getSquad(teamId) {
  const key = 'sq:' + teamId;
  const hit = cacheGet(key, DETAIL_DONE_TTL_MS); // squads change rarely
  if (hit) return hit;
  const sq = await apiGet('/players/squads?team=' + encodeURIComponent(teamId)).catch(() => null);
  const norm = normalizeSquad(sq);
  // register player ids so the /player endpoint will serve them (anti-abuse).
  norm.players.forEach((p) => { if (p.id != null) validPlayerIds.add(String(p.id)); });
  return cacheSet(key, JSON.stringify(norm));
}

// ---- player profile (full name + birth + nationality + club) ----
function normalizePlayer(profiles, players) {
  const prof = (profiles && profiles.response && profiles.response[0] && profiles.response[0].player) || null;
  const pl = (players && players.response && players.response[0]) || null;
  const base = prof || (pl && pl.player) || {};
  const out = {
    id: base.id,
    name: base.name || '',
    firstname: base.firstname || '',
    lastname: base.lastname || '',
    birth: base.birth || (pl && pl.player && pl.player.birth) || null,
    nationality: base.nationality || '',
    height: base.height || '',
    weight: base.weight || '',
    number: base.number != null ? base.number : null,
    position: base.position || (pl && pl.statistics && pl.statistics[0] && pl.statistics[0].games && pl.statistics[0].games.position) || '',
    photo: base.photo || '',
    clubs: [],
  };
  if (pl && Array.isArray(pl.statistics)) {
    const seen = new Set();
    pl.statistics.forEach((s) => {
      const tn = s.team && s.team.name;
      if (tn && !seen.has(tn)) { seen.add(tn); out.clubs.push(tn); }
    });
  }
  return out;
}
async function getPlayer(id) {
  const key = 'pl:' + id;
  const hit = cacheGet(key, DETAIL_DONE_TTL_MS);
  if (hit) return hit;
  const [profiles, players] = await Promise.all([
    apiGet('/players/profiles?player=' + encodeURIComponent(id)).catch(() => null),
    apiGet('/players?id=' + encodeURIComponent(id) + '&season=' + encodeURIComponent(PLAYER_CLUB_SEASON)).catch(() => null),
  ]);
  return cacheSet(key, JSON.stringify(normalizePlayer(profiles, players)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({
      ok: true, hasKey: !!API_KEY, ttlMs: CACHE_TTL_MS,
      fixtures: validFixtureIds.size, live: anyLive(),
      lastPollAgoMs: lastPollOk ? Date.now() - lastPollOk : null,
      nextPollMs: nextPollDelay(),
    }));
    return;
  }

  // Serve the dashboard itself at the root so http://localhost:PORT shows the
  // page directly. The page then fetches live data from /worldcup.json below.
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(INDEX_HTML, (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html not found next to server.js');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
    });
    return;
  }

  // Primary endpoint the frontend points WC2026_OPENFOOTBALL_URL at.
  if (url.pathname === '/worldcup.json') {
    try {
      const body = await getNormalized();
      res.writeHead(200, corsHeaders());
      res.end(body);
    } catch (err) {
      // Surface a clean, CORS-enabled error; frontend will fall back to snapshot.
      res.writeHead(502, corsHeaders());
      res.end(JSON.stringify({ error: String(err.message || err), rounds: [] }));
    }
    return;
  }

  // Client ip for rate limiting (honours a reverse proxy's X-Forwarded-For).
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';

  // On-demand match detail: statistics + line-ups + events for one fixture id.
  if (url.pathname === '/fixture') {
    const id = url.searchParams.get('id');
    if (!id) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: 'missing id', stats: [], lineups: {}, events: [] }));
      return;
    }
    // anti-abuse: only real fixtures, and rate-limit per ip
    if (validFixtureIds.size && !validFixtureIds.has(String(id))) {
      res.writeHead(404, corsHeaders());
      res.end(JSON.stringify({ error: 'unknown fixture', stats: [], lineups: {}, events: [] }));
      return;
    }
    if (!rateOk(ip)) {
      res.writeHead(429, corsHeaders());
      res.end(JSON.stringify({ error: 'rate limited', stats: [], lineups: {}, events: [] }));
      return;
    }
    try {
      const body = await getFixtureDetail(id);
      res.writeHead(200, corsHeaders());
      res.end(body);
    } catch (err) {
      res.writeHead(502, corsHeaders());
      res.end(JSON.stringify({ error: String(err.message || err), stats: [], lineups: {}, events: [] }));
    }
    return;
  }

  // On-demand squad for one team id.
  if (url.pathname === '/squad') {
    const team = url.searchParams.get('team');
    if (!team) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: 'missing team', players: [] }));
      return;
    }
    if (validTeamIds.size && !validTeamIds.has(String(team))) {
      res.writeHead(404, corsHeaders());
      res.end(JSON.stringify({ error: 'unknown team', players: [] }));
      return;
    }
    if (!rateOk(ip)) {
      res.writeHead(429, corsHeaders());
      res.end(JSON.stringify({ error: 'rate limited', players: [] }));
      return;
    }
    try {
      const body = await getSquad(team);
      res.writeHead(200, corsHeaders());
      res.end(body);
    } catch (err) {
      res.writeHead(502, corsHeaders());
      res.end(JSON.stringify({ error: String(err.message || err), players: [] }));
    }
    return;
  }

  // On-demand player profile. Only ids seen in a fetched squad are allowed, so a
  // bot can't make us enumerate arbitrary player ids against upstream.
  if (url.pathname === '/player') {
    const id = url.searchParams.get('id');
    if (!id) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: 'missing id' }));
      return;
    }
    if (!validPlayerIds.has(String(id))) {
      res.writeHead(404, corsHeaders());
      res.end(JSON.stringify({ error: 'unknown player' }));
      return;
    }
    if (!rateOk(ip)) {
      res.writeHead(429, corsHeaders());
      res.end(JSON.stringify({ error: 'rate limited' }));
      return;
    }
    try {
      const body = await getPlayer(id);
      res.writeHead(200, corsHeaders());
      res.end(body);
    } catch (err) {
      res.writeHead(502, corsHeaders());
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`WC2026 proxy on :${PORT}  ->  GET /worldcup.json  (key ${API_KEY ? 'set' : 'MISSING'})`);
  // Start the background poller so the cache is warm before the first visitor
  // and stays current on its own. No-op effect if there's no key (slow idle loop).
  if (API_KEY) pollFixtures();
});
