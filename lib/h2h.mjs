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
