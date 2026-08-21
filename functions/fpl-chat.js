// FPL AI chat assistant — a minimized-by-default chat widget backed by Groq,
// a separate free-tier provider from Gemini (used nowhere else on this site,
// independent quota).
//
// Live testing exposed a real failure mode: with only a small static context
// (gameweek/deadline/AI picks), the model fell back on its own frozen
// training knowledge whenever a specific player was named — and got it
// wrong (asserted a player was still at a club that isn't even in this
// season's Premier League, then invented a nonexistent player entirely when
// it didn't recognize a second name). Fix: scan the actual message text
// against our real 572-player database and inject any matches' real current
// data directly into the prompt, so the model never has to guess who
// someone is. This stays lean — only matched players' compact stats are
// added, not the full database — but it's the difference between "the model
// might know" and "the model is TOLD."
//
// Two models only, chosen after live testing (see project notes): both give
// clean, non-"thinking" output. Deliberately NOT using groq/compound's
// web-search tool-use models — live-tested and found to give a confidently
// WRONG gameweek deadline from a misread search result, worse than not
// answering. Anything factual the bot states comes from our own
// already-verified KV data, never a live web search.
//
// This is the interactive widget — unlike the once-daily consensus
// (lib/groq.mjs), a real person is waiting on this response, so the smaller
// 20b model is primary for speed; 120b is the fallback if 20b errors or
// rate-limits, trading a slower reply for still getting one. reasoning_effort
// is pinned to 'low' (see callGroq below) to keep replies snappy and to stop
// reasoning content from eating into the same token budget as the actual
// reply.
//
// llama-3.3-70b-versatile/llama-3.1-8b-instant (the previous pair here) were
// deprecated by Groq with an August 16 2026 shutdown on the free/developer
// tier — migrated to Groq's own recommended replacements ahead of that date.
import { teamNewsPromptBlock, scoutPicksPromptBlock } from '../lib/insights.mjs';

const PRIMARY_MODEL = 'openai/gpt-oss-20b';
const FALLBACK_MODEL = 'openai/gpt-oss-120b';

// Well under 70b's real free-tier ceiling (~100/day by token budget) — this
// is a backstop against abuse/bugs for a 14-person league, not a number we
// expect to ever approach in real use.
const DAILY_CAP = 80;
// Last 3 user+assistant exchanges only, to keep per-message token growth
// bounded — a long chat shouldn't quietly balloon token usage each turn.
const MAX_HISTORY_MESSAGES = 6;
const MAX_MESSAGE_LENGTH = 500;
const MAX_MATCHED_PLAYERS = 5;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function withinDailyCap(kv) {
  const key = `groq-chat-calls:${today()}`;
  const current = Number((await kv.get(key)) || '0');
  if (current >= DAILY_CAP) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 172800 });
  return true;
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (João -> joao)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim();
}

// Matches on web_name, the last word of the full name (surname), OR the
// first word of the full name (first name) — so "Ndiaye", "Dewsbury-Hall",
// and a first-name-only reference all hit — checked against the current
// message PLUS recent history, so a name mentioned a turn or two ago still
// stays grounded. Real duplicate-surname risk (multiple players can share
// one) is handled by returning every match, not just the first hit — the
// model gets both and the team names to tell them apart, rather than
// silently picking the wrong one.
function findMentionedPlayers(text, allPlayers, limit) {
  const haystack = ` ${normalize(text)} `;
  const seen = new Set();
  const matches = [];
  for (const p of allPlayers) {
    if (matches.length >= limit) break;
    const keys = new Set();
    if (p.name) keys.add(normalize(p.name));
    if (p.fullName) {
      const parts = normalize(p.fullName).split(/\s+/).filter(Boolean);
      if (parts.length) {
        keys.add(parts[parts.length - 1]);
        keys.add(parts[0]);
      }
    }
    for (const key of keys) {
      if (key.length >= 4 && haystack.includes(` ${key} `) && !seen.has(p.id)) {
        seen.add(p.id);
        matches.push(p);
        break;
      }
    }
  }
  return matches;
}

