// Proxies FPL's per-player match log (element-summary) for the Rate My Squad
// tool's "form vs this opponent" factor. FPL's API has no CORS headers, so
// the browser can't call it directly — this just relays it same-origin.
// Only ever called for the up to 11 players actually in a tray (never a bulk
// crawl), so it stays tiny even with the whole league using it at once.
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return new Response(JSON.stringify({ error: 'invalid_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const res = await fetch(`https://fantasy.premierleague.com/api/element-summary/${id}/`);
  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'upstream_error' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  const body = await res.text();
  return new Response(body, {
    headers: {
      'content-type': 'application/json',
      // A player's match log barely changes within a day — a short cache
      // keeps repeated tray edits from re-fetching the same player.
      'cache-control': 'public, max-age=1800',
    },
  });
}
