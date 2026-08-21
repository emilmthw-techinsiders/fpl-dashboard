// Real team-strength signal (Elo ratings sourced from ClubElo.com) pulled
// from the free, open, twice-daily-refreshed dataset at
// github.com/olbauday/FPL-Core-Insights — no API key, no per-call cost, just
// a static CSV fetch, same pattern as public/friendlies.json.
//
// Deliberately reads LAST season's final teams.csv, not the current season's:
// the current season's `elo` column stays empty until enough of this
// season's own matches have been played for Elo to compute anything, so
// last season's final rating is the best real signal available right now —
// same "use the freshest real thing there is" reasoning as the preseason
// friendlies weighting. Newly-promoted teams (no top-flight fixtures last
// season) simply won't have an entry here — callers must treat a missing
// team as "unknown", never fabricate a number for it.
const ELO_URL = 'https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data/2025-2026/teams.csv';

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
  });
}

// Returns { [teamCode]: eloNumber } keyed by FPL's own team `code` field
// (the stable cross-season/cross-source join key — team `id` differs by
// dataset ordering, but `code` is the same real-world team identifier FPL's
// own bootstrap-static teams also carry). Never throws — a failure here
// should just mean "no Elo signal this run", exactly like a missing
// friendlies fetch, not a broken refresh.
export async function fetchEloRatings() {
  try {
    const res = await fetch(ELO_URL);
    if (!res.ok) return null;
    const text = await res.text();
    const rows = parseCsv(text);
    const map = {};
    for (const row of rows) {
      const elo = parseFloat(row.elo);
      if (row.code && Number.isFinite(elo)) map[row.code] = elo;
    }
    return Object.keys(map).length ? map : null;
  } catch (err) {
    console.error('Elo ratings fetch failed (non-fatal)', err.message);
    return null;
  }
}
