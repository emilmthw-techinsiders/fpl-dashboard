// The single refresh pipeline — fetch FPL + footballdata.io + Gemini, run
// the deterministic scoring, and write one snapshot to KV. Shared by the
// daily cron worker and the on-demand force-refresh Pages Function so
// there's exactly one code path (no logic duplicated, no risk of the two
// diverging). This does NOT touch the pick-locking mechanism at all —
// ensurePendingEntry (in history.mjs) already scopes freezing to only
// lockedBestXI/lockedDifferentials/lockedAi, so calling this more often than
// once a day never lets those change outside their normal lock window; every
// other section (fixtures, injuries, prices, win%) always refreshes freely.
import { computeInsights, buildWidePool, buildBudgetSafetyNet, nextFixtureByTeam } from './insights.mjs';
import { resolvePendingEntries, determineActiveGwId, ensurePendingEntry } from './history.mjs';
import { fetchWinProbabilities, attachWinProbabilities } from './footballdata.mjs';
import { fetchEloRatings } from './eloRatings.mjs';
import { fetchPlayerStatsAgg } from './playerStats.mjs';
import { buildTeamNewsFacts, fetchTeamNewsAI } from './teamNews.mjs';
import { fetchGeminiRecommendation } from './gemini.mjs';
import { fetchGroqRecommendation, PRIMARY_MODEL as GROQ_PRIMARY_MODEL, FALLBACK_MODEL as GROQ_FALLBACK_MODEL } from './groq.mjs';
import { mergeBestXI, mergeCaptain, mergeDifferentials, buildLookup, groupIntoRows } from './consensus.mjs';
import { refreshH2HFixtures } from './h2h.mjs';
import { fetchLeagueStandings } from './standings.mjs';