// Real per-gameweek defensive data (tackles, clearances/blocks/interceptions,
// recoveries, and the Defensive Contribution bonus-point hit rate derived
// from them) — from the same free dataset (see lib/playerStats.mjs), which
// FPL's own bootstrap-static never exposes at this granularity. Only
// meaningful once real gameweeks exist (apps > 0), so omitted otherwise
// rather than showing a wall of preseason zeros.
function findRichStats(playerId, playerStats) {
  const row = playerStats?.find((p) => p.id === playerId);
  if (!row || !row.apps) return null;
  return {
    tackles: row.tackles,
    clearancesBlocksInterceptions: row.cbi,
    recoveries: row.recoveries,
    defensiveContributionHits: row.dcHits,
    defensiveContributionHitRate: `${row.dcHitPct}%`,
  };
}

function setPieceRole(p) {
  const roles = [];
  if (p.penaltyOrder === 1) roles.push('1st-choice penalty taker');
  else if (p.penaltyOrder) roles.push(`penalty taker (order ${p.penaltyOrder})`);
  if (p.cornerFreekickOrder === 1) roles.push('1st-choice corners/free-kicks');
  if (p.directFreekickOrder === 1) roles.push('1st-choice direct free-kicks');
  return roles.length ? roles.join(', ') : null;
}

// Includes the real underlying probability stats (xG/xA/xGI, ICT breakdown,
// defensive contribution) that the site's OWN scoring engine uses — not just
// surface fields like price/status — so the model has real material to
// reason over instead of just parroting a pre-computed verdict back. Also
// includes set-piece duty (penalties/corners/free-kicks) since that's a real,
// often-decisive FPL factor a manager would actually ask about.
function compactPlayer(p, playerStats = null) {
  const richStats = playerStats ? findRichStats(p.id, playerStats) : null;
  return {
    name: p.name,
    fullName: p.fullName,
    team: p.team,
    position: p.position,
    price: p.price,
    status: p.status === 'a' ? 'available' : p.status === 'd' ? 'doubtful' : p.status === 'i' ? 'injured' : p.status === 's' ? 'suspended' : p.status,
    news: p.news || null,
    form: p.form,
    pointsPerGame: p.pointsPerGame,
    totalPoints: p.totalPoints,
    ownership: p.ownership,
    minutes: p.minutes,
    epNext: p.epNext,
    nextFixture: p.nextFixture,
    xG: p.xG,
    xA: p.xA,
    xGI: p.xGI,
    ictIndex: p.ictIndex,
    defensiveContribution: p.defensiveContribution,
    setPieceRole: setPieceRole(p),
    ...(richStats ? { richDefensiveStats: richStats } : {}),
  };
}

// Real bug caught in production: a question like "top 3 forwards?" names no
// specific player, so matchedPlayers is empty and the only forward the model
// had was whichever one happened to be team captain. First fix sorted this
// pool by epNext before capping it — which is exactly the "postman" mistake
// already ruled out for the daily consensus (see buildWidePool in
// lib/insights.mjs): pre-ranking by the quality metric we want the AI to
// reason about means it never even SEES whoever we didn't already decide
// was good, so it's not independent analysis, just us handing over an
// answer. Fixed the same way buildWidePool already solves it: sort only by
// minutes played (a neutral reliability filter, not a judgment call), so
// the model gets a genuinely wide, unranked-by-us pool and has to actually
// weigh epNext/form/xGI/fixtures itself.
//
// Caps kept deliberately smaller than buildWidePool's own (which feeds the
// once-a-day consensus, not a per-message interactive endpoint): a real
// production failure confirmed a multi-player comparison question hit
// Groq's TPM limit (413: "Limit 8000, Requested 8239") — this block plus
// several matched players plus conversation history all share the same
// 8000-token/minute ceiling, and switching models on fallback doesn't help
// since both models hit the exact same limit on the exact same prompt. This
// still comfortably solves the original "I only have one forward" problem
// without needing anywhere near 38 players in the pool.
const RELIABLE_MINUTES = 180; // mirrors lib/insights.mjs's own threshold
const CHAT_POOL_CAPS = { GKP: 3, DEF: 5, MID: 6, FWD: 4 };

