// fluxer-guard.js: see what your bot sends to Fluxer, and stop it getting
// your server rate limited. One file, no dependencies, Node 18 or newer.
// MIT licence, see LICENSE. From Bloo (https://bloo-bot.xyz).
//
// Fluxer rate limits by IP address. Everything on one machine (a bot, its
// dashboard, a second bot) shares that address, so a burst from any of them
// can get the whole machine blocked, sometimes for close to an hour. Client
// libraries tend to wait out a 429 quietly and retry, so you often can't tell
// which requests caused it.
//
// Install it once per process, as early as you can. It then sees the requests
// that process sends to Fluxer's API: plain fetch() calls (installFetchGuard,
// which also covers libraries built on fetch) and fluxerjs's own REST client
// (installRestGuard). Two modes:
//
//   watch  Counts and logs only. Nothing is slowed down or held back. Use it
//          to find out what's being sent before you change anything.
//   guard  Also protects you:
//            - paces requests (3 a second per process by default),
//            - after a long 429 (30 seconds or more), pauses that route
//              ("GET /guilds/:id") in every process on the machine until
//              Fluxer's retry-after has passed. A global 429, or long 429s on
//              3 different routes within 10 minutes, pauses everything.
//              Paused requests fail at once without touching the network,
//              so your own retries can't make the block longer,
//            - sends at most 1 a second while anything is paused and for
//              2 minutes after, because going straight back to full speed
//              can turn a 10-minute block into 30 or 60,
//            - keeps bot-token GETs for a server, its roles or its channels
//              for 15 seconds, so the same thing isn't fetched repeatedly.
//
// Both modes log a summary every 15 minutes (requests by route, how many were
// rate limited, the busiest channel when it took 50 or more messages), a line
// for every long 429 naming the route, and at most one line a minute when
// Fluxer can't be reached at all. guardReport() returns the same numbers for a
// command or a dashboard.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Settings ─────────────────────────────────────────────────────────────────
// Set by the first install call; later calls can change name and rate.
const settings = {
  mode: 'guard',
  name: `pid ${process.pid}`,
  rps: 3,
  burst: 6,
  apiHosts: new Set(['api.fluxer.app']),
  pauseFile: join(tmpdir(), 'fluxer-guard-pause.json'),
  cacheMs: 15_000,
  statsEveryMs: 15 * 60_000,
  busyChannel: 50,
  logger: console,
};
const LONG_LIMIT_MS = 30_000;
const ESCALATE_ROUTES = 3;
const ESCALATE_WINDOW = 10 * 60_000;
const RAMP_RPS = 1;
const RAMP_MS = 2 * 60_000;

function configure(opts = {}) {
  if (opts.mode) {
    if (opts.mode !== 'watch' && opts.mode !== 'guard') throw new Error(`fluxer-guard: mode must be 'watch' or 'guard', not '${opts.mode}'`);
    settings.mode = opts.mode;
  }
  if (opts.name) settings.name = String(opts.name);
  if (opts.rps != null) {
    settings.rps = Math.max(0.5, Number(opts.rps) || 3);
    settings.burst = Math.max(2, Math.ceil(settings.rps * 2));
    tokens = Math.min(tokens, settings.burst);
  }
  if (opts.apiHosts) settings.apiHosts = new Set([...opts.apiHosts].map(h => String(h).toLowerCase()));
  if (opts.pauseFile !== undefined) settings.pauseFile = opts.pauseFile; // null: this process only
  if (opts.cacheMs != null) settings.cacheMs = Math.max(0, Number(opts.cacheMs) || 0);
  if (opts.statsEveryMs != null) settings.statsEveryMs = Math.max(60_000, Number(opts.statsEveryMs) || 0);
  if (opts.busyChannel != null) settings.busyChannel = Math.max(1, Number(opts.busyChannel) || 50);
  if (opts.logger) settings.logger = opts.logger;
}
const guarding = () => settings.mode === 'guard';
const tag = () => `[fluxer-guard] ${settings.name}`;
const log = msg => (settings.logger.log ?? console.log).call(settings.logger, msg);
const warn = msg => (settings.logger.warn ?? settings.logger.log ?? console.warn).call(settings.logger, msg);

