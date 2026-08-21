// Optional enrichment: pre-match win/draw/loss probabilities from footballdata.io,
// layered on top of FPL's own 1-5 fixture difficulty rating. This is entirely
// best-effort — if the API is unreachable, over quota, or a fixture can't be
// matched, we just skip enrichment for that fixture rather than fail the
// whole daily refresh. The core site never depends on this.

const TEAM_NAME_TO_SHORT = {
  'Arsenal': 'ARS',
  'Aston Villa': 'AVL',
  'AFC Bournemouth': 'BOU',
  'Brentford': 'BRE',
  'Brighton & Hove Albion': 'BHA',
  'Chelsea': 'CHE',
  'Coventry City': 'COV',
  'Crystal Palace': 'CRY',
  'Everton': 'EVE',
  'Fulham': 'FUL',
  'Hull City': 'HUL',
  'Ipswich Town': 'IPS',
  'Leeds United': 'LEE',
  'Liverpool': 'LIV',
  'Manchester City': 'MCI',
  'Manchester United': 'MUN',
  'Newcastle United': 'NEW',
  'Nottingham Forest': 'NFO',
  'Sunderland': 'SUN',
  'Tottenham Hotspur': 'TOT',
};

const PREMIER_LEAGUE_ID = 15;

// Returns a map keyed by `${homeShort}-${awayShort}` -> { home, draw, away }
// (percentages), for whatever upcoming fixtures footballdata.io currently
// has probabilities for. Never throws — returns {} on any failure.
export async function fetchWinProbabilities(apiKey) {
  if (!apiKey) return {};
  try {
    const res = await fetch(`https://footballdata.io/api/v1/fixtures/upcoming?league_id=${PREMIER_LEAGUE_ID}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.error('footballdata.io fetch failed', res.status);
      return {};
    }
    const body = await res.json();
    const matches = body?.data?.matches || [];
    const map = {};
    for (const m of matches) {
      const homeShort = TEAM_NAME_TO_SHORT[m.home_team?.team_name];
      const awayShort = TEAM_NAME_TO_SHORT[m.away_team?.team_name];
      const result = m.probabilities;
      if (!homeShort || !awayShort || !result || !(result.home_win || result.away_win)) continue;
      map[`${homeShort}-${awayShort}`] = {
        home: result.home_win,
        draw: result.draw,
        away: result.away_win,
      };
    }
    return map;
  } catch (err) {
    console.error('footballdata.io enrichment error', err);
    return {};
  }
}

// Mutates a list of fixture objects ({ opponent, venue, ... }) in place,
// attaching `winProbability` (this specific team's own win % for that
// fixture) wherever a match is found. Shape-agnostic so it works for both
// fixturesByTeamId entries and fixtureSwings rows.
export function attachWinProbabilities(teamShort, fixtures, probabilityMap) {
  if (!teamShort || !fixtures) return;
  for (const fx of fixtures) {
    const key = fx.venue === 'H' ? `${teamShort}-${fx.opponent}` : `${fx.opponent}-${teamShort}`;
    const probs = probabilityMap[key];
    if (!probs) continue;
    fx.winProbability = fx.venue === 'H' ? probs.home : probs.away;
  }
}