// Trimmed field set for this block specifically — compactPlayer's full shape
// (fullName, minutes, xG/xA separately, threat/creativity/influence, ...) is
// fine for the small matched-player/candidate lists elsewhere in this prompt,
// but at up to 38 players here it's the same request-size territory that
// already caused a real Groq 413 error for the daily consensus's wide pool
// (see lib/insights.mjs's compactPoolForPrompt, which exists for the exact
// same reason). Keeps only what's needed to actually reason about ranking —
// including fixture difficulty (1=easiest, 5=hardest, same scale as the rest
// of the site), a real bug caught in testing: the first cut of this trim
// dropped fixture info entirely, so "best midfielders for GW3" answers never
// factored in who actually has an easy or hard game that week.
function compactForRanking(p, fixturesByTeamId, gameweekId) {
  const fixture = (fixturesByTeamId?.[p.teamId] || []).find((f) => f.event === gameweekId);
  return {
    name: p.name, team: p.team, position: p.position, price: p.price,
    status: p.status, news: p.news || null, form: p.form, ownership: p.ownership,
    epNext: p.epNext, xGI: p.xGI, ictIndex: p.ictIndex,
    defensiveContribution: p.defensiveContribution, setPieceRole: setPieceRole(p),
    nextFixture: p.nextFixture, fixtureDifficulty: fixture?.difficulty ?? null,
  };
}