export async function runRefresh(env) {
  const previousRaw = await env.FPL_KV.get('latest');
  const previous = previousRaw ? JSON.parse(previousRaw) : null;

  const [bootstrapRes, fixturesRes] = await Promise.all([
    fetch('https://fantasy.premierleague.com/api/bootstrap-static/'),
    fetch('https://fantasy.premierleague.com/api/fixtures/'),
  ]);

  if (!bootstrapRes.ok || !fixturesRes.ok) {
    console.error('FPL API fetch failed', bootstrapRes.status, fixturesRes.status);
    return false;
  }

  const bootstrap = await bootstrapRes.json();
  const fixtures = await fixturesRes.json();

  let history = await resolvePendingEntries(previous?.history, bootstrap);
  const activeGwId = determineActiveGwId(history, bootstrap);

  // Cost/freshness split: this refresh runs every 30 minutes so that live
  // gameweek scores/points (resolvePendingEntries above, and fixtures below)
  // stay near-real-time during actual match play. But the EXPENSIVE part —
  // Team News AI, Scout Picks weighting, and the Gemini/Groq consensus that
  // drives Best XI/Differentials/AI Recommendation — only needs to run (a)
  // occasionally while the gameweek is still open (a "preview" that doesn't
  // need to be fresher than every few hours), and (b) once for real right as
  // it crosses into the lock window (see lib/history.mjs). Once truly locked,
  // that computation would just be discarded (ensurePendingEntry never reads
  // it again — see the hard-freeze comment there), so paying for it on every
  // 30-minute tick post-lock would be pure waste. Skipping it there also
  // means most ticks during an actual live gameweek do zero AI calls at all.
  const activeEntry = history.find((e) => e.event === activeGwId);
  const alreadyLocked = !!activeEntry?.lockedBestXI;
  const AI_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
  const lastAiRunAtRaw = await env.FPL_KV.get('lastAiRunAt');
  const msSinceLastAiRun = lastAiRunAtRaw ? Date.now() - new Date(lastAiRunAtRaw).getTime() : Infinity;
  const runExpensiveAI = !alreadyLocked && msSinceLastAiRun >= AI_REFRESH_INTERVAL_MS;

  // Real official FPL Scout Picks, manually refreshed each gameweek (see
  // public/scoutPicks.json and lib/insights.mjs's scoutPicksPromptBlock) —
  // a best-effort, zero-cost static file fetch. Only used if its `gameweek`
  // actually matches this refresh's active gameweek, so a file that hasn't
  // been updated yet for a new week is silently ignored rather than fed in
  // as if it were current.
  let scoutPicks = null;
  try {
    const scoutPicksRes = await fetch('https://inferno-fpl.pages.dev/scoutPicks.json');
    if (scoutPicksRes.ok) {
      const parsed = await scoutPicksRes.json();
      if (parsed?.visible && parsed.gameweek === activeGwId) scoutPicks = parsed;
    }
  } catch (err) {
    console.error('scoutPicks.json fetch failed (non-fatal)', err.message);
  }

  // Real team-strength signal (see lib/eloRatings.mjs) — a genuine
  // season-long read on team quality, stays in play all year.
  const eloByCode = await fetchEloRatings();

  // Real per-gameweek player stats (tackles/CBI/recoveries/DC-hits) — see
  // lib/playerStats.mjs. Best-effort: powers the Player Statistics / Stats
  // Per Gameweek pages, never blocks the refresh. Only ever fetches
  // gameweeks FPL itself already reports as finished — pre-season that's an
  // empty array (zero network calls), growing to the real played gameweeks
  // as the season progresses.
  const finishedGwIds = bootstrap.events.filter((e) => e.finished).map((e) => e.id);
  const statsAgg = await fetchPlayerStatsAgg(finishedGwIds);

  const insights = computeInsights(bootstrap, fixtures, activeGwId, eloByCode, statsAgg);

  const teamsById = Object.fromEntries(bootstrap.teams.map((t) => [t.id, t]));
  const nextFixtureMap = nextFixtureByTeam(bootstrap.teams, fixtures);

  // Real, official per-player news/status facts (zero extra cost, already
  // fetched above) synthesized by AI into an original per-team news summary
  // + predicted lineup — powers the Team News tab, and is also fed as extra
  // grounding context into the Gemini/Groq consensus prompts below (see
  // teamNewsPromptBlock in lib/insights.mjs), so Best XI/Differentials/AI
  // Recommendation weigh "who's actually likely to start" alongside the raw
  // stats. Gated by runExpensiveAI (see above) — when skipped, reuse the
  // previous run's teamNews rather than going blank, so the Team News tab
  // doesn't flicker empty every tick it isn't due for a refresh.
  let teamNews = previous?.teamNews ?? null;
  if (runExpensiveAI) {
    const teamNewsFacts = buildTeamNewsFacts(bootstrap.elements, bootstrap.teams, nextFixtureMap);
    teamNews = await fetchTeamNewsAI(env.GEMINI_API_KEY, teamNewsFacts);
  }

  // Best-effort enrichment — win probabilities layered on top of FPL's own
  // fixture difficulty. Never blocks or breaks the refresh if unavailable.
  const probabilityMap = await fetchWinProbabilities(env.FOOTBALLDATA_API_KEY);
  if (Object.keys(probabilityMap).length) {
    for (const [teamId, teamFixtures] of Object.entries(insights.fixturesByTeamId)) {
      attachWinProbabilities(teamsById[teamId]?.short_name, teamFixtures, probabilityMap);
    }
    for (const row of insights.fixtureSwings.teams) {
      attachWinProbabilities(row.team, row.fixtures, probabilityMap);
    }
  }

  // Three-way consensus: our own deterministic scoring, Gemini, and Groq each
  // independently analyze the SAME wide, neutrally-sorted real player pool
  // (no visibility into each other's pick, and no pre-filtered shortlist
  // from our own formula — that would just be re-ranking our own bias, not a
  // genuine second/third opinion) and vote. Computed BEFORE ensurePendingEntry
  // so that if this refresh crosses into the locked window, the consensus
  // freezes in the same instant as everything else. Never blocks the refresh
  // if either AI call fails or a key is missing — a missing vote is just one
  // fewer voter, the page never breaks.
  //
  // Gated by runExpensiveAI (see top of function) — skipped entirely once
  // locked (pure waste, ensurePendingEntry will never read a fresh result
  // again) and throttled to once per AI_REFRESH_INTERVAL_MS while still
  // open, rather than recomputing on every 30-minute tick. When skipped,
  // reuse the previous run's bestXI/differentials/ai wholesale instead of a
  // partial recompute with Gemini/Groq missing — a partial merge would show
  // a misleading "1/3 votes" for players the AI voters would actually have
  // agreed with too, if they'd been asked this tick.
  let ai;
  if (runExpensiveAI) {
  const widePool = buildWidePool(bootstrap.elements, teamsById, nextFixtureMap, insights.fixturesByTeamId, activeGwId);
  const recentResults = (history || [])
    .filter((e) => e.status === 'complete')
    .sort((a, b) => b.event - a.event)
    .slice(0, 3)
    .map((e) => `GW${e.event}: ${e.summary}`);

  const [geminiResult, groqResult] = await Promise.all([
    fetchGeminiRecommendation(env.GEMINI_API_KEY, widePool, insights.chipWindows, recentResults, teamNews, scoutPicks),
    fetchGroqRecommendation(env.GROQ_API_KEY, widePool, insights.chipWindows, recentResults, null, teamNews, scoutPicks),
  ]);

  // Genuine fallback for when Gemini is unavailable (an outage, a retired
  // model behind the alias, a real quota event) — rather than silently
  // dropping to a 2-way consensus, get a real 3rd opinion by asking Groq's
  // OTHER model (whichever one groqResult didn't already use) the same
  // question completely independently. That's a genuinely different model
  // with different reasoning behavior, not the same call counted twice —
  // calling the same model/prompt again and treating it as a second
  // "opinion" would be fake consensus, so we deliberately don't do that.
  let standInResult = null;
  if (!geminiResult && groqResult) {
    const otherModel = groqResult.modelUsed === GROQ_PRIMARY_MODEL ? GROQ_FALLBACK_MODEL : GROQ_PRIMARY_MODEL;
    console.error(`Gemini unavailable this refresh — using Groq/${otherModel} as a stand-in 3rd opinion`);
    standInResult = await fetchGroqRecommendation(env.GROQ_API_KEY, widePool, insights.chipWindows, recentResults, otherModel, teamNews, scoutPicks);
  }
  const thirdOpinion = geminiResult || standInResult;
  // Real source name, not an internal label — this is what gets shown to the
  // user, so if Gemini is down and Groq is standing in for it, that slot is
  // honestly labeled "Groq" (it genuinely is Groq), not "Gemini".
  const thirdOpinionLabel = geminiResult ? 'Gemini' : standInResult ? 'Groq' : null;

  const ruleBasedXI = [...insights.bestXI.rows.gkp, ...insights.bestXI.rows.def, ...insights.bestXI.rows.mid, ...insights.bestXI.rows.fwd];
  const ruleBasedXINames = ruleBasedXI.map((p) => p.name);
  const ruleBasedCaptainName = insights.bestXI.captain.name;
  const ruleBasedDiffNames = insights.differentials.map((p) => p.name);
  const benchCost = insights.bestXI.bench.reduce((s, p) => s + parseFloat(p.price), 0);

  // Fallback-only source — never part of xiSourceLists, so these players can
  // never count as a real vote, but a genuinely tight budget can still land
  // one of them in the XI via mergeBestXI's forced-fill safety net (marked
  // isFiller: true when that happens). See buildBudgetSafetyNet's own
  // comment for why the wide pool alone isn't always enough for that.
  const budgetSafetyNet = buildBudgetSafetyNet(bootstrap.elements, teamsById, nextFixtureMap, insights.fixturesByTeamId, activeGwId);
  const lookup = buildLookup(widePool, ruleBasedXI, insights.bestXI.bench, insights.differentials, budgetSafetyNet);

  const xiSourceLists = [
    { label: 'FPL Data', names: ruleBasedXINames },
    { label: thirdOpinionLabel, names: thirdOpinion?.startingXI || [] },
    { label: 'Groq', names: groqResult?.startingXI || [] },
  ];
  // Real FPL rules, not optional — a vote-based pick still has to fit the
  // actual £100m squad budget (bench stays fixed, so the XI gets whatever's
  // left) and the 3-per-real-club cap, or it wouldn't be a legal squad.
  const mergedXI = mergeBestXI(xiSourceLists, lookup, { budgetCap: 100 - benchCost, teamCap: 3, scoutPicks, teamNews });
  const { formation, rows } = groupIntoRows(mergedXI);

  // Real, confirmed production bug (found via GW1, 2026-08-21): the old
  // reconciliation here only patched NAME collisions (a bench player who
  // also landed in the final XI) — it never rechecked whether the full
  // 15-man squad's POSITION TOTALS still added up once the AI consensus
  // picked a different-shaped XI than insights.bestXI.bench was originally
  // built to complete. insights.bestXI.bench was computed by the
  // deterministic engine assuming ITS OWN XI shape (e.g. it might favor a
  // 4-4-2 XI needing bench to hold 1 extra DEF/2 extra FWD to reach the
  // real FPL totals) — but mergeBestXI's consensus XI can legitimately end
  // up a completely different shape (say 5-3-2, needing 0 extra DEF but 2
  // extra MID and 1 extra FWD instead). Patching only literal name overlaps
  // left the OLD bench's category mix in place regardless, producing an
  // actually illegal squad: verified live, GW1 ended up with 4 midfielders
  // and 4 forwards total instead of FPL's mandatory 5 and 3.
  //
  // Real FPL rule: every valid 15-man squad has EXACTLY 2 GKP, 5 DEF, 5 MID,
  // 3 FWD, always — the starting XI/bench split can vary (that's what
  // "formation" means), the totals per position never do. So the bench
  // isn't patched here, it's REBUILT from that fixed requirement minus
  // whatever the final XI actually contains, guaranteeing the full 15 is
  // always a legal squad regardless of what shape the AI consensus lands
  // on. Existing bench players are kept first wherever they still fit a
  // genuinely needed position/slot (minimal disruption, not a full reshuffle
  // for its own sake); any remaining gaps are filled with the cheapest real
  // affordable option at that position (same real-FPL-strategy reasoning as
  // before: bench players should be minimal budget drain, leaving more for
  // the XI) — team cap enforced across the FULL 15, not just the XI, since
  // that's the actual real FPL rule.
  const SQUAD_TOTALS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
  const mergedXINames = new Set(mergedXI.map((p) => p.name));
  const xiPosCount = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of mergedXI) xiPosCount[p.position] = (xiPosCount[p.position] || 0) + 1;

  const usedNames = new Set(mergedXINames);
  const teamCount = {};
  for (const p of mergedXI) teamCount[p.teamId] = (teamCount[p.teamId] || 0) + 1;

  const finalBench = [];
  for (const pos of Object.keys(SQUAD_TOTALS)) {
    let needed = SQUAD_TOTALS[pos] - (xiPosCount[pos] || 0);
    const keepFromOldBench = insights.bestXI.bench.filter((p) => p.position === pos && !usedNames.has(p.name));
    for (const p of keepFromOldBench) {
      if (needed <= 0) break;
      if ((teamCount[p.teamId] || 0) >= 3) continue;
      finalBench.push(p);
      usedNames.add(p.name);
      teamCount[p.teamId] = (teamCount[p.teamId] || 0) + 1;
      needed--;
    }
    while (needed > 0) {
      const replacement = [...lookup.values()]
        .filter((p) => p.position === pos && !usedNames.has(p.name) && (teamCount[p.teamId] || 0) < 3)
        .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0];
      if (!replacement) break; // extreme edge case — leave bench short rather than duplicate/invent
      finalBench.push(replacement);
      usedNames.add(replacement.name);
      teamCount[replacement.teamId] = (teamCount[replacement.teamId] || 0) + 1;
      needed--;
    }
  }
  insights.bestXI.bench = finalBench;

  const captainNominees = [
    { label: 'FPL Data', name: ruleBasedCaptainName },
    { label: thirdOpinionLabel, name: thirdOpinion?.captainPick },
    { label: 'Groq', name: groqResult?.captainPick },
  ].filter((n) => n.name);
  const { name: finalCaptainName, sources: captainSources } = mergeCaptain(captainNominees, mergedXI);
  const finalCaptain = mergedXI.find((p) => p.name === finalCaptainName) || mergedXI[0];

  const diffSourceLists = [
    { label: 'FPL Data', names: ruleBasedDiffNames },
    { label: thirdOpinionLabel, names: thirdOpinion?.differentialPicks || [] },
    { label: 'Groq', names: groqResult?.differentialPicks || [] },
  ];
  const mergedDifferentials = mergeDifferentials(diffSourceLists, lookup, 9);

  const totalCost = Number([...mergedXI, ...insights.bestXI.bench].reduce((s, p) => s + parseFloat(p.price), 0).toFixed(1));

  // The actual final captain (decided by mergeCaptain's own nomination vote,
  // separate from XI-membership votes) is NOT guaranteed to be the top
  // XI-vote-ranked player — a source can include someone in their XI without
  // naming them captain. The frontend stars whichever entry is first in this
  // list as "the pick", so the real final captain must always be first here,
  // or the display would show a different player as captain than the one
  // actually armbanded.
  //
  // Vice-captain must be a genuine high-ceiling armband backup, not just
  // "whoever else is safely nailed-on" — ranking by XI-INCLUSION votes (as
  // this used to) rewards nailed-on defenders who get 3/3 votes to simply
  // start, but that nobody would ever actually captain. The real signal for
  // captaincy-worthiness is who else was actually NOMINATED as captain (the
  // same tally finalCaptainName won) — the runner-up there is who a source
  // would armband if their first choice was unavailable, exactly what a
  // vice-captain is for. Only if every source agreed on one name (no
  // alternate nomination exists at all) is there a real fallback: the
  // highest projected-points player elsewhere in the XI.
  const nomineeTally = new Map(); // name -> Set<label>
  for (const { label, name } of captainNominees) {
    if (!nomineeTally.has(name)) nomineeTally.set(name, new Set());
    nomineeTally.get(name).add(label);
  }
  const rankedNominees = [...nomineeTally.entries()]
    .map(([name, labels]) => ({ name, votes: labels.size, player: mergedXI.find((p) => p.name === name) }))
    .filter((c) => c.name !== finalCaptainName && c.player)
    .sort((a, b) => (b.votes - a.votes) || (parseFloat(b.player.epNext) - parseFloat(a.player.epNext)));

  const topNominee = rankedNominees[0];
  // Excludes isFiller players (forced budget/formation fill-ins nobody
  // actually voted for — see mergeBestXI) from the no-alternate-nominee
  // fallback: a player nobody picked shouldn't be able to back into the
  // armband just because they happen to have a decent epNext.
  const viceCaptain = topNominee
    ? topNominee.player
    : [...mergedXI].filter((p) => p.name !== finalCaptainName && !p.isFiller).sort((a, b) => parseFloat(b.epNext) - parseFloat(a.epNext))[0]
      || [...mergedXI].filter((p) => p.name !== finalCaptainName).sort((a, b) => parseFloat(b.epNext) - parseFloat(a.epNext))[0]
      || null;
  const viceCaptainReason = topNominee
    ? `${topNominee.votes}/3 also rated them a captaincy option, xPts ${parseFloat(viceCaptain.epNext).toFixed(1)}`
    : viceCaptain
      ? `Highest projected backup option, xPts ${parseFloat(viceCaptain.epNext).toFixed(1)}`
      : null;
  // Numbers, not names, in the compact UI labels below — tried names first,
  // but "captained this pick" and "had them in their XI" are two DIFFERENT
  // tallies (captain nomination vs XI-inclusion), and rendering both as
  // "Name + Name" lists made them easy to misread as the same kind of vote.
  // A bare count doesn't have that ambiguity; the wording alone already
  // carries which tally it is. The real source names are still kept on
  // `sources` for the chat, where a natural sentence ("agreed by Gemini and
  // Groq") is the right place for that detail, just not a terse label.
  const captaincyPicks = [
    { ...finalCaptain, role: 'Captain', reason: `${captainSources.length}/3 captained this pick, xPts ${parseFloat(finalCaptain.epNext).toFixed(1)}` },
    ...(viceCaptain ? [{ ...viceCaptain, role: 'Vice-Captain', reason: viceCaptainReason }] : []),
  ];

  insights.bestXI = {
    ...insights.bestXI,
    formation,
    rows,
    captain: finalCaptain,
    viceCaptain,
    captaincyPicks,
    totalCost,
  };
  insights.differentials = mergedDifferentials.map((p) => ({
    ...p,
    reason: `${p.votes}/3 agree, ${parseFloat(p.ownership).toFixed(1)}% owned, form ${parseFloat(p.form).toFixed(1)}`,
  }));

  ai = {
    captainPick: finalCaptainName,
    captainSources,
    viceCaptainPick: viceCaptain?.name || null,
    differentialPicks: mergedDifferentials.map((p) => ({ name: p.name, sources: p.sources })),
    chipStrategy: thirdOpinion?.chipStrategy || groqResult?.chipStrategy || null,
    generatedAt: new Date().toISOString(),
  };

  await env.FPL_KV.put('lastAiRunAt', new Date().toISOString());
  } else if (previous?.bestXI && previous?.differentials) {
    // Not due (or already locked) — carry forward the last real consensus
    // rather than recomputing with Gemini/Groq skipped. The cheap sections
    // above (fixtures, injuries, prices, live points) are still fully fresh
    // this tick regardless.
    insights.bestXI = previous.bestXI;
    insights.differentials = previous.differentials;
    ai = previous.ai ?? null;
  }
  // else: no previous snapshot exists yet (very first-ever run) — fall back
  // to the deterministic-only insights.bestXI/differentials computeInsights
  // already produced, with no ai object, same as if the consensus calls had
  // simply failed. Never blocks the refresh.

  history = ensurePendingEntry(history, activeGwId, insights.bestXI, insights.differentials, insights.deadline, ai);

  // Hard, unconditional final guard — a real production bug (2026-08-21)
  // showed the top-level bestXI/differentials/ai (what the site actually
  // displays) can drift away from the frozen history[].lockedBestXI record
  // even though the locked record itself stayed correctly protected inside
  // ensurePendingEntry. Root cause not fully isolated, but this closes the
  // gap regardless of what upstream logic gets it wrong: once a gameweek is
  // locked, what's DISPLAYED must always be forced to match what's LOCKED,
  // full stop, no matter what path the code above took to get here.
  const finalActiveEntry = history.find((e) => e.event === activeGwId);
  if (finalActiveEntry?.lockedBestXI) {
    insights.bestXI = finalActiveEntry.lockedBestXI;
    insights.differentials = finalActiveEntry.lockedDifferentials;
    ai = finalActiveEntry.lockedAi;
  }

  // Inferno's own H2H league fixtures — only a small rolling window gets
  // (re)fetched each day, accumulating into the full season over time. FPL
  // doesn't generate the schedule until the season actually starts, so this
  // stays empty until then.
  const h2hFixturesByGw = await refreshH2HFixtures(previous?.h2hFixturesByGw, bootstrap.events, activeGwId);

  // Inferno's classic league standings (rank, movement, team/manager names) —
  // one cheap fetch, empty until FPL actually generates rankings post-GW1.
  const leagueStandings = await fetchLeagueStandings();

  await env.FPL_KV.put('latest', JSON.stringify({ ...insights, ai, teamNews, history, h2hFixturesByGw, leagueStandings, updatedAt: new Date().toISOString() }));
  return true;
}
