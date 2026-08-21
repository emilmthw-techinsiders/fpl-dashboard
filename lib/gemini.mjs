// Gemini's independent analysis layer — one of three independent "votes"
// combined in lib/consensus.mjs (the other two being our own deterministic
// scoring, and Groq's independent take). Gemini is given a wide, neutrally-
// sorted real player pool (see buildWidePool in insights.mjs) and asked to
// build its OWN starting XI, captain, and differential picks from scratch —
// it is NOT shown our own pre-computed shortlist first, because picking from
// a list our own formula already narrowed down isn't a genuine second
// opinion, it's just re-ranking our own bias. The only constraint is that
// every name it returns must exist in the given pool (validated below) —
// that's what actually prevents hallucination, not artificial narrowness.
//
// Using the "latest" alias rather than a pinned version — Google periodically
// retires specific model snapshots for new API keys (this project hit that
// with a hardcoded gemini-2.5-flash-lite), but the alias keeps pointing at
// whatever the current small/fast model is, so this doesn't need updating.
import { compactPoolForPrompt, teamNewsPromptBlock, scoutPicksPromptBlock } from './insights.mjs';

const MODEL = 'gemini-flash-lite-latest';

function buildPrompt(pool, chipWindows, recentResults, teamNews, scoutPicks) {
  return `You are one of three independent analysts feeding a personal Fantasy Premier League dashboard. Your job is to form your OWN view from the real data below — you are not shown anyone else's opinion, and your answer will be compared against theirs, so reason for yourself rather than playing it safe.

Below is a real, wide pool of currently-available Premier League players (already filtered to real minutes played, so no small-sample noise), each with real stats: price, form, ownership, expected points next gameweek (epNext), underlying xGI (combined expected goal involvement), defensive contribution, current news/status, and next fixture with its difficulty (1=easiest, 5=hardest) where known.

If it's pre-season, "form"/"epNext" above are still near-zero or carried over from last season — not meaningful yet on their own. Where a player has a "preseasonFriendlyStats" field, that's their REAL observed pre-season goals/assists this summer — the closest thing to genuine current form that exists right now, so weigh it accordingly alongside the underlying stats.

Treat "ownership" as a mild extra safety signal for your startingXI picks (NOT for differentials, which are already restricted to under 10% by definition): real managers converging on a pick have often implicitly priced in a nailed-on role, a fixture run, or team news you're not shown directly. Let it nudge genuinely close calls, never override a real gap in the stats above.

POOL:
${JSON.stringify(compactPoolForPrompt(pool), null, 2)}

Chip windows (only mention if asked, grounded strictly in this — never invent a gameweek number not in it): ${JSON.stringify(chipWindows || { doubles: [], blanks: [] })}
Recent resolved gameweeks: ${recentResults && recentResults.length ? recentResults.join('; ') : 'None yet this season.'}${teamNewsPromptBlock(teamNews)}${scoutPicksPromptBlock(scoutPicks)}

Using your own judgment on form, fixtures, and underlying stats:
1. Pick your own starting XI: exactly 11 real names from the pool above (any formation you think is best — you do not need to follow a fixed formation, just name who you'd actually start).
2. Pick a captain: exactly one name, and it MUST be one of your 11 startingXI picks.
3. Pick up to 9 differential picks: real names from the pool with genuine upside AND ownership under 10 percent — do not pick anyone at or above 10 percent ownership, no matter how good they look — these do not need to be in your startingXI.
4. One or two sentences of chip strategy (Wildcard/Free Hit/Bench Boost/Triple Captain timing), grounded strictly in the chip windows data given — never invent a gameweek number that isn't in it. If no useful chip timing applies right now, say so plainly rather than inventing advice.

Respond with ONLY a JSON object matching exactly this shape, no other text:
{
  "startingXI": ["exact name from POOL", ... exactly 11],
  "captainPick": "exact name from your startingXI",
  "differentialPicks": ["exact name from POOL", ... up to 9],
  "chipStrategy": "1-2 sentences"
}`;
}

function findExactName(name, pool) {
  if (!name) return null;
  const match = pool.find((p) => p.name.toLowerCase() === String(name).toLowerCase());
  return match ? match.name : null;
}

// Never throws — any failure (missing key, network error, quota, bad
// response shape, or a hallucinated name that fails validation against the
// real pool) just drops that field; lib/consensus.mjs treats a missing
// Gemini vote as simply one fewer voter, never a broken page.
export async function fetchGeminiRecommendation(apiKey, pool, chipWindows, recentResults, teamNews = null, scoutPicks = null) {
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(pool, chipWindows, recentResults, teamNews, scoutPicks) }] }],
          generationConfig: { maxOutputTokens: 1200, temperature: 0.5, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!res.ok) {
      console.error('Gemini fetch failed', res.status, await res.text());
      return null;
    }
    const body = await res.json();
    const raw = body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('Gemini returned non-JSON response', raw.slice(0, 200));
      return null;
    }

    const startingXI = Array.isArray(parsed.startingXI)
      ? [...new Set(parsed.startingXI.map((n) => findExactName(n, pool)).filter(Boolean))]
      : [];
    const captainPick = startingXI.includes(findExactName(parsed.captainPick, pool))
      ? findExactName(parsed.captainPick, pool)
      : null;
    // Hard filter, not just a prompt instruction — a model ignoring "under
    // 10%" shouldn't be able to sneak a non-differential into this list.
    const differentialPicks = Array.isArray(parsed.differentialPicks)
      ? [...new Set(parsed.differentialPicks.map((n) => findExactName(n, pool)).filter(Boolean))]
          .filter((n) => parseFloat(pool.find((p) => p.name === n)?.ownership) < 10)
          .slice(0, 9)
      : [];

    if (!startingXI.length) return null;

    return {
      source: 'gemini',
      model: MODEL,
      startingXI,
      captainPick,
      differentialPicks,
      chipStrategy: typeof parsed.chipStrategy === 'string' ? parsed.chipStrategy : null,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('Gemini enrichment error', err);
    return null;
  }
}
