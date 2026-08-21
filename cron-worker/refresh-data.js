import { runRefresh } from '../lib/refresh.mjs';

// runRefresh's own internal enrichment fetches (Elo, player stats, preseason
// data, win probabilities, Gemini, Groq) are all individually try/catch'd
// and degrade to null/skip rather than throwing — but the two REQUIRED FPL
// fetches at its top aren't wrapped, so a network-level failure there
// (DNS/timeout, not just a non-2xx response, which IS already handled) would
// throw. Catching it here at the call boundary means that's a logged,
// visible failure instead of an unhandled rejection Cloudflare surfaces
// separately from the actual error site — old `latest` data in KV simply
// persists untouched until the next successful run (once daily), so a
// single bad run never leaves the site broken.
async function safeRefresh(env) {
  try {
    await runRefresh(env);
  } catch (err) {
    console.error('runRefresh failed', err);
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(safeRefresh(env));
  },
  // Lets you trigger a refresh manually by visiting the worker's URL directly
  // (e.g. right after first deploy, so you don't have to wait for the next
  // scheduled run) — see README for the exact command.
  async fetch(request, env) {
    await safeRefresh(env);
    return new Response('refreshed');
  },
};
