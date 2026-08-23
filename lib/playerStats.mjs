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

// Extracts just the compact numeric fields actually used, keyed by player id
// — the CACHED form, not the raw CSV rows (which carry many string fields
// never read here). Keeps the persisted per-gameweek cache small even as it
// accumulates one entry per finished gameweek across a full season.
function extractGwStats(text) {
  const byId = {};
  for (const row of parseCsv(text)) {
    const id = Number(row.id);
    if (!id) continue;
    byId[id] = {
      minutes: n(row.minutes), points: n(row.event_points), goals: n(row.goals_scored),
      assists: n(row.assists), cleanSheets: n(row.clean_sheets), goalsConceded: n(row.goals_conceded),
      tackles: n(row.tackles), cbi: n(row.clearances_blocks_interceptions), recoveries: n(row.recoveries),
      xG: n(row.expected_goals), xA: n(row.expected_assists), xGI: n(row.expected_goal_involvements),
      xGC: n(row.expected_goals_conceded), dc: n(row.defensive_contribution),
    };
  }
  return byId;
}

// finishedGwIds: real gameweek ids FPL's own bootstrap-static reports as
// `finished` — pre-season this is an empty array, so this returns
// immediately with zero network calls.
//
// previousStatsByGw: the caller's own persisted per-gameweek cache (a
// SEPARATE KV key in refresh.mjs, not merged into the main data blob — see
// the comment there for why). Real, confirmed growing-cost risk
// (2026-08-23): without this, EVERY finished gameweek's CSV gets refetched
// and reparsed on EVERY 5-minute tick, forever — a cost that starts at
// zero pre-season but grows every single gameweek for the rest of a
// 38-week season, exactly the pattern that already tipped the cron worker
// over Cloudflare's CPU limit once (see lib/insights.mjs's fixture-stats
// caching for the same fix applied there). A gameweek FPL itself already
// reports finished is done — its CSV will never change again, so it's
// fetched and parsed exactly once, ever; only gameweeks not yet cached get
// a real network call.
//
// Returns { agg, statsByGw, changed } — agg is the same aggregate shape
// callers already expect ({ [playerId]: { apps, minutes, points, ...,
// dcPerGw: number[], gwPoints: { [gw]: points } } }, or null), statsByGw is
// the updated per-gameweek cache to persist, and changed is true only when
// a new gameweek was actually fetched this run (so the caller can skip
// writing the cache back on the common case where nothing changed).
export async function fetchPlayerStatsAgg(finishedGwIds, previousStatsByGw = null) {
  const statsByGw = { ...(previousStatsByGw || {}) };
  if (!finishedGwIds || !finishedGwIds.length) return { agg: null, statsByGw, changed: false };

  const sortedGwIds = [...finishedGwIds].sort((a, b) => a - b);
  const toFetch = sortedGwIds.filter((gw) => !statsByGw[gw]);
  let changed = false;

  if (toFetch.length) {
    try {
      const texts = await Promise.all(
        toFetch.map((gw) =>
          fetch(gwStatsUrl(gw))
            .then((res) => (res.ok ? res.text() : null))
            .catch(() => null)
        )
      );
      toFetch.forEach((gw, i) => {
        if (texts[i]) {
          statsByGw[gw] = extractGwStats(texts[i]);
          changed = true;
        }
      });
    } catch (err) {
      console.error('player stats fetch failed (non-fatal)', err.message);
    }
  }

  const byId = {};
  for (const gw of sortedGwIds) {
    const gwStats = statsByGw[gw];
    if (!gwStats) continue;
    for (const [idStr, row] of Object.entries(gwStats)) {
      const id = Number(idStr);
      if (!byId[id]) {
        byId[id] = {
          apps: 0, minutes: 0, points: 0, goals: 0, assists: 0, cleanSheets: 0,
          goalsConceded: 0, tackles: 0, cbi: 0, recoveries: 0,
          xG: 0, xA: 0, xGI: 0, xGC: 0, dcPerGw: [], gwPoints: {},
        };
      }
      const p = byId[id];
      // Recorded regardless of minutes so the heatmap can distinguish a
      // real "played, 0 pts" gameweek (key present, value 0) from a
      // gameweek this player's team didn't even have a fixture for (key
      // absent entirely) — collapsing those into the same "0" would lose
      // real information a manager would want to see.
      p.gwPoints[gw] = row.points;
      if (row.minutes > 0) {
        p.apps += 1;
        p.minutes += row.minutes;
        p.points += row.points;
        p.goals += row.goals;
        p.assists += row.assists;
        p.cleanSheets += row.cleanSheets;
        p.goalsConceded += row.goalsConceded;
        p.tackles += row.tackles;
        p.cbi += row.cbi;
        p.recoveries += row.recoveries;
        p.xG += row.xG;
        p.xA += row.xA;
        p.xGI += row.xGI;
        p.xGC += row.xGC;
        p.dcPerGw.push(row.dc);
      }
    }
  }
  return { agg: Object.keys(byId).length ? byId : null, statsByGw, changed };
}
