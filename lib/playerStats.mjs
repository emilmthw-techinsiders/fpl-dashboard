// Real per-gameweek player stats (tackles, clearances/blocks/interceptions,
// recoveries — the raw components behind FPL's own "Defensive Contribution"
// bonus, which FPL's bootstrap-static exposes only as a combined total, never
// the individual components) sourced from the free, open, twice-daily-
// refreshed dataset at github.com/olbauday/FPL-Core-Insights — same pattern
// as lib/eloRatings.mjs. No API key, no per-call cost.
//
// Real gotcha found via direct verification: the repo's top-level
// data/2026-2027/playerstats.csv is NOT a growing season history — it's
// byte-for-byte identical to whichever data/2026-2027/By Gameweek/GW{n}/
// playerstats.csv is the CURRENT gameweek (confirmed: GW1's copy matched
// the top-level file exactly while GW1 is still upcoming). Summing that
// single file would silently under-count every season total once real
// gameweeks start piling up — GW5's snapshot would look like a whole
// season's stats. The only way to get genuine season-to-date totals (and a
// real per-gameweek matrix for the Stats Per Gameweek heatmap) is to fetch
// each individually-numbered GW folder for every gameweek FPL's own
// bootstrap-static already reports as finished, and sum across those.
function gwStatsUrl(gw) {
  return `https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data/2026-2027/By%20Gameweek/GW${gw}/playerstats.csv`;
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
  });
}

const n = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};

// finishedGwIds: real gameweek ids FPL's own bootstrap-static reports as
// `finished` (see lib/refresh.mjs) — pre-season this is an empty array, so
// this returns null immediately with zero network calls, exactly matching
// "nothing to aggregate yet" rather than wastefully fetching 38 empty files.
//
// Returns { [playerId]: { apps, minutes, points, goals, assists, cleanSheets,
// goalsConceded, tackles, cbi, recoveries, xG, xA, xGI, xGC, dcPerGw: number[],
// gwPoints: { [gw]: points } } } or null on failure/no data — callers treat a
// missing map exactly like a missing elo fetch: just skip the enrichment,
// never break the refresh.
export async function fetchPlayerStatsAgg(finishedGwIds) {
  if (!finishedGwIds || !finishedGwIds.length) return null;
  try {
    const texts = await Promise.all(
      finishedGwIds.map((gw) =>
        fetch(gwStatsUrl(gw))
          .then((res) => (res.ok ? res.text() : null))
          .catch(() => null)
      )
    );

    const byId = {};
    finishedGwIds.forEach((gw, i) => {
      const text = texts[i];
      if (!text) return;
      for (const row of parseCsv(text)) {
        const id = Number(row.id);
        if (!id) continue;
        if (!byId[id]) {
          byId[id] = {
            apps: 0, minutes: 0, points: 0, goals: 0, assists: 0, cleanSheets: 0,
            goalsConceded: 0, tackles: 0, cbi: 0, recoveries: 0,
            xG: 0, xA: 0, xGI: 0, xGC: 0, dcPerGw: [], gwPoints: {},
          };
        }
        const p = byId[id];
        const mins = n(row.minutes);
        const pts = n(row.event_points);
        // Recorded regardless of minutes so the heatmap can distinguish a
        // real "played, 0 pts" gameweek (key present, value 0) from a
        // gameweek this player's team didn't even have a fixture for (key
        // absent entirely) — collapsing those into the same "0" would lose
        // real information a manager would want to see.
        p.gwPoints[gw] = pts;
        if (mins > 0) {
          p.apps += 1;
          p.minutes += mins;
          p.points += pts;
          p.goals += n(row.goals_scored);
          p.assists += n(row.assists);
          p.cleanSheets += n(row.clean_sheets);
          p.goalsConceded += n(row.goals_conceded);
          p.tackles += n(row.tackles);
          p.cbi += n(row.clearances_blocks_interceptions);
          p.recoveries += n(row.recoveries);
          p.xG += n(row.expected_goals);
          p.xA += n(row.expected_assists);
          p.xGI += n(row.expected_goal_involvements);
          p.xGC += n(row.expected_goals_conceded);
          p.dcPerGw.push(n(row.defensive_contribution));
        }
      }
    });
    return Object.keys(byId).length ? byId : null;
  } catch (err) {
    console.error('player stats fetch failed (non-fatal)', err.message);
    return null;
  }
}