function topPlayersByPosition(allPlayers, fixturesByTeamId, gameweekId) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const p of allPlayers) {
    if (p.status === 'a' && num(p.minutes) >= RELIABLE_MINUTES && byPos[p.position]) byPos[p.position].push(p);
  }
  const result = {};
  for (const pos of Object.keys(CHAT_POOL_CAPS)) {
    result[pos] = byPos[pos]
      .sort((a, b) => num(b.minutes) - num(a.minutes))
      .slice(0, CHAT_POOL_CAPS[pos])
      .map((p) => compactForRanking(p, fixturesByTeamId, gameweekId));
  }
  return result;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function buildSystemPrompt(data, matchedPlayers, scoutPicks) {
  const ai = data?.ai || {};
  const context = {
    gameweek: data?.gameweek || 'unknown',
    deadline: data?.deadline || 'unknown',
    isPreseason: data?.isPreseason ?? null,
  };

  // Already part of the same KV payload `data` comes from (built every cron
  // run — see lib/playerStats.mjs) — no separate fetch needed. Threaded into
  // the smaller blocks below (matched players, captaincy/differential
  // candidates) but deliberately NOT into the wide topByPosition pool — that
  // pool alone already caused a real Groq 413 "request too large" error in
  // production once, and adding more fields per entry across ~18 entries
  // would risk the exact same failure.
  const playerStats = data?.playerStats || null;
  const enrich = (p) => compactPlayer(p, playerStats);

  const captaincyCandidates = (data?.bestXI?.captaincyPicks || []).map((p) => ({ ...enrich(p), whyShortlisted: p.reason || null }));
  const differentialCandidates = (data?.differentials || []).slice(0, 8).map((p) => ({ ...enrich(p), whyShortlisted: p.reason || null }));
  const topByPosition = topPlayersByPosition(data?.allPlayers || [], data?.fixturesByTeamId, data?.gameweekId);

  // Team News scoped to teams actually relevant here (captaincy/differential
  // candidates + any player named in the conversation), NOT a blanket dump
  // of all 20 clubs — the wide topByPosition pool below already caused a
  // real Groq 413 "request too large" error in production once (see its own
  // comment), and an unconditional 20-team Team News block on top of that
  // measured ~900 extra tokens, enough to risk tripping the exact same
  // ceiling again. Scoping to what's actually being discussed keeps this
  // small in the common case while still surfacing real signal when it's
  // genuinely relevant.
  const relevantTeams = new Set([
    ...captaincyCandidates.map((p) => p.team),
    ...differentialCandidates.map((p) => p.team),
    ...matchedPlayers.map((p) => p.team),
  ]);
  const scopedTeamNews = data?.teamNews
    ? Object.fromEntries(Object.entries(data.teamNews).filter(([team]) => relevantTeams.has(team)))
    : null;

  const playerBlock = matchedPlayers.length
    ? `\n\nReal current data for players named in this conversation (this IS the dashboard's live squad database — treat it as ground truth, do not contradict it):\n${JSON.stringify(matchedPlayers.map(enrich), null, 2)}`
    : '';

  const captainSourcesText = Array.isArray(ai.captainSources) && ai.captainSources.length ? ai.captainSources.join(' + ') : 'not yet computed';

  const candidateBlock = `\n\nToday's top-3 captaincy candidates (already a 3-way consensus of FPL Data (our own deterministic scoring), Gemini, and Groq — "whyShortlisted" names which of the 3 sources agreed and the real expected points):\n${JSON.stringify(captaincyCandidates, null, 2)}

Today's top differential candidates (same 3-way consensus, low-ownership high-ceiling picks), same real stats:\n${JSON.stringify(differentialCandidates, null, 2)}

For reference only: the final consensus captain today is ${ai.captainPick || 'not yet computed'} (agreed by: ${captainSourcesText}), with ${ai.viceCaptainPick || 'not yet computed'} as vice-captain (the runner-up on the same ranking, steps in for points if the captain doesn't play).${ai.chipStrategy ? ` Chip strategy guidance: ${ai.chipStrategy}` : ''}

Wide, real available player pool by position — filtered to established players (real minutes played) and otherwise UNRANKED by us, listed in no particular order of quality, so you have to actually weigh epNext/form/xGI/set-piece duty yourself rather than assume whoever's listed first is best. Each entry includes "fixtureDifficulty" for THIS gameweek (1=easiest, 5=hardest, null if unknown) and "nextFixture" (opponent + venue) — an easy fixture is a real, often decisive factor for who to actually start/target this week specifically, not just a generic "who's good" ranking, so always factor it in and mention it when it's relevant. Use this for any "best/top N [position]" or general ranking question, not just the captaincy/differential lists above, which are narrower shortlists for a different purpose:
Goalkeepers: ${JSON.stringify(topByPosition.GKP)}
Defenders: ${JSON.stringify(topByPosition.DEF)}
Midfielders: ${JSON.stringify(topByPosition.MID)}
Forwards: ${JSON.stringify(topByPosition.FWD)}`;

  return `You are the FPL AI assistant on "Inferno FPL", a personal Fantasy Premier League dashboard built for a 14-person family mini-league.

Answer questions about Fantasy Premier League strategy, rules, and general football conversation.

Think independently. You're given the same real underlying stats (form, xG/xA/xGI, ICT index, defensive contribution, set-piece duty, fixtures) the site's own scoring engine uses — actually weigh them yourself rather than just repeating the "for reference" pre-computed pick as if it were your own conclusion. It's fine to agree with it if the numbers back it up, and fine to disagree and recommend something else if your own read of the real stats says otherwise. When set-piece duty (penalties/corners/free-kicks) is available for a player being discussed, factor it in — it's a real, often decisive scoring path.

Formatting — this matters, answers have looked like dense walls of text:
- Keep it tight: no filler, no restating the question.
- Comparing 2+ players/options? Don't write one long paragraph. Give each option its own short line (name — 1-2 key numbers that actually decide it), then a final line starting with "Recommendation:" that states your pick and the one deciding reason. Use real line breaks between them, not commas run together.
- A single-player question just gets 1-3 tight sentences, no headers needed for that case.

Hard rules:
- Only state a player's club, price, status, or stats if it appears in the data blocks below. Your own training knowledge of transfers/clubs is very likely OUT OF DATE for this season — never assert a player's club or status from memory.
- If the user names a player who is NOT in the data below, say plainly that you don't have them in the current squad database and ask the user to confirm the full name or check the dashboard's search. NEVER guess, invent, or substitute a different "similar-sounding" player — that has caused real, embarrassing mistakes before.
- If asked for a stat not given anywhere below, say you don't have that exact figure and point to the dashboard's Best XI, Differentials, Injury Watch, or Compare tools.
- The ONLY real FPL chips this season (2026/27) are: Wildcard, Free Hit, Triple Captain, and Bench Boost — each available TWICE (once in each half of the season; the first set must be used before the Gameweek 19 deadline or it's lost, and only one chip can be played per gameweek). There is no "Assistant Manager", "Triple Transfer", "Captains' Challenge", or any other chip — never invent a chip name that isn't one of these four.
- Treat this like a real conversation with a person, not a rigid query interface — expect ranking questions phrased loosely ("top 3 forwards", "who are the best midfielders", "who's more likely to score this week", "who has a better chance of returning points", "who should I bring in") as all asking essentially the same thing: YOU rank real players using the real stats given — epNext (FPL's own forward-looking projection), xGI, form, and fixture difficulty are all real signals to weigh, but the wide player pool below is deliberately NOT pre-sorted by quality, so this has to be your own analysis, not a lookup of whoever happens to be listed first. Don't say you "only have one forward" or similar just because nobody happens to be named in the conversation yet — check the wide player pool below first.

Today's real context (from this morning's data refresh):
${JSON.stringify(context, null, 2)}${candidateBlock}${playerBlock}${teamNewsPromptBlock(scopedTeamNews)}${scoutPicksPromptBlock(scoutPicks)}

Stay strictly on-topic: Fantasy Premier League and real football only. Politely decline anything unrelated (homework, coding, general chit-chat, etc.) and steer the conversation back to FPL.`;
}

