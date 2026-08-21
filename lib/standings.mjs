// Inferno 14 League — the group's classic (overall points) league, a
// separate league from the H2H one (see lib/h2h.mjs). Public FPL API, no
// login needed. Field names (rank, last_rank, entry_name, player_name,
// total, event_total) follow FPL's long-documented classic-league shape.
// Confirmed live against real GW1 data (2026-08-22): 17 real members,
// real scores.
const LEAGUE_ID = 57976;

export async function fetchLeagueStandings() {
  try {
    const res = await fetch(`https://fantasy.premierleague.com/api/leagues-classic/${LEAGUE_ID}/standings/`);
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
        gwPoints: r.event_total,
        totalPoints: r.total,
      };
    });
  } catch (err) {
    console.error('League standings fetch error', err);
    return [];
  }
}
