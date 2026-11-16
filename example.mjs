// A fluxerjs bot with fluxer-guard watching its requests.
//   FLUXER_BOT_TOKEN=... node example.mjs
// b!ratelimits replies with what's been sent and anything rate limited.
// Switch mode to 'guard' once you've seen what your bot sends.
import { Client, Events } from '@fluxerjs/core';
import { installFetchGuard, installRestGuard, guardReport } from './fluxer-guard.js';

const mode = 'watch';
installFetchGuard({ name: 'example-bot', mode });

const client = new Client({ intents: 0 });
installRestGuard(client, { name: 'example-bot', mode });

client.on(Events.MessageCreate, async (message) => {
  if (message.author?.bot || message.content !== 'b!ratelimits') return;
  const r = guardReport();
  const top = r.current.routes.slice(0, 5).map(x => `${x.route} ×${x.n}`).join('\n') || 'nothing yet';
  const limits = r.longLimits.slice(-3).map(l => `${new Date(l.at).toISOString()} ${l.route} for ${l.seconds}s`).join('\n') || 'none';
  await message.reply(`Since ${r.current.since}: ${r.current.sent} requests, ${r.current.rateLimited} rate limited.\n\nBusiest routes:\n${top}\n\nRecent long limits:\n${limits}`);
});

await client.login(process.env.FLUXER_BOT_TOKEN);