const inflight = new Map(); // AbortController -> route key, cancelled when its route is paused

export class FluxerPausedError extends Error {
  constructor(ms, key = null) {
    const secs = Math.ceil(ms / 1000);
    super(`Fluxer requests${key ? ` for ${key}` : ''} are paused for ${secs}s after a rate limit`);
    this.name = 'FluxerPausedError';
    this.status = this.statusCode = 429;
    this.retryAfter = secs;
    this.route = key;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Connection failures ──────────────────────────────────────────────────────

// The request never got an answer: DNS, routing, a dropped socket, a timeout.
// Nothing your bot sends or restarts can fix these. Any HTTP status means the
// other end answered, so it isn't one of these.
export function isNetworkError(err) {
  if (err?.status || err?.statusCode) return false;
  const text = `${err?.name ?? ''} ${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`;
  return /fetch failed|WebSocket error|Connection aborted|TimeoutError|socket hang up|EAI_AGAIN|ENOTFOUND|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR/i.test(text);
}

// fetch() only says "fetch failed"; the cause (EAI_AGAIN is a DNS lookup
// failing, ECONNREFUSED or ETIMEDOUT is the connection) is in err.cause.
export function describeNetworkError(err) {
  const message = err?.message ?? String(err);
  const cause = err?.cause;
  const detail = cause?.code ? [cause.code, cause.hostname].filter(Boolean).join(' ') : cause?.message;
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

// At most one line a minute however many requests fail during an outage.
let unreachableLoggedAt = 0;
function noteUnreachable(err, key) {
  if (!isNetworkError(err) || err?.name === 'AbortError') return;
  if (Date.now() - unreachableLoggedAt < 60_000) return;
  unreachableLoggedAt = Date.now();
  warn(`${tag()}: can't reach Fluxer: ${describeNetworkError(err)} on ${key}.`);
}

// "GET /guilds/:id/members/:id", for pauses, counting and log lines.
export function routeKey(method, path) {
  const p = String(path)
    .replace(/^https?:\/\/[^/]+/, '')
    .split('?')[0]
    .replace(/^\/v\d+(?=\/)/, '')
    .replace(/\/webhooks\/\d+\/[^/]+/, '/webhooks/:id/:token')
    // Every emoji is one route: counting each separately would make one burst
    // of reaction changes look like several limited routes.
    .replace(/\/reactions\/[^/]+/, '/reactions/:emoji')
    .replace(/\/\d{5,}(?=\/|$)/g, '/:id');
  return `${String(method).toUpperCase()} ${p}`;
}

// ── Shared pause (guard mode) ────────────────────────────────────────────────
// File shape: { global: <until ms>, routes: { "<key>": <until ms> } }. Every
// process on the machine using the same pauseFile sees the same pauses.

let pause = { global: 0, routes: {} };
let pauseReadAt = 0;
let lastPauseEnd = 0; // latest time anything is paused until, for the slow restart
const recentRoutePauses = []; // { key, at }, for escalation

function loadPause() {
  const now = Date.now();
  if (!settings.pauseFile || now - pauseReadAt < 1000) return;
  pauseReadAt = now;
  try {
    const f = JSON.parse(readFileSync(settings.pauseFile, 'utf8'));
    if (Number(f.global) > pause.global) pause.global = Number(f.global);
    for (const [k, until] of Object.entries(f.routes ?? {})) {
      if (Number(until) > (pause.routes[k] ?? 0)) pause.routes[k] = Number(until);
    }
    lastPauseEnd = Math.max(lastPauseEnd, pause.global, ...Object.values(pause.routes));
  } catch { /* no pause file yet */ }
}

function savePause() {
  const now = Date.now();
  for (const [k, until] of Object.entries(pause.routes)) if (until <= now) delete pause.routes[k];
  if (!settings.pauseFile) return;
  try { writeFileSync(settings.pauseFile, JSON.stringify({ ...pause, by: settings.name, pid: process.pid })); } catch { /* still paused in this process */ }
}

// Time left before `key` may be asked again (0 = go ahead). No key: global only.
// Always 0 in watch mode.
export function pauseRemainingMs(key = null) {
  if (!guarding()) return 0;
  loadPause();
  const until = Math.max(pause.global, key ? (pause.routes[key] ?? 0) : 0);
  return Math.max(0, until - Date.now());
}

// A long 429. Guard mode pauses the route (key null: every route); watch mode
// only says what it would have done.
function notePause(ms, why, key = null) {
  const now = Date.now();
  const until = now + ms;
  if (key) {
    recentRoutePauses.push({ key, at: now });
    while (recentRoutePauses.length && now - recentRoutePauses[0].at > ESCALATE_WINDOW) recentRoutePauses.shift();
    const distinct = new Set(recentRoutePauses.map(p => p.key)).size;
    if (distinct >= ESCALATE_ROUTES) {
      why = `${why}; ${distinct} different routes limited within ${ESCALATE_WINDOW / 60_000} min, treating it as machine-wide`;
      key = null;
    }
  }
  report.longLimits.push({ at: now, route: key ?? 'every route', seconds: Math.round(ms / 1000), why });
  if (report.longLimits.length > 50) report.longLimits.shift();

  if (!guarding()) {
    warn(`${tag()}: rate limited (${why}) for ${Math.round(ms / 1000)}s. Watch mode, so nothing was paused; guard mode would pause ${key ?? 'every Fluxer request'} until ${new Date(until).toISOString()}.`);
    return;
  }
  loadPause();
  lastPauseEnd = Math.max(lastPauseEnd, until);
  if (key) {
    if (until <= (pause.routes[key] ?? 0) + 1000) return;
    pause.routes[key] = until;
  } else {
    if (until <= pause.global + 1000) return;
    pause.global = until;
  }
  savePause();
  warn(`${tag()}: rate limited (${why}). Pausing ${key ?? 'every Fluxer request'} from this machine for ${Math.round(ms / 1000)}s, until ${new Date(until).toISOString()}.`);
  for (const [ac, k] of inflight) if (!key || k === key) ac.abort(new FluxerPausedError(ms, key));
}

// ── Pacing (guard mode) ──────────────────────────────────────────────────────

let tokens = settings.burst;
let refilledAt = Date.now();
let queue = Promise.resolve();

function takeToken() {
  if (!guarding()) return Promise.resolve();
  const turn = queue.then(async () => {
    for (;;) {
      loadPause();
      const now = Date.now();
      const slow = now < lastPauseEnd + RAMP_MS;
      const rate = slow ? Math.min(settings.rps, RAMP_RPS) : settings.rps;
      tokens = Math.min(slow ? 1 : settings.burst, tokens + ((now - refilledAt) / 1000) * rate);
      refilledAt = now;
      if (tokens >= 1) { tokens -= 1; return; }
      await sleep(Math.ceil(((1 - tokens) / rate) * 1000));
    }
  });
  queue = turn.catch(() => {});
  return turn;
}

// ── Counting ─────────────────────────────────────────────────────────────────

const counts = new Map();
const channelPosts = new Map(); // channel id -> messages sent this period
let sent = 0, refused = 0, limited = 0, cached = 0, periodStart = Date.now(), statsTimer = null;
const report = { longLimits: [], lastSummary: null };

// Route counts say what's busy but not where; this names the channel.
function noteChannelPost(method, path) {
  if (String(method).toUpperCase() !== 'POST') return;
  const id = String(path).match(/\/channels\/(\d+)\/messages(?:\?|$)/)?.[1];
  if (id) channelPosts.set(id, (channelPosts.get(id) ?? 0) + 1);
}

function tally(key, kind) {
  if (kind === 'sent') { sent++; counts.set(key, (counts.get(key) ?? 0) + 1); }
  else if (kind === 'refused') refused++;
  else if (kind === 'limited') limited++;
  else if (kind === 'cached') cached++;
}

function snapshot() {
  return {
    mode: settings.mode,
    since: new Date(periodStart).toISOString(),
    sent, rateLimited: limited, heldBack: refused, fromCache: cached,
    routes: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([route, n]) => ({ route, n })),
    busiestChannel: (() => { const b = [...channelPosts.entries()].sort((a, b) => b[1] - a[1])[0]; return b ? { channelId: b[0], messages: b[1] } : null; })(),
  };
}

// What's been sent since the last summary, the last summary itself, and the
// recent long 429s. For a command or a status page.
export function guardReport() {
  return { current: snapshot(), lastSummary: report.lastSummary, longLimits: [...report.longLimits], paused: guarding() ? { ...pause, routes: { ...pause.routes } } : null };
}

function startStats() {
  if (statsTimer) return;
  statsTimer = setInterval(() => {
    const s = snapshot();
    report.lastSummary = s;
    if (sent || refused || limited) {
      const mins = settings.statsEveryMs / 60_000;
      const top = s.routes.slice(0, 6).map(r => `${r.route} ×${r.n}`).join(', ');
      log(`${tag()}: ${sent} requests in the last ${mins} min (${limited} rate limited, ${refused} held back by a pause, ${cached} answered from cache). Most: ${top || 'none'}`);
      if (s.busiestChannel?.messages >= settings.busyChannel) log(`${tag()}: busiest channel ${s.busiestChannel.channelId} took ${s.busiestChannel.messages} messages in the last ${mins} min.`);
    }
    counts.clear(); channelPosts.clear(); sent = refused = limited = cached = 0; periodStart = Date.now();
  }, settings.statsEveryMs);
  statsTimer.unref?.();
}

// ── fluxerjs's REST client (client.rest) ─────────────────────────────────────
// Hooks the library's request manager and rate limiter. These are internals
// of @fluxerjs/rest (written against 3.x), not a public API; if a future
// version moves them, this does nothing and says so, and installFetchGuard
// still covers your own fetch() calls.

function keyFromLibraryRoute(route) {
  const [method, ...rest] = String(route).split(' ');
  return rest.length ? routeKey(method, rest.join(' ')) : null;
}

export function installRestGuard(client, options = {}) {
  configure(typeof options === 'string' ? { name: options } : options);
  const rm = client?.rest?.requestManager;
  if (!rm?.request) { warn(`${tag()}: installRestGuard found no client.rest.requestManager.request, so library requests aren't watched. Is this a fluxerjs client?`); return false; }
  if (rm.__fluxerGuarded) return true;
  rm.__fluxerGuarded = true;

  // On a 429 the library records the reset time here, then sleeps until it
  // before retrying. A long one is noted (and paused in guard mode, which
  // cancels that sleep through the signal passed below).
  const rl = rm.rateLimiter;
  if (rl?.setBucket) {
    const setBucket = rl.setBucket.bind(rl);
    rl.setBucket = (route, limit, remaining, resetAt) => {
      setBucket(route, limit, remaining, resetAt);
      const ms = resetAt - Date.now();
      if (remaining <= 0 && ms >= LONG_LIMIT_MS) {
        const key = keyFromLibraryRoute(route);
        notePause(ms, `429 on ${key ?? route}`, key);
      }
    };
  }
  if (rl?.setGlobalReset) {
    const setGlobalReset = rl.setGlobalReset.bind(rl);
    rl.setGlobalReset = (resetAt) => {
      setGlobalReset(resetAt);
      const ms = resetAt - Date.now();
      if (ms >= LONG_LIMIT_MS) notePause(ms, 'global 429');
    };
  }

  const request = rm.request.bind(rm);
  rm.request = async (method, route, opts = {}) => {
    const key = routeKey(method, route);
    let wait = pauseRemainingMs(key);
    if (wait > 0) { tally(key, 'refused'); throw new FluxerPausedError(wait, key); }
    await takeToken();
    wait = pauseRemainingMs(key);
    if (wait > 0) { tally(key, 'refused'); throw new FluxerPausedError(wait, key); }

    const ac = new AbortController();
    const userSignal = opts.signal;
    if (userSignal) {
      if (userSignal.aborted) ac.abort(userSignal.reason);
      else userSignal.addEventListener('abort', () => ac.abort(userSignal.reason), { once: true });
    }
    inflight.set(ac, key);
    tally(key, 'sent');
    noteChannelPost(method, route);
    try {
      return await request(method, route, { ...opts, signal: ac.signal });
    } catch (err) {
      if (err?.name === 'RateLimitError' || err?.statusCode === 429) {
        tally(key, 'limited');
        const ms = Number(err.retryAfter) * 1000;
        if (ms >= LONG_LIMIT_MS) notePause(ms, `429 on ${key}`, err.global ? null : key);
      }
      noteUnreachable(err, key);
      const left = pauseRemainingMs(key);
      if (left > 0 && ac.signal.aborted && !userSignal?.aborted) throw new FluxerPausedError(left, key);
      throw err;
    } finally {
      inflight.delete(ac);
    }
  };
  startStats();
  return true;
}

// ── fetch() calls ────────────────────────────────────────────────────────────

const getCache = new Map(); // `${auth}|${url}` -> { at, status, headers, body }
const CACHEABLE = /^\/(?:v\d+\/)?guilds\/\d+(?:\/(?:roles|channels))?$/;

function pausedResponse(ms, key) {
  const secs = Math.ceil(ms / 1000);
  return new Response(JSON.stringify({ code: 'FLUXER_GUARD_PAUSED', message: `fluxer-guard paused ${key} after a rate limit`, retry_after: secs, global: false }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(secs) },
  });
}

async function readLimit(res) {
  let ms = Number(res.headers.get('retry-after')) * 1000 || 0;
  let global = res.headers.get('x-ratelimit-global') === 'true';
  try {
    const body = await res.clone().json();
    if (!ms && Number(body?.retry_after) > 0) ms = Number(body.retry_after) * 1000;
    if (body?.global === true) global = true;
  } catch { /* not JSON */ }
  return { ms, global };
}

export function installFetchGuard(options = {}) {
  configure(typeof options === 'string' ? { name: options } : options);
  if (globalThis.fetch?.__fluxerGuarded) return true;
  if (typeof globalThis.fetch !== 'function') throw new Error('fluxer-guard needs a global fetch (Node 18 or newer).');
  const realFetch = globalThis.fetch;

  const guarded = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    let parsed;
    try { parsed = new URL(url); } catch { return realFetch(input, init); }
    if (!settings.apiHosts.has(parsed.host.toLowerCase())) return realFetch(input, init);

    const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
    const key = routeKey(method, url);
    const auth = new Headers(init.headers ?? input?.headers ?? undefined).get('authorization') ?? '';

    // Any change can make a cached read stale, so a write clears them all.
    if (method !== 'GET') getCache.clear();
    const cacheKey = guarding() && settings.cacheMs > 0 && method === 'GET' && auth.startsWith('Bot ') && CACHEABLE.test(parsed.pathname) ? `${auth}|${url}` : null;
    if (cacheKey) {
      const hit = getCache.get(cacheKey);
      if (hit && Date.now() - hit.at < settings.cacheMs) {
        tally(key, 'cached');
        return new Response(hit.body.slice(0), { status: hit.status, headers: hit.headers });
      }
    }

    let wait = pauseRemainingMs(key);
    if (wait > 0) { tally(key, 'refused'); return pausedResponse(wait, key); }
    await takeToken();
    wait = pauseRemainingMs(key);
    if (wait > 0) { tally(key, 'refused'); return pausedResponse(wait, key); }

    tally(key, 'sent');
    noteChannelPost(method, parsed.pathname);
    const res = await realFetch(input, init).catch((err) => { noteUnreachable(err, key); throw err; });
    if (res.status === 429) {
      tally(key, 'limited');
      const { ms, global } = await readLimit(res);
      if (ms >= LONG_LIMIT_MS) notePause(ms, `429 on ${key}`, global ? null : key);
    } else if (cacheKey && res.ok) {
      const body = await res.clone().arrayBuffer();
      getCache.set(cacheKey, { at: Date.now(), status: res.status, headers: [...res.headers.entries()], body });
      if (getCache.size > 500) getCache.delete(getCache.keys().next().value);
    }
    return res;
  };
  guarded.__fluxerGuarded = true;
  globalThis.fetch = guarded;
  startStats();
  return true;
}
