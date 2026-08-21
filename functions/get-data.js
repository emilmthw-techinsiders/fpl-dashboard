export async function onRequestGet({ env }) {
  const raw = await env.FPL_KV.get('latest');
  const body = raw ?? JSON.stringify({ error: 'not_ready' });

  return new Response(body, {
    headers: {
      'content-type': 'application/json',
      // No caching at all — this only ever changes once a day, our traffic is
      // tiny, and stale data being served after a fix goes out is worse than
      // the near-zero cost of always hitting KV fresh.
      'cache-control': 'no-store',
    },
  });
}
