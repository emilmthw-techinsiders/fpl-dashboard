// Groq's independent analysis layer — the second of three independent
// "votes" combined in lib/consensus.mjs (alongside our own deterministic
// scoring and Gemini's independent take). Same wide, neutral real player
// pool as Gemini gets (see buildWidePool in insights.mjs), same task, no
// visibility into what the other two picked — genuinely independent, not a
// re-ranking of anyone else's shortlist.
//
// This runs once a day from cron, not per user request, so the speed/
// capacity tradeoff that matters for the interactive chat widget (see
// functions/fpl-chat.js) doesn't apply here — at one call/day, quality beats
// throughput, hence the larger 120b model as primary. Not qwen3.6 (burns its
// token budget on invisible reasoning) or groq/compound (live-tested as
// giving a confidently WRONG gameweek deadline from a misread web search) —
// everything here is grounded only in our own real KV data, never a live web
// search. reasoning_effort is pinned to 'low' for the same reason qwen3.6 was
// ruled out: gpt-oss models put reasoning in a separate response field, but
// it still consumes the same token budget as the actual JSON answer, so
// keeping it low avoids the answer getting truncated by its own reasoning.
//
// llama-3.3-70b-versatile/llama-3.1-8b-instant (the previous pair here) were
// deprecated by Groq with an August 16 2026 shutdown on the free/developer
// tier — migrated to Groq's own recommended replacements ahead of that date.
import { compactPoolForPrompt, teamNewsPromptBlock, scoutPicksPromptBlock } from './insights.mjs';

export const PRIMARY_MODEL = 'openai/gpt-oss-120b';
export const FALLBACK_MODEL = 'openai/gpt-oss-20b';

function buildPrompt(pool, chipWindows, recentResults, teamNews, scoutPicks) {
  return `You are one of three independent analysts feeding a personal Fantasy Premier League dashboard. Your job is to form your OWN view from the real data below — you are not shown anyone else's opinion, and your answer will be compared against theirs, so reason for yourself rather than playing it safe.

IMPORTANT: this data is fetched fresh right now, more current than anything you already "know" about these players from training. Your own prior knowledge of a player's club, injury status, transfer, retirement, or form is very possibly stale — treat every fact below (status, news, price, form, ownership, fixtures) as the current ground truth and never let a prior belief override it. If your own recollection of a player conflicts with what's given here, the data below wins, always. This applies to your reasoning throughout, not just the final picks.

Below is a real, wide pool of currently-available Premier League players (already filtered to real minutes played, so no small-sample noise), each with real stats: price, form, ownership, expected points next gameweek (epNext), underlying xGI (combined expected goal involvement), defensive contribution, current news/status, and next fixture with its difficulty (1=easiest, 5=hardest) where known.

If it's pre-season, "form"/"epNext" above are still near-zero or carried over from last season — not meaningful yet on their own. Where a player has a "preseasonFriendlyStats" field, that's their REAL observed pre-season goals/assists this summer — the closest thing to genuine current form that exists right now, so weigh it accordingly alongside the underlying stats.

Treat "ownership" as a mild extra safety signal for your startingXI picks (NOT for differentials, which are already restricted to under 10% by definition): real managers converging on a pick have often implicitly priced in a nailed-on role, a fixture run, or team news you're not shown directly. Let it nudge genuinely close calls, never override a real gap in the stats above.

POOL:
${JSON.stringify(compactPoolForPrompt(pool), null, 2)}

Chip windows (only mention if asked, grounded strictly in this — never invent a gameweek number not in it): ${JSON.stringify(chipWindows || { doubles: [], blanks: [] })}
Recent resolved gameweeks: ${recentResults && recentResults.length ? recentResults.join('; ') : 'None yet this season.'}${teamNewsPromptBlock(teamNews)}${scoutPicksPromptBlock(scoutPicks)}

Using your own judgment on form, fixtures, and underlying stats:
1. Pick your own starting XI: exactly 11 real names from the pool above (any formation you think is best — you do not need to follow a fixed formation, just name who you'd actually start). This has to work as a real squad on a real £100m budget across all 15 (XI + 4-man bench) — build a genuine PREMIUM + BALANCED team: 2-4 real standout picks (typically £8m+) anchoring it, with the rest genuinely competitive value picks in the realistic mid-price range, not simply the 11 highest-projected names regardless of price. An XI that's almost entirely £8m+ picks is not realistic — it leaves no room for a real bench and crowds out reliable mid-tier options that are often the better actual value.
2. Pick a captain: exactly one name, and it MUST be one of your 11 startingXI picks.
3. Pick up to 9 differential picks: real names from the pool with genuine upside AND ownership under 10 percent — do not pick anyone at or above 10 percent ownership, no matter how good they look — these do not need to be in your startingXI.
4. One or two sentences of chip strategy (Wildcard/Free Hit/Bench Boost/Triple Captain timing), grounded strictly in the chip windows data given — never invent a gameweek number that isn't in it. If no useful chip timing applies right now, say so plainly rather than inventing advice.

Respond with ONLY a JSON object matching exactly this shape, no other text, no markdown fences:
{"startingXI": ["exact name from POOL", ...exactly 11], "captainPick": "exact name from your startingXI", "differentialPicks": ["exact name from POOL", ...up to 9], "chipStrategy": "1-2 sentences"}`;
}

function findExactName(name, pool) {
  if (!name) return null;
  const match = pool.find((p) => p.name.toLowerCase() === String(name).toLowerCase());
  return match ? match.name : null;
}

async function callGroq(apiKey, model, prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.5,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Groq ${model} responded ${res.status}: ${errBody.slice(0, 500)}`);
  }
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('empty response');
  return text;
}

// Never throws — mirrors fetchGeminiRecommendation's failure behavior so
// lib/consensus.mjs treats a missing Groq vote as simply one fewer voter.
//
// forcedModel: used by refresh.mjs to request a SPECIFIC model rather than
// the normal primary→fallback order — this is how the Gemini-down stand-in
// works (see runRefresh): when Gemini fails, we call this again asking
// specifically for whichever Groq model DIDN'T already answer, so the
// stand-in opinion is genuinely distinct, not the same call repeated.
export async function fetchGroqRecommendation(apiKey, pool, chipWindows, recentResults, forcedModel = null, teamNews = null, scoutPicks = null) {
  if (!apiKey) return null;
  const prompt = buildPrompt(pool, chipWindows, recentResults, teamNews, scoutPicks);
  const modelOrder = forcedModel ? [forcedModel] : [PRIMARY_MODEL, FALLBACK_MODEL];
  try {
    let raw;
    let modelUsed;
    let lastErr;
    for (const model of modelOrder) {
      try {
        raw = await callGroq(apiKey, model, prompt);
        modelUsed = model;
        break;
      } catch (err) {
        lastErr = err;
        console.error(`Groq ${model} failed:`, err.message);
      }
    }
    if (!raw) throw lastErr || new Error('all Groq models failed');

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('Groq returned non-JSON response', raw.slice(0, 200));
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
      source: 'groq',
      modelUsed,
      startingXI,
      captainPick,
      differentialPicks,
      chipStrategy: typeof parsed.chipStrategy === 'string' ? parsed.chipStrategy : null,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('Groq enrichment error', err);
    return null;
  }
}