async function callGroq(apiKey, model, messages) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 500,
      temperature: 0.5,
      reasoning_effort: 'low',
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

  const message = typeof body?.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
  const history = Array.isArray(body?.history)
    ? body.history
        .slice(-MAX_HISTORY_MESSAGES)
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LENGTH) }))
    : [];

  if (!message) {
    return new Response(JSON.stringify({ error: 'empty_message' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!env.GROQ_API_KEY) {
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

  let data = null;
  try {
    const raw = await env.FPL_KV.get('latest');
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  // Real official FPL Scout Picks (see public/scoutPicks.json) — not part of
  // the KV blob itself (only used transiently during the daily refresh to
  // ground the Gemini/Groq consensus), so fetched fresh here too, same
  // best-effort, gameweek-matched pattern as lib/refresh.mjs. Cheap static
  // file, no added AI/API cost.
  let scoutPicks = null;
  try {
    const scoutPicksRes = await fetch('https://inferno-fpl.pages.dev/scoutPicks.json');
    if (scoutPicksRes.ok) {
      const parsed = await scoutPicksRes.json();
      if (parsed?.visible && parsed.gameweek === data?.gameweekId) scoutPicks = parsed;
    }
  } catch {
    scoutPicks = null;
  }

  const searchText = [...history.map((m) => m.content), message].join(' ');
  const matchedPlayers = findMentionedPlayers(searchText, data?.allPlayers || [], MAX_MATCHED_PLAYERS);

  const messages = [
    { role: 'system', content: buildSystemPrompt(data, matchedPlayers, scoutPicks) },
    ...history,
    { role: 'user', content: message },
  ];

  try {
    let reply;
    try {
      reply = await callGroq(env.GROQ_API_KEY, PRIMARY_MODEL, messages);
    } catch (primaryErr) {
      console.error(`Groq primary (${PRIMARY_MODEL}) failed, trying fallback:`, primaryErr.message);
      reply = await callGroq(env.GROQ_API_KEY, FALLBACK_MODEL, messages);
    }
    return new Response(JSON.stringify({ reply }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    console.error('Groq fallback also failed:', err.message);
    return new Response(JSON.stringify({ error: 'upstream_error' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
