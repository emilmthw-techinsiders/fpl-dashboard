// Inferno's own H2H mini-league fixtures (who plays whom each gameweek),
// pulled from FPL's public H2H league API — no login needed, this endpoint
// is open for any league ID. FPL only generates the actual matchups once the
// season (and the league's own schedule) has started; before that it just
// returns an empty results array, which we treat as "not generated yet"
// rather than an error.
const H2H_LEAGUE_ID = 57851;

export async function fetchH2HMatchesForGw(gwId) {
  try {
    const res = await fetch(`https://fantasy.premierleague.com/api/leagues-h2h-matches/league/${H2H_LEAGUE_ID}/?page=1&event=${gwId}`);
    if (!res.ok) return [];
    const body = await res.json();
    return (body.results || []).map((m) => ({
      home: { name: m.entry_1_name, playerName: m.entry_1_player_name, points: m.entry_1_points },
      away: { name: m.entry_2_name, playerName: m.entry_2_player_name, points: m.entry_2_points },
    }));
  } catch (err) {
    console.error('H2H fetch error', gwId, err);
    return [];
  }
}

// Inferno 14 H2H's own dedicated league table — separate from both the
// fixture pairings above (who plays whom) and the classic league's overall
// standings (lib/standings.mjs, a different league entirely). Ranked by W/D/L
// match record, not raw points. Real gap found live (2026-08-22): the site
// only ever showed H2H fixtures, never this table, even though FPL exposes
// it on its own public endpoint just like the classic one. Confirmed FPL
// itself hasn't finished processing GW1's H2H results yet (every entry
// currently shows matches_played: 0, even mid-gameweek) — that's a genuine
// FPL-side processing lag, not something this fetch can work around; it
// resolves on its own once FPL finalizes the gameweek.
export async function fetchH2HStandings() {
  try {
    const res = await fetch(`https://fantasy.premierleague.com/api/leagues-h2h/${H2H_LEAGUE_ID}/standings/`);
    if (!res.ok) return [];
    const body = await res.json();
    const results = body?.standings?.results || [];
    return results.map((r) => {
      const lastRank = r.last_rank || 0;
      const movement = !lastRank ? 'same' : r.rank < lastRank ? 'up' : r.rank > lastRank ? 'down' : 'same';
      return {
        rank: r.rank,
        lastRank,
        movement,
        teamName: r.entry_name,
        managerName: r.player_name,
        played: r.matches_played,
        won: r.matches_won,
        drawn: r.matches_drawn,
        lost: r.matches_lost,
        leaguePoints: r.total,
      };
    });
  } catch (err) {
    console.error('H2H standings fetch error', err);
    return [];
  }
}

// Refreshes a small rolling window (previous + current + next few gameweeks)
// each day rather than all 38 at once — keeps subrequest usage tiny while
// still accumulating the full season into `previousByGw` over time, exactly
// like the pick-history in history.mjs. Once a gameweek is finished and we
// already have real (non-empty) results for it, it's left alone for good.
export async function refreshH2HFixtures(previousByGw, events, activeGwId) {
  const byGw = { ...(previousByGw || {}) };
  const activeIdx = events.findIndex((e) => e.id === activeGwId);
  const windowEvents = activeIdx === -1 ? events.slice(0, 4) : events.slice(Math.max(0, activeIdx - 1), activeIdx + 4);

  for (const event of windowEvents) {
    const alreadyFinal = event.finished && byGw[event.id]?.length;
    if (alreadyFinal) continue;
    const matches = await fetchH2HMatchesForGw(event.id);
    if (matches.length || !(event.id in byGw)) {
      byGw[event.id] = matches;
    }
  }

  return byGw;
}
