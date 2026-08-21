// Merges three independent proposals — our own deterministic rule-based
// pick ("FPL Data"), Gemini's independent analysis, and Groq's independent
// analysis — into exactly ONE final Best XI, captain, and differentials list
// (never three separate teams). A player endorsed by 2+ of the 3 sources
// makes the cut. When there's a genuine 3-way split with no majority, the
// tie-break is each candidate's own epNext (FPL's real next-gameweek points
// projection) — a transparent, already-computed number, not another opaque
// judgment call.
//
// The final XI must still obey real FPL rules — £100m total squad budget
// and max 3 players per real club — voting alone doesn't guarantee that, so
// both are enforced explicitly below.
//
// Attribution is tracked by SOURCE NAME (e.g. "FPL Data", "Gemini", "Groq"),
// not just an anonymous count — this also means if Gemini is down and its
// stand-in happens to be Groq answering a second time, a player both Groq
// calls agree on still only shows "Groq" once, not double-counted as if it
// were two independent voices.
import { num } from './insights.mjs';

const POSITION_LIMITS = { GKP: { min: 1, max: 1 }, DEF: { min: 3, max: 5 }, MID: { min: 2, max: 5 }, FWD: { min: 1, max: 3 } };

// sourceLists: array of { label, names }
function tally(sourceLists) {
  const bySource = new Map(); // name -> Set<label>
  for (const { label, names } of sourceLists) {
    if (!Array.isArray(names) || !names.length) continue;
    for (const name of new Set(names)) {
      if (!bySource.has(name)) bySource.set(name, new Set());
      bySource.get(name).add(label);
    }
  }
  return bySource;
}

function buildLookup(...playerLists) {
  const map = new Map();
  for (const list of playerLists) {
    for (const p of list || []) {
      if (p?.name && !map.has(p.name)) map.set(p.name, p);
    }
  }
  return map;
}

