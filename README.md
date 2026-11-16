# fluxer-guard

Find out what your Fluxer bot is sending, and stop it getting your server rate limited.

One file, no dependencies, Node 18 or newer. MIT licence.

## Why

Fluxer rate limits by IP address. Everything running on one machine shares that address: your bot, its dashboard, a second bot, a script you ran once. A burst from any of them can get the whole machine blocked, sometimes for close to an hour. Going straight back to full speed afterwards can make the block longer.

Client libraries usually wait out a 429 quietly and try again, so all you see is a bot that's slow or offline, with nothing in the logs saying which requests caused it. fluxer-guard came out of exactly that happening to [Bloo](https://bloo-bot.xyz): it counts what's sent, by route, and says which route was limited and for how long. In guard mode it also stops the bot making things worse.

## Install

Copy `fluxer-guard.js` into your project. There's nothing to `npm install`.

Install it once per process, as early as you can, before your bot starts making requests:

```js
import { installFetchGuard, installRestGuard } from './fluxer-guard.js';

// Your own fetch() calls to Fluxer, and any library built on fetch.
installFetchGuard({ name: 'bot', mode: 'watch' });

const client = new Client({ intents: 0 });
// fluxerjs's own requests (client.rest).
installRestGuard(client, { name: 'bot', mode: 'watch' });
```

It's an ES module. From CommonJS, load it with `const guard = await import('./fluxer-guard.js')`.

Run it in every process on the machine that talks to Fluxer (the bot, a dashboard, a worker), each with its own `name`. They share pauses through a small file, so a limit one of them hits pauses that route for all of them.

## Watch first, then guard

**`mode: 'watch'`** only counts and logs. Nothing is slowed down or held back, so it's safe to drop into a bot that's already running. Leave it for a day and read the summaries to see what your bot sends and what gets limited.

**`mode: 'guard'`** (the default) also protects you:

- **Pacing.** It sends at most 3 requests a second per process (`rps`), with a short burst allowed.
- **Pausing after a long limit.** After a 429 of 30 seconds or more, it pauses that route (like `GET /guilds/:id/members/:id`) in every process on the machine until Fluxer's retry-after has passed. A global 429, or long 429s on 3 different routes within 10 minutes, pauses everything. A paused request fails straight away without touching the network, so your own retries can't make the block longer. Routes that weren't limited keep working.
- **Coming back slowly.** While anything is paused, and for 2 minutes after, it sends at most 1 request a second.
- **Caching repeated reads.** It keeps bot-token GETs for a server, its roles or its channels for 15 seconds (`cacheMs`), so the same thing isn't fetched over and over.

A paused fluxerjs request throws a `FluxerPausedError` (status 429, with `retryAfter` in seconds and the `route`). A paused fetch() gets a 429 response with the code `FLUXER_GUARD_PAUSED` and a `retry-after` header, so code that already handles 429s handles it the same way.

## Reading the logs

Every 15 minutes, when anything was sent:

```
[fluxer-guard] bot: 1204 requests in the last 15 min (3 rate limited, 0 held back by a pause, 41 answered from cache). Most: POST /channels/:id/messages ×812, GET /guilds/:id/members/:id ×201, PUT /channels/:id/messages/:id/reactions/:emoji/@me ×90
```

The routes at the front of "Most" are where your requests go. One route taking hundreds a period is usually the place to look. When one channel takes 50 or more messages, you also get:

```
[fluxer-guard] bot: busiest channel 1234567890123456789 took 391 messages in the last 15 min.
```

That names the channel behind a burst of messages, which the route alone doesn't tell you.

Every long 429, as it happens:

```
[fluxer-guard] bot: rate limited (429 on GET /guilds/:id/members/:id). Pausing GET /guilds/:id/members/:id from this machine for 1800s, until 2026-11-16T12:47:56.255Z.
```

In watch mode, the same line says what guard mode would have done instead.

When Fluxer can't be reached at all, at most once a minute:

```
[fluxer-guard] bot: can't reach Fluxer: fetch failed (EAI_AGAIN api.fluxer.app) on GET /gateway/bot.
```

`EAI_AGAIN` or `ENOTFOUND` is a DNS lookup failing on your machine; `ECONNREFUSED` or `ETIMEDOUT` is the connection. Neither is a rate limit, and nothing your bot sends will fix it.

## In your own commands

`guardReport()` returns the same numbers as the summary, for a command or a status page:

```js
import { guardReport } from './fluxer-guard.js';

const r = guardReport();
// r.current       what's been sent since the last summary: sent, rateLimited, heldBack, fromCache, routes, busiestChannel
// r.lastSummary   the previous 15-minute period
// r.longLimits    the recent long 429s: { at, route, seconds, why }
// r.paused        what's paused right now (guard mode)
```

## Options

Both install functions take the same options. The first call sets them, and later calls can change them.

| Option | Default | What it does |
|---|---|---|
| `name` | `pid <number>` | Label in log lines. Use a different one per process. |
| `mode` | `'guard'` | `'watch'` only counts and logs. `'guard'` also paces, pauses and caches. |
| `rps` | `3` | Requests per second for this process in guard mode. Give a dashboard or worker a lower number, since they share the machine's limit with the bot. |
| `apiHosts` | `['api.fluxer.app']` | Hostnames counted as Fluxer's API. For a self-hosted instance, list its API hostnames. |
| `pauseFile` | `fluxer-guard-pause.json` in the system temp folder | File that shares pauses between processes on the machine. `null` keeps pauses inside this process only. |
| `cacheMs` | `15000` | How long to keep repeated server, role and channel reads in guard mode. `0` turns caching off. |
| `statsEveryMs` | `900000` (15 min) | How often the summary is logged. |
| `busyChannel` | `50` | Messages in one period before the busiest channel gets its own log line. |
| `logger` | `console` | Anything with `log` and `warn`, such as your own logger. |

## What it can't see

- **Other machines.** A different machine behind the same IP address (some hosts share one) can get you limited, and this can't count its requests.
- **Requests that don't go through fetch() or fluxerjs.** A library with its own HTTP client, or another language, isn't counted.
- **fluxerjs internals can move.** `installRestGuard` hooks fluxerjs's request manager and rate limiter, written against fluxerjs 3.x. These aren't a public API. If a future version changes them, `installRestGuard` logs that it couldn't hook in and does nothing, and `installFetchGuard` keeps working.

## Licence

MIT. See [LICENSE](LICENSE). Use it, change it, and ship it in your bot, open or closed.
