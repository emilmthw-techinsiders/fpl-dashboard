// On-demand Gemini analysis shared by three tools: Rate My Squad, Compare
// Players, and Compare Teams. Unlike the daily Best XI/Differentials
// pipeline (called once a day from the cron worker), this is triggered by a
// user clicking a button, so it needs its own guardrails:
//  - the API key lives only in this Pages Function's secret, never sent to
//    the browser
//  - a single hard daily cap (well under Gemini's actual free-tier quota),
//    shared across all three tools and tracked in KV, so even heavy or
//    accidental repeated use across the whole dashboard can't run up usage
//
// For 'players' and 'teams', prompts stay strictly grounded in the given
// JSON — no invented names or stats, matching every other AI surface on this
// site. 'squad' is deliberately different: it's an explicit second opinion,
// so it's allowed to draw on Gemini's own football knowledge (a transfer's
// unsettled squad role, a preseason niggle, being rested pre-World Cup) on
// top of the given stats, and produces its OWN 0-100 score that can genuinely
// differ from the rule-based rating — the rule-based rating stays the
// verified, always-present number; this is a clearly-labeled second take.
const MODEL = 'gemini-flash-lite-latest';
const DAILY_CAP = 50;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function withinDailyCap(kv) {
  const key = `gemini-ai-analyze-calls:${today()}`;
  const current = Number((await kv.get(key)) || '0');
  if (current >= DAILY_CAP) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 172800 });
  return true;
}

function buildPrompt(kind, payload) {
  if (kind === 'players') {
    return `You are comparing real Fantasy Premier League players on a personal FPL dashboard.

Below is JSON with real stats for players the user already selected, and which one a rule-based formula currently recommends. Do not invent, guess, or add any player, stat, or fixture not present in this JSON, and do not contradict the numbers given.

DATA:
${JSON.stringify(payload, null, 2)}

Write a verdict in 3-4 short sentences (70 words max, plain text, no markdown): state your pick, whether it matches the rule-based recommendation, then back it up by naming at least 2-3 SPECIFIC metrics from the DATA above with their real values (e.g. "epNext 6.2 vs 4.1", "xGI 0.8 per 90", "form 7.5", "easier fixture run: 2.4 vs 3.6 avg difficulty", "£4.2m cheaper") — a reader should be able to see exactly which numbers drove the verdict, not just a restated total-points figure.`;
  }
  if (kind === 'teams') {
    return `You are comparing real Premier League teams' upcoming fixture runs on a personal FPL dashboard.

Below is JSON with real fixture-difficulty and squad stats for teams the user already selected, and which one a rule-based formula currently recommends. Do not invent, guess, or add any team, stat, or fixture not present in this JSON.

DATA:
${JSON.stringify(payload, null, 2)}

Write a verdict in 3-4 short sentences (70 words max, plain text, no markdown): state which team's run looks best to target, whether it matches the rule-based recommendation, then back it up by naming at least 2-3 SPECIFIC metrics from the DATA above with their real values (e.g. average fixture difficulty, win probability, attack/defence strength, number of favorable fixtures in the window) — a reader should be able to see exactly which numbers drove the verdict.`;
  }
  // kind === 'squad'
  return `You are giving a second opinion on a custom Fantasy Premier League squad on a personal FPL dashboard, alongside a rule-based rating.

Below is JSON with the squad's players (including injury/availability status, minutes played, and whether they're a recent transfer) and the rule-based rating for reference. That rating is purely numeric — it can't account for context like a new signing's unsettled squad role or someone who barely played last season. You MAY use your own general football knowledge for context like this, but do not contradict any specific stat given in the JSON (e.g. don't claim a different price or status than what's listed).

DATA:
${JSON.stringify(payload, null, 2)}

Give your OWN independent score out of 100 for this squad — it is allowed to differ from the rule-based rating if your broader read of the situation justifies it, but should usually sit close to it unless a real factor below justifies moving it. Then give a verdict in 3-4 short sentences (60 words max).

Hard rules for the verdict:
- Name at least two specific players from the DATA above by name (or one, if the squad is small/uniform enough that a second distinct point genuinely doesn't exist) — never a generic sentence with no player named.
- For each player named, cite the SPECIFIC real stat or fact driving that point (e.g. "Haaland's 8.2 epNext", "Smith's 0 minutes last season since his transfer", "Doe's 4.1 form after 3 easy fixtures") — not just a vague adjective like "in good form" with no number behind it.
- Only cite real football factors: a specific player's status/news/minutes/transfer recency, form, fixtures, ownership, or team balance. Never invent technical-sounding phrases like "data quality", "mappings", "structural anomalies", or anything not tied to an actual football fact about a named player.
- If nothing in the data stands out as a real risk or strength beyond what the rule-based score already reflects, say so plainly (e.g. "No major injury or transfer concerns here — this lines up with the rule-based score") instead of inventing a reason.

Respond with ONLY a JSON object matching exactly this shape, no other text:
{ "aiScore": <integer 0-100>, "verdict": "<your 3-4 sentence verdict>" }`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const kind = ['squad', 'players', 'teams'].includes(body?.kind) ? body.kind : 'squad';
  const payload = body?.payload ?? body; // squad calls used to send the payload directly at the top level

  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const allowed = await withinDailyCap(env.FPL_KV);
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'daily_cap_reached' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const generationConfig = kind === 'squad'
      ? { maxOutputTokens: 260, temperature: 0.5, responseMimeType: 'application/json' }
      : { maxOutputTokens: 220, temperature: 0.4 };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(kind, payload) }] }],
          generationConfig,
        }),
      }
    );
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'upstream_error' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
    const geminiBody = await res.json();
    const raw = geminiBody?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) {
      return new Response(JSON.stringify({ error: 'empty_response' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (kind === 'squad') {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return new Response(JSON.stringify({ error: 'empty_response' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      const aiScore = Number.isFinite(parsed.aiScore) ? Math.max(0, Math.min(100, Math.round(parsed.aiScore))) : null;
      const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : null;
      if (!verdict) {
        return new Response(JSON.stringify({ error: 'empty_response' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ aiScore, text: verdict }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    return new Response(JSON.stringify({ text: raw }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    // Never echo raw exception text to the client — it can carry upstream
    // API error bodies (which may include internal identifiers) or stack
    // details. Full detail goes to server-side logs only.
    console.error('ai-analyze exception', err);
    return new Response(JSON.stringify({ error: 'exception' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