// Diacritic/short-name tolerant match against a real name from an external
// source (Scout Picks' full names, e.g. "Joao Pedro" vs FPL's own web_name
// "João Pedro"; "Bruno Fernandes" vs "B.Fernandes") — comparing normalized
// surnames catches the real cases without needing an exact-string source of
// truth neither side actually agrees on.
function normalizeName(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Real official FPL Scout Picks categories (see public/scoutPicks.json) —
// weighted by how strongly the category itself implies genuine quality vs
// just being mentioned; "noted absent" is a real negative (injury/rotation
// flag), everything else is a positive nudge, not a hard override.
const SCOUT_CATEGORY_WEIGHT = {
  'must-have': 1.2, 'value pick': 0.8, 'standout attacker': 0.7,
  'defensive signing': 0.5, 'value defensive option': 0.6, 'defense': 0.5,
  'budget option': 0.6, 'promoted defender': 0.4, 'bench enabler': 0.3,
  'budget goalkeeper': 0.3, 'backup goalkeeper': 0.3, 'comparison option': 0.3,
  'noted absent': -0.8,
};

export function mergeBestXI(sourceLists, lookup, { budgetCap = 100, teamCap = 3, scoutPicks = null, teamNews = null } = {}) {
  const bySource = tally(sourceLists);
  const candidates = [...bySource.entries()]
    .map(([name, labels]) => ({ name, sources: [...labels], votes: labels.size, player: lookup.get(name) }))
    .filter((c) => c.player);
  candidates.sort((a, b) => (b.votes - a.votes) || (num(b.player.epNext) - num(a.player.epNext)));

  const allPlayers = [...lookup.values()];
  const minPriceByPos = {};
  for (const pos of Object.keys(POSITION_LIMITS)) {
    const prices = allPlayers.filter((p) => p.position === pos).map((p) => parseFloat(p.price)).filter(Number.isFinite);
    minPriceByPos[pos] = prices.length ? Math.min(...prices) : 4.0;
  }
  // Position minimums only sum to 7 (1+3+2+1), but the XI needs 11 — a
  // reserve that only covers the minimums lets a greedy fill spend freely on
  // expensive early picks and then run out of budget 1-2 players short of a
  // full XI (a real bug caught in testing: reserve covered the minimum
  // formation but not the actual 11-man total). The reserve below covers
  // BOTH: per-position minimums at that position's real cheapest price, PLUS
  // whatever additional slots are still needed to reach 11 at the single
  // cheapest real price anywhere in the pool.
  const globalMinPrice = Math.min(...allPlayers.map((p) => parseFloat(p.price)).filter(Number.isFinite));

  const posCount = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const teamCount = {};
  const chosen = [];
  const chosenNames = new Set();
  let budgetUsed = 0;

  // Real FPL convention: £8m+ is where the genuine "premium" tier starts.
  // Caught live (2026-08-22): canAfford's reserve only guards against
  // literal infeasibility (not enough budget left to reach 11 total), not
  // against a barbell squad shape — a genuine 2/3-or-3/3 vote consensus on
  // 4-5 premiums (real, independently-agreed picks, not a bug) can still
  // consume more than half the budget before any mid-tier value candidate
  // (the realistic £5-8m tier reliable picks actually live in) gets a
  // turn, leaving nothing but rock-bottom fodder for the rest of the XI.
  // Capping premium spend at half the XI's own budget forces the greedy
  // acceptance loop below to fall through to the next-best (non-premium)
  // candidate once premium spend is exhausted — same reasoning as the
  // deterministic engine's own cap (see buildGameweekSquad in
  // lib/insights.mjs), applied here too since this is what actually
  // decides the final vote-merged XI, independent of what any one source
  // alone recommended.
  const PREMIUM_THRESHOLD = 8.0;
  const PREMIUM_BUDGET_CAP = budgetCap * 0.5;
  let premiumSpend = 0;

  const canAfford = (pos, price) => {
    const afterCount = chosen.length + 1;
    let positionMinRemaining = 0;
    let positionMinReserve = 0;
    const stillOpen = [];
    for (const p of Object.keys(POSITION_LIMITS)) {
      const countAfter = posCount[p] + (p === pos ? 1 : 0);
      const remaining = Math.max(0, POSITION_LIMITS[p].min - countAfter);
      positionMinRemaining += remaining;
      positionMinReserve += remaining * minPriceByPos[p];
      if (countAfter < POSITION_LIMITS[p].max) stillOpen.push(p);
    }
    const totalSlotsRemaining = Math.max(0, 11 - afterCount);
    const extraSlots = Math.max(0, totalSlotsRemaining - positionMinRemaining);
    // Extra slots (beyond position minimums) can only ever land in a
    // position that hasn't hit its own MAX yet — reserving at the single
    // cheapest price across ALL positions (a real bug caught in production:
    // GKP/DEF's real minimum, ~£4.0m, is cheaper than MID/FWD's, ~£4.5m)
    // underestimates the true reserve once GKP/DEF are already full, letting
    // earlier picks overspend and leave less than MID/FWD's real minimum
    // for a slot that can now only be MID/FWD. Use the cheapest minimum
    // among positions that are still actually open instead.
    const minPriceForExtra = stillOpen.length ? Math.min(...stillOpen.map((p) => minPriceByPos[p])) : globalMinPrice;
    const reserve = positionMinReserve + extraSlots * minPriceForExtra;
    return budgetUsed + price + reserve <= budgetCap + 0.001;
  };

  const tryAdd = (c) => {
    if (chosen.length >= 11 || chosenNames.has(c.name)) return false;
    const pos = c.player.position;
    const limit = POSITION_LIMITS[pos];
    if (!limit || posCount[pos] >= limit.max) return false;
    if ((teamCount[c.player.team] || 0) >= teamCap) return false;
    const price = parseFloat(c.player.price);
    if (!Number.isFinite(price)) return false;
    // Full 3/3 unanimous agreement is the strongest signal this system
    // produces — never let price alone veto it, only arbitrate between
    // premiums on a genuine 1-2 vote split (or a forced filler, votes=0).
    if (price >= PREMIUM_THRESHOLD && c.votes < 3 && premiumSpend + price > PREMIUM_BUDGET_CAP) return false;
    if (!canAfford(pos, price)) return false;
    chosen.push(c);
    chosenNames.add(c.name);
    posCount[pos]++;
    teamCount[c.player.team] = (teamCount[c.player.team] || 0) + 1;
    budgetUsed += price;
    if (price >= PREMIUM_THRESHOLD) premiumSpend += price;
    return true;
  };

  for (const c of candidates) {
    if (chosen.length >= 11) break;
    tryAdd(c);
  }

  // Tries real fallback candidates for `pos` (or any of `positions`) — a
  // forced fill is still a real squad slot that has to play actual minutes,
  // so it should be the best affordable option, not just whoever has the
  // single highest epNext. Ranked by a composite score, not epNext alone:
  // real, already-available signals (set-piece duty, fixture ease) were
  // being computed for display elsewhere but never actually fed into WHO
  // gets picked as a filler — a cheap defender on corners or an easier
  // fixture is a genuine extra scoring path a bare epNext number doesn't
  // capture on its own. `tryAdd` itself still enforces the real
  // affordability/reserve check, so this only changes which order options
  // are tried in.
  const setPieceBonus = (p) => (p.penaltyOrder === 1 ? 0.5 : 0) + (p.cornerFreekickOrder === 1 ? 0.2 : 0) + (p.directFreekickOrder === 1 ? 0.15 : 0);
  // fixtureDifficulty: 1 (easiest) to 5 (hardest), null if unknown — a small
  // nudge, not a dominant factor; epNext already leans forward-looking.
  const fixtureBonus = (p) => (p.fixtureDifficulty == null ? 0 : (3 - p.fixtureDifficulty) * 0.3);
  // Real official FPL Scout Picks (see public/scoutPicks.json) — already
  // fetched and passed into the AI prompts, but never fed into this
  // deterministic filler ranking at all until now. A curated, semi-expert
  // source is genuinely useful signal for exactly the low-data fringe
  // candidates this function deals with.
  const scoutBonus = (p) => {
    if (!scoutPicks?.picks?.length) return 0;
    const pn = normalizeName(p.name);
    const hit = scoutPicks.picks.find((sp) => {
      const spn = normalizeName(sp.name);
      const spLast = spn.split(' ').pop();
      return pn.includes(spLast) || spn.includes(pn.replace(/^[a-z]\./, '').trim());
    });
    return hit ? (SCOUT_CATEGORY_WEIGHT[hit.category] ?? 0.4) : 0;
  };
  // Real AI-synthesized predicted lineup (see lib/teamNews.mjs) grounded in
  // actual injury/status facts — the closest thing to a genuine "will this
  // player actually start" signal that exists for a fringe/thin-minutes
  // candidate, which raw season stats can't tell you on their own.
  const teamNewsBonus = (p) => (teamNews?.[p.team]?.predictedXI?.includes(p.name) ? 0.8 : 0);
  // Caught live (2026-08-22): nothing previously discouraged piling several
  // discretionary filler picks onto the SAME real club beyond the hard
  // 3-per-club cap — a real risk, since stacking only makes sense as a
  // deliberate bet on a genuinely favorable fixture, not an accident of
  // several of that club's players independently scoring well on other
  // merits. Only applies here (discretionary fillers with weak/no real vote
  // support) — a genuine 2/3 or 3/3 cross-source consensus on same-club
  // players (e.g. two Arsenal picks all three sources independently agree
  // on) is real signal and stays untouched, same reasoning as the premium
  // cap's unanimous-vote exemption above.
  const stackPenalty = (p) => {
    const already = teamCount[p.team] || 0;
    if (already < 1) return 0;
    const easyFixture = p.fixtureDifficulty != null && p.fixtureDifficulty <= 2;
    return easyFixture ? 0 : already * 1.5;
  };
  const fillerScore = (p) => num(p.epNext) * 3 + num(p.form) * 0.4 + num(p.pointsPerGame) * 0.15 + num(p.ictIndex) * 0.01
    + num(p.xGI) * 2 + num(p.defensiveContribution) * 0.05 + (num(p.ownership) / 100) * 1.5
    + setPieceBonus(p) + fixtureBonus(p) + scoutBonus(p) + teamNewsBonus(p) - stackPenalty(p);
  const tryAddBestFiller = (positions) => {
    const ranked = allPlayers
      .filter((p) => positions.includes(p.position) && !chosenNames.has(p.name) && (teamCount[p.team] || 0) < teamCap)
      .sort((a, b) => fillerScore(b) - fillerScore(a));
    for (const p of ranked) {
      if (tryAdd({ name: p.name, votes: 0, sources: [], player: p, isFiller: true })) return true;
    }
    return false;
  };

  // Top up any position short of its minimum — first from remaining
  // vote-ranked candidates, then (only if the pool is too sparse to have any
  // left that fit) from the best real alternative at that position, so
  // the formation and budget are always valid even in an edge case.
  for (const pos of Object.keys(POSITION_LIMITS)) {
    const min = POSITION_LIMITS[pos].min;
    while (posCount[pos] < min && chosen.length < 11) {
      const next = candidates.find((c) => c.player.position === pos && !chosenNames.has(c.name));
      if (next && tryAdd(next)) continue;
      if (tryAddBestFiller([pos])) continue;
      break;
    }
  }

  // Fill any remaining slots regardless of position — first from remaining
  // vote-ranked candidates, but if the (small, ~20-30 name) nominated pool
  // has nobody left who's both affordable and in an open position, fall back
  // to the best real alternative anywhere in the full pool. Without this
  // fallback, a tightening budget reserve can reject every remaining
  // NOMINATED candidate and leave the XI short of 11 even though plenty of
  // real, affordable players exist outside what the 3 sources happened to
  // name — a real bug caught in testing (formation came out 4-3-1, 9 total,
  // instead of a full XI).
  while (chosen.length < 11) {
    const next = candidates.find((c) => !chosenNames.has(c.name) && POSITION_LIMITS[c.player.position] && posCount[c.player.position] < POSITION_LIMITS[c.player.position].max);
    if (next && tryAdd(next)) continue;
    const openPositions = Object.keys(POSITION_LIMITS).filter((p) => posCount[p] < POSITION_LIMITS[p].max);
    if (tryAddBestFiller(openPositions)) continue;
    break; // truly nothing left that fits — an extreme edge case (empty pool)
  }

  // Real, mandatory rule confirmed 2026-08-22: the £100m budget is meant to
  // be fully used, not left idle. The fill loops above stop the moment 11
  // players are chosen, which can leave real budget unspent now that the
  // premium cap can reject what would otherwise have been the next
  // affordable (but over-cap) pick — spend any leftover upgrading the
  // weakest current picks (fillers and lowest-vote real picks first) to the
  // best affordable replacement at the same position. Routes through the
  // same tryAdd gate as everything else, so the premium cap still applies —
  // this naturally spends the leftover into genuine mid-tier value picks
  // rather than straight back into more premiums once the cap's been hit.
  let upgraded = true;
  while (upgraded && budgetCap - budgetUsed > 0.1) {
    upgraded = false;
    const worstFirst = [...chosen].sort((a, b) => (a.votes - b.votes) || (num(a.player.epNext) - num(b.player.epNext)));
    for (const current of worstFirst) {
      const pos = current.player.position;
      const currentPrice = parseFloat(current.player.price);
      const leftoverIfRemoved = budgetCap - (budgetUsed - currentPrice);
      const replacement = allPlayers
        .filter((p) => p.position === pos && !chosenNames.has(p.name)
          && parseFloat(p.price) > currentPrice && parseFloat(p.price) <= leftoverIfRemoved + 0.001
          && (p.team === current.player.team || (teamCount[p.team] || 0) < teamCap))
        .sort((a, b) => num(b.epNext) - num(a.epNext))[0];
      if (!replacement) continue;
      const replacementPrice = parseFloat(replacement.price);
      if (replacementPrice >= PREMIUM_THRESHOLD && premiumSpend - (currentPrice >= PREMIUM_THRESHOLD ? currentPrice : 0) + replacementPrice > PREMIUM_BUDGET_CAP) continue;
      chosen[chosen.indexOf(current)] = { name: replacement.name, votes: 0, sources: [], player: replacement, isFiller: true };
      chosenNames.delete(current.name);
      chosenNames.add(replacement.name);
      if (replacement.team !== current.player.team) {
        teamCount[current.player.team]--;
        teamCount[replacement.team] = (teamCount[replacement.team] || 0) + 1;
      }
      budgetUsed = budgetUsed - currentPrice + replacementPrice;
      if (currentPrice >= PREMIUM_THRESHOLD) premiumSpend -= currentPrice;
      if (replacementPrice >= PREMIUM_THRESHOLD) premiumSpend += replacementPrice;
      upgraded = true;
      break;
    }
  }

  // isFiller (never through the real 2-of-3 tally, only ever a forced
  // budget/formation completion — see tryAddBestFiller above) is kept
  // alongside votes/sources so the UI can be honest about it instead of
  // showing a misleading "0/3 XI" as if all 3 sources had actually
  // considered and rejected this specific player.
  return chosen.map((c) => ({ ...c.player, votes: c.votes, sources: c.sources, isFiller: !!c.isFiller }));
}

// captainNominees: array of { label, name }
export function mergeCaptain(captainNominees, finalXI) {
  const valid = captainNominees.filter((n) => n.name);
  if (!valid.length) return { name: finalXI[0]?.name || null, sources: [] };

  const bySource = new Map(); // name -> label[]
  for (const { label, name } of valid) {
    if (!bySource.has(name)) bySource.set(name, []);
    bySource.get(name).push(label);
  }

  let winner = null;
  let winnerLabels = [];
  for (const [name, labels] of bySource.entries()) {
    if (labels.length > winnerLabels.length) {
      winner = name;
      winnerLabels = labels;
    }
  }

  // No majority (a real split, e.g. all 3 sources named someone different) —
  // tie-break on whichever nominee has the highest real epNext, preferring
  // nominees who are actually in the final merged XI.
  if (winnerLabels.length < 2) {
    const inXI = valid.filter((n) => finalXI.some((p) => p.name === n.name));
    const pool = inXI.length ? inXI : valid;
    let bestName = null;
    let bestEp = -Infinity;
    for (const { name } of pool) {
      const p = finalXI.find((x) => x.name === name);
      const ep = p ? num(p.epNext) : -Infinity;
      if (ep > bestEp) {
        bestEp = ep;
        bestName = name;
      }
    }
    if (bestName) {
      winner = bestName;
      winnerLabels = bySource.get(bestName) || [];
    }
  }

  // Whatever wins the vote must actually be in the final XI to captain it —
  // if not (e.g. that nominee lost the team vote), fall back to the highest
  // real epNext among players who ARE in the final XI.
  if (!finalXI.some((p) => p.name === winner)) {
    const fallback = [...finalXI].sort((a, b) => num(b.epNext) - num(a.epNext))[0];
    winner = fallback?.name || winner;
    winnerLabels = bySource.get(winner) || [];
  }

  return { name: winner, sources: [...new Set(winnerLabels)] };
}

export function mergeDifferentials(sourceLists, lookup, max = 9) {
  const bySource = tally(sourceLists);
  const candidates = [...bySource.entries()]
    .map(([name, labels]) => ({ name, sources: [...labels], votes: labels.size, player: lookup.get(name) }))
    .filter((c) => c.player);
  candidates.sort((a, b) => (b.votes - a.votes) || (num(b.player.epNext) - num(a.player.epNext)));
  return candidates.slice(0, max).map((c) => ({ ...c.player, votes: c.votes, sources: c.sources }));
}

// Reshapes the flat merged 11 into the {formation, rows} structure the
// frontend already renders — sorted within each position by votes then
// epNext, same criteria used to pick them, so the display order matches the
// selection logic.
export function groupIntoRows(mergedXI) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const p of mergedXI) {
    if (byPos[p.position]) byPos[p.position].push(p);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => (b.votes - a.votes) || (num(b.epNext) - num(a.epNext)));
  }
  return {
    formation: `${byPos.DEF.length}-${byPos.MID.length}-${byPos.FWD.length}`,
    rows: { gkp: byPos.GKP, def: byPos.DEF, mid: byPos.MID, fwd: byPos.FWD },
  };
}

export { buildLookup };
