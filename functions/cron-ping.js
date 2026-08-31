// Dedicated endpoint for an external cron/uptime pinger (see
// .github/workflows/refresh.yml's own comment for the full backstory:
// GitHub Actions' scheduled trigger turned out to be unreliable for a
// frequent cron — real, measured gaps of 2-10+ hours even after tuning
// the declared interval down, not something further tuning fixed).
// A dedicated external service built specifically for punctual scheduled
// HTTP calls is a fundamentally different mechanism, not subject to
// GitHub's own scheduled-workflow deprioritization.
//
// Protected by a shared secret (CRON_PING_SECRET, a Cloudflare Pages
// secret) rather than force-refresh.js's 1-hour cooldown - that cooldown
// exists to rate-limit a public, unauthenticated manual "force refresh"
// button; this endpoint is the opposite shape (trusted only by whoever
// holds the secret, called on ITS OWN configured schedule), so the right
// protection is knowing the secret, not a cooldown. The expensive part
// (Gemini/Groq AI consensus) is already separately throttled inside
// runRefresh itself regardless of how often this endpoint gets hit, so
// there's no cost-runaway risk even if the external service's own
// interval were set aggressively.
import { runRefresh } from '../lib/refresh.mjs';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.CRON_PING_SECRET || key !== env.CRON_PING_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const ok = await runRefresh(env);
    return new Response(JSON.stringify({ ok }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    // Public endpoint (even if secret-gated) - never echo raw exception
    // text back to the caller, same pattern as force-refresh.js.
    console.error('cron-ping exception', err);
    return new Response(JSON.stringify({ error: 'exception' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
