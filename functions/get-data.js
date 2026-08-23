// Merges two KV keys into the single response shape the frontend already
// expects — 'latest' (rewritten every 5-minute refresh tick: live scores,
// bestXI/differentials, standings, history) and 'staticCatalog' (rewritten
// at most hourly by refresh.mjs: the team list, gameweek list, chip
// windows, set-piece takers, fixture-difficulty map — genuinely static
// data that doesn't need every-tick freshness). Splitting these means the
// scheduled refresh no longer has to re-serialize and rewrite the catalog
// fields on every single tick, all season — see lib/refresh.mjs for the
// write side. Frontend-invisible: public/app.js reads the merged shape
// exactly as it always has.
export async function onRequestGet({ env }) {
  const [rawLatest, rawCatalog] = await Promise.all([
    env.FPL_KV.get('latest'),
    env.FPL_KV.get('staticCatalog'),
  ]);

  if (!rawLatest) {
    return new Response(JSON.stringify({ error: 'not_ready' }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  let body = rawLatest;
  if (rawCatalog) {
    try {
      const latest = JSON.parse(rawLatest);
      const { fetchedAt, ...catalogFields } = JSON.parse(rawCatalog);
      body = JSON.stringify({ ...catalogFields, ...latest });
    } catch (err) {
      // Malformed cache entry — fall back to 'latest' alone rather than
      // breaking the whole page over a bad catalog write.
      console.error('staticCatalog merge failed, serving latest only', err.message);
    }
  }

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
