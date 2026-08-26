// Real, per-team news facts for the "Team News" tab — grounded entirely in
// FPL's own official bootstrap-static news/status fields (already fetched
// every refresh, zero extra cost) plus each team's real established squad
// (so the AI has enough to reason about who's actually likely to start).
//
// Deliberately does NOT scrape or reproduce any third-party or Premier
// League editorial article text (e.g. fantasyfootballscout.co.uk or
// premierleague.com/en/news/* "team news" writeups) — that's their
// copyrighted journalism, not a public data feed. The AI call below writes
// an ORIGINAL summary/prediction from the real structured facts only, in
// the same spirit as those pages but never a copy of their words.
const MODEL = 'gemini-flash-lite-latest';
const POSITION = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const SQUAD_CAP = 18;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export function buildTeamNewsFacts(elements, teams, nextFixtureMap) {
  const byTeam = {};
  for (const t of teams) byTeam[t.id] = [];
  for (const e of elements) {
    if (e.removed || !byTeam[e.team]) continue;
    byTeam[e.team].push(e);
  }
  return teams
    .map((t) => {
      const squad = (byTeam[t.id] || [])
        .sort((a, b) => num(b.minutes) - num(a.minutes))
        .slice(0, SQUAD_CAP)
        .map((e) => ({
          name: e.web_name,
          position: POSITION[e.element_type],
          status: e.status, // a=available, d=doubtful, i=injured, s=suspended
          news: e.news || null,
          minutes: num(e.minutes),
        }));
      const fx = nextFixtureMap[t.id];
      return {
        teamId: t.id,
        team: t.short_name,
        teamName: t.name,
        nextFixture: fx ? `${fx.opponent} (${fx.venue})` : null,
        // Real request (2026-08-26): early in a gameweek, before a club's
        // own pre-match press conference has happened, "no fresh injury
        // concerns" just means nothing NEW has been officially reported
        // yet, not that the squad is confirmed fully fit — worth surfacing
        // that distinction rather than reading as more certain than it is.
        // Carried through as a raw timestamp (not a pre-baked "in 2 days"
        // string) so the frontend can compute an always-accurate countdown
        // at render time, however long this cached result sits around for.
        kickoff: fx?.kickoff ?? null,
        squad,
      };
    })
    .filter((t) => t.squad.length);
}

function buildPrompt(teamFacts) {
  return `You are writing short, original "team news" previews for a personal Fantasy Premier League dashboard — one per real Premier League club, ahead of their next fixture. This is NOT a copy of any news site — write your own words from the real data given.

Below is REAL data for each club: their next fixture, and their established squad (name, position, official FPL availability status [a=available, d=doubtful, i=injured, s=suspended], any official news text, and real minutes played this season as a reliability/nailed-on signal).

For EACH team below, produce:
1. "newsSummary": 2-3 short plain-text sentences (no markdown) summarizing real injury/availability news for that club, grounded ONLY in the "news"/"status" fields given — never invent an injury, a return date, or a quote not present in the data. If nothing is flagged, say so plainly (e.g. "No fresh injury concerns — squad looks fully available.").
2. "predictedXI": your own best-guess likely starting XI — exactly 11 real names from that team's squad list above. Reason from real minutes played (reliability/nailed-on signal) and current status/news (never predict a starter who is injured/suspended/status "i" or "s"). You may use general knowledge of this real club's usual system/personnel for context, but never contradict the status/news data given.

TEAMS:
${JSON.stringify(teamFacts, null, 2)}

Respond with ONLY a JSON object matching exactly this shape, no other text, no markdown fences:
{"teams": [{"team": "<short_name from data>", "newsSummary": "...", "predictedXI": ["name", "...exactly 11"]}, "...one entry per team given"]}`;
}

// Never throws — a failed/missing call just means the Team News tab shows
// its empty state and the rest of the refresh (Best XI, differentials, etc.)
// is completely unaffected, same non-fatal contract as every other
// enrichment fetch in lib/refresh.mjs.
export async function fetchTeamNewsAI(apiKey, teamFacts) {
  if (!apiKey || !teamFacts.length) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(teamFacts) }] }],
          generationConfig: { maxOutputTokens: 4500, temperature: 0.4, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!res.ok) {
      console.error('Team news AI fetch failed', res.status, await res.text());
      return null;
    }
    const body = await res.json();
    const raw = body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('Team news AI returned non-JSON response', raw.slice(0, 200));
      return null;
    }
    if (!Array.isArray(parsed.teams)) return null;

    const byTeam = Object.fromEntries(teamFacts.map((t) => [t.team, t]));
    const result = {};
    for (const row of parsed.teams) {
      const fact = byTeam[row.team];
      if (!fact) continue;
      const squadNames = new Set(fact.squad.map((p) => p.name));
      // Hard filter against the real squad list, same pattern as the
      // Gemini/Groq consensus name validation — a hallucinated name can
      // never sneak into a predicted lineup.
      const predictedXI = Array.isArray(row.predictedXI)
        ? [...new Set(row.predictedXI.filter((n) => squadNames.has(n)))]
        : [];
      result[row.team] = {
        newsSummary: typeof row.newsSummary === 'string' ? row.newsSummary : null,
        predictedXI,
        nextFixture: fact.nextFixture,
        kickoff: fact.kickoff,
      };
    }
    return Object.keys(result).length ? result : null;
  } catch (err) {
    console.error('Team news AI error', err);
    return null;
  }
}
