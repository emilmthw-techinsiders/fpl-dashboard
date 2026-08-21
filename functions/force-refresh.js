// On-demand "force refresh now" — runs the exact same pipeline as the daily
// cron (see lib/refresh.mjs), so it inherits the pick-locking behavior
// automatically: Best XI/Differentials/AI picks only ever change here if the
// gameweek is still in its "open" window, or via the existing injury-swap
// exception once locked. Nothing about locking is special-cased for this
// button. Gated by a 1-hour cooldown tracked in KV so it can't be spammed —
// worst case (cooldown hit back-to-back all day) is +24 extra refreshes, still
// trivial against Cloudflare/Gemini free-tier limits.
import { runRefresh } from '../lib/refresh.mjs';

const COOLDOWN_SECONDS = 3600;
const LOCK_KEY = 'force-refresh-lock';

export async function onRequestPost({ env }) {
  const lockedAt = await env.FPL_KV.get(LOCK_KEY);
  if (lockedAt) {
    const elapsedMs = Date.now() - new Date(lockedAt).getTime();
    const remainingSeconds = Math.max(0, COOLDOWN_SECONDS - Math.floor(elapsedMs / 1000));
    return new Response(JSON.stringify({ error: 'cooldown', remainingSeconds }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Set the lock BEFORE doing the work, so two near-simultaneous clicks
  // can't both slip through.
  await env.FPL_KV.put(LOCK_KEY, new Date().toISOString(), { expirationTtl: COOLDOWN_SECONDS });

  try {
    const ok = await runRefresh(env);
    if (!ok) {
      // A handled failure (e.g. FPL API was down) — release the lock so a
      // retry isn't punished with the full hour cooldown for something that
      // wasn't the caller's fault.
      await env.FPL_KV.delete(LOCK_KEY);
    }
    return new Response(JSON.stringify({ ok }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    await env.FPL_KV.delete(LOCK_KEY);
    // This is a public, unauthenticated endpoint — never echo raw exception
    // text back to the caller. Full detail goes to server-side logs only.
    console.error('force-refresh exception', err);
    return new Response(JSON.stringify({ error: 'exception' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
