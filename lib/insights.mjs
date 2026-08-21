const POSITION = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const PHOTO_BASE = 'https://resources.premierleague.com/premierleague/photos/players/110x140';
const BADGE_BASE = 'https://resources.premierleague.com/premierleague/badges/70';

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
export { num };

// FPL's own *_per_90 fields are precomputed by FPL, not derived from raw
// totals here, so a tiny-minutes fluke (e.g. a single 2-minute cameo where a
// player happened to touch the ball a lot relative to that sample) can
// extrapolate into a wildly unrealistic per-90 rate. Below ~2 full matches of
// minutes, treat the field as unreliable and ignore it rather than let it
// distort rankings.
const RELIABLE_MINUTES = 180;
function reliablePer90(el, field) {
  return num(el.minutes) >= RELIABLE_MINUTES ? num(el[field]) : 0;
}

export function nextFixtureByTeam(teams, fixtures) {
  const upcoming = fixtures.filter((f) => !f.finished).sort((a, b) => a.event - b.event);
  const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
  const map = {};
  for (const fx of upcoming) {
    if (!map[fx.team_h]) {
      map[fx.team_h] = { opponent: teamsById[fx.team_a]?.short_name || '?', venue: 'H' };
    }
    if (!map[fx.team_a]) {
      map[fx.team_a] = { opponent: teamsById[fx.team_h]?.short_name || '?', venue: 'A' };
    }
  }
  return map;
}

// eloByCode: pre-blends real Elo team-strength data (see lib/eloRatings.mjs)
// into this shared fixture map's own `difficulty` field, at the ONE source
// every other consumer reads from — buildGameweekSquad and buildWidePool
// both used to independently re-blend elo from raw FPL
// difficulty each in their own separate local copy, which meant the chat
// widget and client-side Compare tools (both of which just read this same
// map) never saw the sharper number the internal scoring engine did. Now
// there's exactly one blend, computed once, so every consumer sees the same
// real signal.
function fixturesByTeamId(teams, fixtures, lookAhead = 12, eloByCode = null) {
  const upcoming = fixtures.filter((f) => !f.finished).sort((a, b) => a.event - b.event);
  const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
  const map = {};
  for (const team of teams) map[team.id] = [];

  const blend = (teamId, opponentId, fplDifficulty) => {
    const gap = eloGapFor(teamId, opponentId, teamsById, eloByCode);
    return gap == null ? fplDifficulty : Math.round(((fplDifficulty + (3 + gap / 400)) / 2) * 10) / 10;
  };

  for (const fx of upcoming) {
    if (map[fx.team_h] && map[fx.team_h].length < lookAhead) {
      map[fx.team_h].push({
        event: fx.event,
        opponentId: fx.team_a,
        opponent: teamsById[fx.team_a]?.short_name || '?',
        difficulty: blend(fx.team_h, fx.team_a, fx.team_h_difficulty),
        venue: 'H',
      });
    }
    if (map[fx.team_a] && map[fx.team_a].length < lookAhead) {
      map[fx.team_a].push({
        event: fx.event,
        opponentId: fx.team_h,
        opponent: teamsById[fx.team_h]?.short_name || '?',
        difficulty: blend(fx.team_a, fx.team_h, fx.team_a_difficulty),
        venue: 'A',
      });
    }
  }
  return map;
}

export function playerCard(el, teamsById, nextFixtureMap = {}) {
  const team = teamsById[el.team];
  const nf = nextFixtureMap[el.team];
  return {
    id: el.id,
    name: el.web_name,
    fullName: `${el.first_name} ${el.second_name}`,
    teamId: el.team,
    team: team ? team.short_name : '',
    teamBadge: team ? `${BADGE_BASE}/t${team.code}.png` : '',
    position: POSITION[el.element_type],
    positionId: el.element_type,
    photo: `${PHOTO_BASE}/p${el.photo.replace('.jpg', '')}.png`,
    price: (el.now_cost / 10).toFixed(1),
    form: num(el.form),
    pointsPerGame: num(el.points_per_game),
    totalPoints: el.total_points,
    ownership: num(el.selected_by_percent),
    goals: el.goals_scored,
    assists: el.assists,
    cleanSheets: el.clean_sheets,
    saves: el.saves,
    // Real FPL field for "points scored in the most recently finished/current
    // gameweek" — distinct from totalPoints (season cumulative). Lets the
    // player stat modal show "how did they do last gameweek" while browsing
    // the NEXT gameweek's Best XI/Differentials, without needing our own
    // separate per-player storage (FPL already tracks this for every player).
    eventPoints: el.event_points,
    minutes: el.minutes,
    status: el.status,
    news: el.news,
    chanceOfPlaying: el.chance_of_playing_this_round,
    nextFixture: nf ? `${nf.opponent} (${nf.venue})` : null,
    // Opta-sourced underlying stats already exposed for free by the FPL API
    xG: num(el.expected_goals),
    xA: num(el.expected_assists),
    xGI: num(el.expected_goal_involvements),
    ictIndex: num(el.ict_index),
    threat: num(el.threat),
    creativity: num(el.creativity),
    influence: num(el.influence),
    bps: el.bps,
    defensiveContribution: el.defensive_contribution,
    epNext: num(el.ep_next),
    penaltyOrder: el.penalties_order,
    cornerFreekickOrder: el.corners_and_indirect_freekicks_order,
    directFreekickOrder: el.direct_freekicks_order,
  };
}

// ep_next (FPL's own forward-looking "expected points next gameweek") is
// weighted heaviest here deliberately: it's the one free, officially-maintained
// signal that actually reflects THIS season's squad role — form/points_per_game
// only reflect LAST season, which is actively misleading for anyone who
// changed clubs or roles over the summer (e.g. a keeper who started every
// week for his old club but joined a new one purely as backup). Without this,
// the model would rank last season's minutes over who's actually going to play.
// expected_goal_involvements_per_90 and defensive_contribution_per_90 are
// FPL's own real underlying-probability stats (xG+xA per 90, and the newer
// CBIT defensive-points signal for DEF/MID) — already free in bootstrap-static
// but previously unused here, which meant Best XI selection leaned only on
// FPL's own ep_next/form/ict_index and missed a genuinely predictive signal
// FPL itself publishes. Weighted small relative to ep_next (still the
// proven anchor) so this sharpens ranking among similar players rather than
// overriding FPL's own projection.
// Ownership as a mild "template safety" signal: real managers who've
// converged on a pick have implicitly priced in things this formula can't
// see directly (a nailed-on starter, a favourable role, a fixture look-ahead
// beyond what's in ep_next yet). Weighted small and applied ONLY here, never
// in ceilingScore() — differentials/captaincy upside are explicitly about
// picks the template ISN'T on, so rewarding ownership there would defeat
// the entire point of those two functions. At 1.5 max (100% owned, which
// never actually happens — realistic ceiling is more like Haaland's ~75%,
// so a real max nudge of ~1.1), this only tips genuinely close calls, never
// overrides a real gap in the underlying stats above.
function ownershipBonus(el) {
  return (num(el.selected_by_percent) / 100) * 1.5;
}

// Real, already-available signal that was computed for display (setPieceRole
// in playerCard) but never actually fed into the scoring formulas that
// choose WHO gets picked — a cheap defender/midfielder on penalties or
// corners has a genuine extra scoring path a raw stats line doesn't capture
// on its own, exactly the kind of thing a good budget-enabler pick should
// weigh, not just "cheapest that's still affordable". 1st-choice penalty
// taker gets the largest bonus (real, ~76%-conversion, high-value chance);
// 1st-choice corners/free-kicks are real but smaller/indirect chance
// creation. Backup order (2nd/3rd choice) gets nothing — they may never
// actually take one.
function setPieceBonus(el) {
  return (el.penalties_order === 1 ? 0.5 : 0)
    + (el.corners_and_indirect_freekicks_order === 1 ? 0.2 : 0)
    + (el.direct_freekicks_order === 1 ? 0.15 : 0);
}

function score(el) {
  return num(el.ep_next) * 3 + num(el.form) * 0.4 + num(el.points_per_game) * 0.15 + num(el.ict_index) * 0.01
    + reliablePer90(el, 'expected_goal_involvements_per_90') * 2 + reliablePer90(el, 'defensive_contribution_per_90') * 0.05
    + ownershipBonus(el) + setPieceBonus(el);
}

// Explosive-haul / "high ceiling" potential — used specifically for
// differentials (the whole point of a differential is upside, not floor)
// and for choosing WHICH real XI player to captain (2x multiplier makes
// ceiling matter disproportionately there too). Deliberately per-90, not raw
// season totals — threat/bonus/bps accumulate with minutes played, so a
// cumulative total would just reward whoever played the most games rather
// than genuine explosive tendency, the same trap the old "value" score fell
// into pre-season. Per-90 stays a meaningful signal even on last season's
// numbers, since it describes a player's TYPE (explosive vs. steady) rather
// than how much game time they happened to rack up.
// xgiPer90 (real expected-goal-involvement rate) and dcPer90 (real defensive-
// contribution rate) come straight from FPL's own per-90 fields, so unlike
// threat/bonus above they need no manual normalizing. Weighted heavier here
// than in score() since ceiling is specifically about explosive/upside
// potential, not steady output — this is what widens the gap between a
// genuine differential (high real xGI or a defender racking up real CBIT
// actions) and a player who merely looks busy on Opta's composite indexes.
function ceilingScore(el) {
  const reliable = num(el.minutes) >= RELIABLE_MINUTES;
  const mins = Math.max(num(el.minutes), 1);
  const threatPer90 = reliable ? (num(el.threat) / mins) * 90 : 0;
  const bonusPer90 = reliable ? (num(el.bonus) / mins) * 90 : 0;
  const xgiPer90 = reliablePer90(el, 'expected_goal_involvements_per_90');
  const dcPer90 = reliablePer90(el, 'defensive_contribution_per_90');
  // Weighted heavier here than in score() — a real penalty/set-piece duty is
  // itself an explosive-upside signal (a single penalty is often the
  // difference in a differential's whole week), arguably more relevant to
  // "ceiling" than to steady baseline projection.
  return threatPer90 * 0.1 + bonusPer90 * 2 + xgiPer90 * 5 + dcPer90 * 0.25 + setPieceBonus(el) * 1.5;
}

function fixtureMultiplier(difficulty, eloGap = null) {
  if (difficulty == null) return 1;
  // Blends FPL's own subjective 1-5 fixture difficulty with a real Elo-based
  // read when both teams' Elo is known (see lib/eloRatings.mjs) — 400 Elo
  // points is the standard reference gap for a heavy (~10x) favorite,
  // treated here as roughly one full difficulty grade on FPL's scale.
  // Averaged 50/50 with FPL's own rating rather than replacing it outright,
  // since FPL's rating also factors things Elo doesn't (fixture congestion,
  // injuries). `eloGap` is null (not 0) whenever either team's Elo is
  // unknown — e.g. a newly-promoted side — so this correctly falls back to
  // FPL's rating alone instead of guessing.
  const blended = eloGap == null ? difficulty : (difficulty + (3 + eloGap / 400)) / 2;
  return 1 + (3 - blended) * 0.12;
}

// Elo gap from `teamId`'s perspective: positive means the opponent is
// stronger (harder fixture), negative means weaker (easier). Returns null —
// not 0 — when either side's Elo isn't known, so callers never silently
// treat "no data" as "evenly matched".
function eloGapFor(teamId, opponentId, teamsById, eloByCode) {
  if (!eloByCode) return null;
  const myElo = eloByCode[teamsById[teamId]?.code];
  const oppElo = eloByCode[teamsById[opponentId]?.code];
  if (myElo == null || oppElo == null) return null;
  return oppElo - myElo;
}

// Builds a full 15-man squad under a £100m budget (max 3 players per real
// team), scored for one specific upcoming gameweek so fixture difficulty for
// THAT week is baked in, then splits it into a starting XI + bench. We only
// ever run this for the next gameweek (see computeInsights) rather than
// letting picks be made for GWs further out — form and injuries next week are
// hard enough to guess, further out it's just noise.
// Real FPL convention: £8m+ is where the genuine "premium" tier starts
// (mostly MID/FWD, occasionally a top defender) — below that is the
// reliable/value "balanced" tier real managers actually build a squad
// around, not just cheap fodder.
const PREMIUM_THRESHOLD = 8.0;
// Caught live (2026-08-22, GW1 preview): pure score-maximization with no
// counterweight naturally produces a barbell — as many max-price premiums
// as the budget allows, then every remaining slot crammed to the £4m
// floor to make room. Confirmed on real data: 5 players >=£8m ate £54.5m
// (more than half the budget) while genuinely good mid-tier value picks
// in the £7-7.5m range (Szoboszlai, João Pedro — both real GW1 picks
// before this) never got a look in, purely because their epNext lost to
// a 5th premium's. A hard cap forces the greedy pass to fall through to
// the next-best (non-premium) candidate once premium spend is exhausted,
// which is exactly what leaves room for a genuine balanced tier instead
// of an all-premium XI plus an all-minimum bench.
const PREMIUM_BUDGET_CAP = 55.0;

function buildGameweekSquad(elements, teamsById, nextFixtureMap, fixturesByTeamIdMap, gwId) {
  const pool = elements.filter((e) => e.status === 'a');
  const quotas = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const minPriceByPos = {};
  for (const pos of Object.keys(quotas)) {
    const prices = pool.filter((e) => e.element_type === Number(pos)).map((e) => e.now_cost / 10);
    minPriceByPos[pos] = prices.length ? Math.min(...prices) : 4;
  }

  // fixturesByTeamIdMap's own `difficulty` is already Elo-blended at the
  // source (see fixturesByTeamId above) — no need to re-blend here.
  const gwFixture = (teamId) => (fixturesByTeamIdMap[teamId] || []).find((f) => f.event === gwId);
  const gwDifficulty = (teamId) => gwFixture(teamId)?.difficulty ?? null;
  const gwMultiplier = (teamId) => fixtureMultiplier(gwDifficulty(teamId));

  const scored = pool
    .map((e) => ({ el: e, sc: score(e) * gwMultiplier(e.team) }))
    .sort((a, b) => b.sc - a.sc);

  const squad = [];
  const posCount = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const teamCount = {};
  let budgetLeft = 100.0;

  // Real FPL strategy: the backup GK almost never plays (only if the
  // starter is unavailable), so spending real budget on its score
  // potential is nearly pure waste — that money is worth far more in the
  // actual starting XI. The starting GK is still picked purely by score
  // like everyone else; the backup is deliberately the cheapest legal
  // option instead of running through the same score-driven greedy pool
  // (caught live 2026-08-22: the old approach picked a £5.5m Donnarumma
  // as pure bench cover over a ~£4.0m option, for zero functional gain).
  const gkScored = scored.filter((s) => s.el.element_type === 1);
  const starterGk = gkScored[0];
  const backupGkEl = pool
    .filter((e) => e.element_type === 1 && e.id !== starterGk?.el.id)
    .sort((a, b) => a.now_cost - b.now_cost)[0];
  const backupGk = backupGkEl ? scored.find((s) => s.el.id === backupGkEl.id) : null;
  if (starterGk) {
    squad.push(starterGk);
    posCount[1]++;
    teamCount[starterGk.el.team] = (teamCount[starterGk.el.team] || 0) + 1;
    budgetLeft -= starterGk.el.now_cost / 10;
  }
  if (backupGk && (teamCount[backupGk.el.team] || 0) < 3) {
    squad.push(backupGk);
    posCount[1]++;
    teamCount[backupGk.el.team] = (teamCount[backupGk.el.team] || 0) + 1;
    budgetLeft -= backupGk.el.now_cost / 10;
  }

  let premiumSpend = 0;
  for (const { el, sc } of scored) {
    if (squad.length >= 15) break;
    const pos = el.element_type;
    if (pos === 1) continue; // both GK slots already filled above
    if (posCount[pos] >= quotas[pos]) continue;
    if ((teamCount[el.team] || 0) >= 3) continue;
    const price = el.now_cost / 10;
    if (price >= PREMIUM_THRESHOLD && premiumSpend + price > PREMIUM_BUDGET_CAP) continue;
    const reserve = Object.keys(quotas).reduce((sum, p) => {
      if (Number(p) === 1) return sum; // GK slots already filled, no reserve needed
      const remaining = quotas[p] - posCount[p] - (Number(p) === pos ? 1 : 0);
      return sum + Math.max(0, remaining) * minPriceByPos[p];
    }, 0);
    if (price + reserve > budgetLeft + 0.001) continue;
    squad.push({ el, sc });
    posCount[pos]++;
    teamCount[el.team] = (teamCount[el.team] || 0) + 1;
    budgetLeft -= price;
    if (price >= PREMIUM_THRESHOLD) premiumSpend += price;
  }

  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const s of squad) byPos[s.el.element_type].push(s);
  for (const p of Object.keys(byPos)) byPos[p].sort((a, b) => b.sc - a.sc);

  const gk = byPos[1].slice(0, 1);
  const def = byPos[2].slice(0, 3);
  const mid = byPos[3].slice(0, 2);
  const fwd = byPos[4].slice(0, 1);
  const startingIds = new Set([...gk, ...def, ...mid, ...fwd].map((s) => s.el.id));
  const remaining = [...byPos[2].slice(3), ...byPos[3].slice(2), ...byPos[4].slice(1)]
    .filter((s) => !startingIds.has(s.el.id))
    .sort((a, b) => b.sc - a.sc);
  const limits = { 2: 5, 3: 5, 4: 3 };
  const counts = { 2: def.length, 3: mid.length, 4: fwd.length };
  const startXI = [...gk, ...def, ...mid, ...fwd];
  for (const s of remaining) {
    if (startXI.length >= 11) break;
    if (counts[s.el.element_type] < limits[s.el.element_type]) {
      startXI.push(s);
      counts[s.el.element_type]++;
    }
  }

  const startingSet = new Set(startXI.map((s) => s.el.id));
  // Real FPL convention: the reserve goalkeeper always sits first on the
  // bench regardless of score, then outfield subs ranked by score.
  const bench = squad.filter((s) => !startingSet.has(s.el.id)).sort((a, b) => {
    const aGk = a.el.element_type === 1 ? 1 : 0;
    const bGk = b.el.element_type === 1 ? 1 : 0;
    return bGk - aGk || b.sc - a.sc;
  });
  // Captaincy gets its own ranking, not just the plain squad score — the 2x
  // multiplier means ceiling (explosive haul potential) should carry real
  // weight here, same reasoning as differentials.
  const captaincyScoreOf = (s) => s.sc * 0.7 + ceilingScore(s.el) * 0.3;
  const rankedXI = startXI.slice().sort((a, b) => captaincyScoreOf(b) - captaincyScoreOf(a));
  const captain = rankedXI[0];
  // Real gap caught testing the new fillerScore fix live: this squad's own
  // bench is what buildLookup (lib/consensus.mjs) checks FIRST when a
  // player name needs resolving, before buildWidePool/buildBudgetSafetyNet
  // — so even after those two started attaching fixtureDifficulty, any
  // bench player who's also a forced XI filler was still resolving to
  // THIS card, which never carried the field, silently voiding the bonus
  // for exactly the fringe/filler players it matters most for.
  const toCards = (list) => list.map((s) => ({ ...playerCard(s.el, teamsById, nextFixtureMap), fixtureDifficulty: gwDifficulty(s.el.team) }));

  // Group the FINAL starting XI (after the fill-up loop above added players
  // beyond the 3-2-1 baseline) by position for row rendering — using the
  // original gk/def/mid/fwd arrays here would drop every player added by that
  // loop and silently show a shorter XI than the formation tag claims.
  const finalByPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const s of startXI) finalByPos[s.el.element_type].push(s);
  for (const p of Object.keys(finalByPos)) finalByPos[p].sort((a, b) => b.sc - a.sc);

  const captaincyPicks = rankedXI.slice(0, 3).map((s) => {
    const diff = gwDifficulty(s.el.team);
    const easeLabel = diff == null ? 'fixture TBC' : diff <= 2 ? 'kind fixture' : diff >= 4 ? 'tough fixture' : 'average fixture';
    return {
      ...playerCard(s.el, teamsById, nextFixtureMap),
      reason: `xPts ${num(s.el.ep_next).toFixed(1)}, ${easeLabel}`,
    };
  });

  return {
    formation: `${counts[2]}-${counts[3]}-${counts[4]}`,
    rows: {
      gkp: toCards(finalByPos[1]),
      def: toCards(finalByPos[2]),
      mid: toCards(finalByPos[3]),
      fwd: toCards(finalByPos[4]),
    },
    bench: toCards(bench),
    captain: playerCard(captain.el, teamsById, nextFixtureMap),
    captaincyPicks,
    totalCost: Number(squad.reduce((s, x) => s + x.el.now_cost / 10, 0).toFixed(1)),
  };
}

// Recent signings: anyone who joined their current club within the last ~120
// days, so this naturally covers the current transfer window and fades out
// on its own as the season goes on (no manual toggle needed).
function pickNewSignings(elements, teamsById, windowDays = 120) {
  const now = Date.now();
  return elements
    .filter((e) => e.team_join_date)
    .map((e) => ({ el: e, joinedAt: new Date(e.team_join_date).getTime() }))
    .filter(({ joinedAt }) => Number.isFinite(joinedAt) && (now - joinedAt) / 86400000 <= windowDays)
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .slice(0, 12)
    .map(({ el, joinedAt }) => ({
      ...playerCard(el, teamsById, {}),
      joinDate: new Date(joinedAt).toISOString().slice(0, 10),
    }));
}

const STAT_LABELS = {
  bps: 'BPS',
  defensive_contribution: 'DEFCON',
  saves: 'Saves',
  yellow_cards: 'YC',
  red_cards: 'RC',
  goals_scored: 'Goals',
  assists: 'Assists',
  penalties_missed: 'Pen Miss',
  penalties_saved: 'Pen Save',
  own_goals: 'OG',
};

// FPL's own fixture stats report BPS and (since the 2025-26 DC rule)
// defensive_contribution for nearly every player who touched the ball —
// unlike Goals/Assists/cards/Saves (naturally short — at most one keeper
// per side), a single fixture can have 15-20+ nonzero entries for these
// two, which is unreadable in full on a gameweek summary. Top 6 by value
// covers who actually mattered.
const TOP_N_STATS = { bps: 6, defensive_contribution: 6 };

function fixtureStatsTable(f, elementsById) {
  const table = {};
  for (const stat of f.stats || []) {
    const label = STAT_LABELS[stat.identifier];
    if (!label) continue;
    let raw = [...(stat.h || []), ...(stat.a || [])].filter((e) => e.value);
    raw.sort((a, b) => b.value - a.value);
    const cap = TOP_N_STATS[stat.identifier];
    if (cap) raw = raw.slice(0, cap);
    const entries = raw.map((e) => `${elementsById[e.element]?.web_name || '?'} (${e.value})`);
    if (entries.length) table[label] = entries;
  }
  return table;
}

function pickOneGameweekFixtures(teamsById, elementsById, fixtures, gwId) {
  return fixtures
    .filter((f) => f.event === gwId)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time))
    .map((f) => ({
      home: teamsById[f.team_h]?.short_name || '?',
      homeBadge: `${BADGE_BASE}/t${teamsById[f.team_h]?.code}.png`,
      away: teamsById[f.team_a]?.short_name || '?',
      awayBadge: `${BADGE_BASE}/t${teamsById[f.team_a]?.code}.png`,
      kickoff: f.kickoff_time,
      started: !!f.started,
      finished: f.finished,
      homeScore: f.team_h_score,
      awayScore: f.team_a_score,
      // FPL's own fixtures API populates `stats` progressively once a match
      // kicks off, not just after it finishes — so a match that's `started`
      // but not yet `finished` already has real goals/assists/cards recorded
      // for however much of the match has been played as of our last daily
      // refresh (this site isn't a live minute-by-minute ticker, but it does
      // reflect real events as soon as the next refresh picks them up).
      stats: (f.started || f.finished) ? fixtureStatsTable(f, elementsById) : {},
    }));
}

// Full-season fixture browser data: every gameweek 1-38, not just the next
// one. Stats only populate once a match has actually finished — pre-season,
// every fixture in here is still just a kickoff time, which is correct.
function pickAllGameweekFixtures(teamsById, elementsById, fixtures, gameweeks) {
  return gameweeks.map((gw) => ({
    event: gw.id,
    name: gw.name,
    fixtures: pickOneGameweekFixtures(teamsById, elementsById, fixtures, gw.id),
  }));
}

// Penalty/free-kick order 1 = first-choice taker for that team, straight off
// the free FPL API. Corners are dropped — that field is empty for most teams
// and not worth the space.
function pickSetPieceTakers(elements, teamsById) {
  const byTeam = {};
  for (const e of elements) {
    if (e.status === 'r' || e.removed) continue;
    if (e.penalties_order !== 1 && e.direct_freekicks_order !== 1) continue;
    const team = teamsById[e.team];
    if (!team) continue;
    if (!byTeam[team.id]) {
      byTeam[team.id] = { team: team.short_name, badge: `${BADGE_BASE}/t${team.code}.png`, penalty: null, freekicks: null };
    }
    if (e.penalties_order === 1) byTeam[team.id].penalty = e.web_name;
    if (e.direct_freekicks_order === 1) byTeam[team.id].freekicks = e.web_name;
  }
  return Object.values(byTeam).sort((a, b) => a.team.localeCompare(b.team));
}

// Blank/double gameweek detection straight from the full fixtures list — a
// team with 0 fixtures in a gameweek is a blank, 2+ is a double. This drives
// simple, honest chip-timing pointers instead of guessing at unannounced
// postponements/rearrangements.
function pickChipWindows(teams, fixtures) {
  const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));
  const countByEventTeam = {};
  const eventsSeen = new Set();
  for (const f of fixtures) {
    if (!f.event) continue;
    eventsSeen.add(f.event);
    countByEventTeam[f.event] = countByEventTeam[f.event] || {};
    countByEventTeam[f.event][f.team_h] = (countByEventTeam[f.event][f.team_h] || 0) + 1;
    countByEventTeam[f.event][f.team_a] = (countByEventTeam[f.event][f.team_a] || 0) + 1;
  }

  const doubles = [];
  const blanks = [];
  for (const event of [...eventsSeen].sort((a, b) => a - b)) {
    const counts = countByEventTeam[event];
    const doubleTeams = teams.filter((t) => (counts[t.id] || 0) >= 2).map((t) => t.short_name);
    const blankTeams = teams.filter((t) => (counts[t.id] || 0) === 0).map((t) => t.short_name);
    if (doubleTeams.length) doubles.push({ event, teams: doubleTeams });
    if (blankTeams.length) blanks.push({ event, teams: blankTeams });
  }

  return { doubles, blanks };
}

// A differential's whole purpose is upside — "the punts that can win you
// rank" — so ceiling counts for more here than it does for the balanced,
// budget-constrained Best XI: 60% underlying form/projection, 40% explosive
// haul potential, rather than pure score().
function differentialScore(el) {
  return score(el) * 0.6 + ceilingScore(el) * 0.4;
}

export function pickDifferentials(elements, teamsById, nextFixtureMap, limit = 8) {
  return elements
    .filter((e) => e.status === 'a' && num(e.selected_by_percent) < 10 && num(e.minutes) > 0)
    .sort((a, b) => differentialScore(b) - differentialScore(a))
    .slice(0, limit)
    .map((e) => ({
      ...playerCard(e, teamsById, nextFixtureMap),
      reason: `${num(e.selected_by_percent).toFixed(1)}% owned, form ${num(e.form).toFixed(1)}`,
    }));
}

// A wide, NEUTRALLY-sorted (by minutes, not by our own score()) real player
// pool for independent AI analysis to reason over from scratch — the whole
// point is that Gemini/Groq see real raw data and form their own view,
// not a shortlist our own formula already narrowed down (that would just be
// re-ranking our own bias, not a genuine second/third opinion). Capped per
// position to keep prompt size sane.
//
// Real production bug found via GW1 (2026-08-21), in two layers:
//
// Layer 1: the old filter required RELIABLE_MINUTES on its own, which
// silently hid a player from Gemini and Groq entirely if their past-minutes
// sample was thin — even when FPL's own forward-looking ep_next rated them
// the single best option at their position league-wide (verified: Raya,
// epNext 4.0, the highest of any keeper in the game, missing from the wide
// pool while sitting right there in the data).
//
// Layer 2, found immediately after "fixing" layer 1 with a fixed ep_next>=3
// cutoff: that cutoff only rescued the elite tier (Raya, Saka) and still
// silently hid perfectly reasonable, real budget-enabler options (verified:
// Calvert-Lewin epNext 2.0, Ndiaye 2.1, Tzolis 2.3 — real, active, sensibly
// priced players, all still excluded by a hard >=3 line). Any single fixed
// threshold has this same problem, just at a different point.
//
// Fix: no hard ep_next cutoff at all for the thin-minutes group — rank ALL
// of them by ep_next and let the remaining cap (see below) naturally decide
// how many fit, strongest signal first. A thin-minutes player with ep_next
// 0.3 can still make it in if the position's established+strong candidates
// don't fill the cap — which is honest: a real, low-but-nonzero FPL
// projection is still better information for the AI to weigh than being
// invisible, and the AI is free to rank it low itself.
const WIDE_POOL_CAPS = { 1: 4, 2: 12, 3: 14, 4: 8 };
export function buildWidePool(elements, teamsById, nextFixtureMap, fixturesByTeamIdMap, gwId) {
  // fixturesByTeamIdMap's own `difficulty` is already Elo-blended at the
  // source (see fixturesByTeamId) — Gemini/Groq's prompt (which already
  // explains "1=easiest, 5=hardest") gets the sharper number automatically,
  // no separate re-blend needed here.
  const gwDifficulty = (teamId) => (fixturesByTeamIdMap[teamId] || []).find((f) => f.event === gwId)?.difficulty ?? null;
  const eligible = elements.filter((e) => e.status === 'a');
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const e of eligible) byPos[e.element_type].push(e);

  const pool = [];
  for (const pos of Object.keys(WIDE_POOL_CAPS)) {
    // Established (real minutes) and thin-minutes players are sorted
    // SEPARATELY, then combined — sorting everyone by minutes alone (the
    // old approach) would just push a Raya-type player back to the bottom
    // of the list and off the cap regardless of being eligible at all,
    // since low minutes always loses that sort.
    const established = byPos[pos]
      .filter((e) => num(e.minutes) >= RELIABLE_MINUTES)
      .sort((a, b) => num(b.minutes) - num(a.minutes));
    const thinMinutes = byPos[pos]
      .filter((e) => num(e.minutes) < RELIABLE_MINUTES)
      .sort((a, b) => num(b.ep_next) - num(a.ep_next));
    // A small guaranteed reserve for the thin-minutes group even when
    // established players fill the rest of the cap (so a real standout
    // doesn't always get crowded out later in the season) — but
    // takeEstablished.length, not a fixed reserve subtracted up front,
    // decides how much cap is actually left for thinMinutes. Real bug
    // caught testing this against live GW1 data: early in a new season
    // EVERYONE'S minutes reset to near-zero, so `established` can be
    // completely empty — a fixed small reserve would leave most of the cap
    // sitting unused instead of falling back to the only real signal that
    // exists yet (ep_next). Computing remaining cap from the ACTUAL
    // established count means it naturally expands to fill the whole cap
    // from thinMinutes when established comes up short, and stays a small
    // reserve once established has plenty of players again.
    const minReserve = Math.min(2, thinMinutes.length, Math.floor(WIDE_POOL_CAPS[pos] / 4) || 1);
    const takeEstablished = established.slice(0, WIDE_POOL_CAPS[pos] - minReserve);
    const remainingCap = WIDE_POOL_CAPS[pos] - takeEstablished.length;
    const combined = [...takeEstablished, ...thinMinutes.slice(0, remainingCap)];
    for (const e of combined) {
      const card = { ...playerCard(e, teamsById, nextFixtureMap), fixtureDifficulty: gwDifficulty(e.team) };
      pool.push(card);
    }
  }
  return pool;
}

// A real budget-tightening edge case caught in production: the wide pool
// above only includes players with real established minutes (RELIABLE_MINUTES),
// which is right for the actual 3-way vote, but means the CHEAPEST real
// players (often fringe/rotation options with low minutes — that's exactly
// why they're cheap) are never in it. When the consensus merge (see
// mergeBestXI in lib/consensus.mjs) needs to force-fill a slot because the
// budget got tight, its only fallback candidates were whatever's already in
// the wide pool/bench/differentials — which can genuinely have nothing
// affordable left at a given position, even though real, valid, available
// players in that exact price range obviously exist elsewhere in the full
// database. This gives the merge a small, always-available safety net of
// the actual cheapest real options per position, independent of minutes
// played, purely so an affordability search never comes up empty.
export function buildBudgetSafetyNet(elements, teamsById, nextFixtureMap, fixturesByTeamIdMap, gwId, perPosition = 5) {
  // Real bug caught in production: this pool feeds tryAddBestFiller's
  // composite fillerScore (see lib/consensus.mjs), which includes a fixture
  // difficulty bonus specifically so a cheap enabler with an easy fixture
  // outranks an equally cheap one without (e.g. a budget defender facing a
  // promoted side beats one facing a top-6 side) — but this function never
  // computed fixtureDifficulty at all, so that term was silently 0 for every
  // safety-net player. buildWidePool already does this; mirrored here.
  const gwDifficulty = (teamId) => (fixturesByTeamIdMap?.[teamId] || []).find((f) => f.event === gwId)?.difficulty ?? null;
  const eligible = elements.filter((e) => e.status === 'a');
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const e of eligible) byPos[e.element_type].push(e);
  const pool = [];
  for (const pos of Object.keys(byPos)) {
    const cheapest = byPos[pos].sort((a, b) => a.now_cost - b.now_cost).slice(0, perPosition);
    for (const e of cheapest) pool.push({ ...playerCard(e, teamsById, nextFixtureMap), fixtureDifficulty: gwDifficulty(e.team) });
  }
  return pool;
}

// Real FPL Defensive Contribution rule: 2 bonus points in any gameweek where
// a player's combined tackles + CBI + recoveries reaches this threshold —
// 10 for defenders, 12 for midfielders/forwards. Goalkeepers don't earn this
// bonus at all (their defensive actions aren't counted the same way).
function dcThreshold(positionId) {
  return positionId === 2 ? 10 : 12;
}

// Full per-player stats table (Player Statistics / Stats Per Gameweek
// pages) — real per-gameweek data (tackles, CBI, recoveries, and the
// DC-hit/DC-hit% derived from them) comes from statsAgg (see
// lib/playerStats.mjs), which FPL's own bootstrap-static never exposes at
// that granularity. Falls back to zeroed stats when statsAgg is
// unavailable (or before this season has any real gameweeks played) rather
// than omitting players — ownership/price still let the table be useful
// pre-season, same reasoning as Price Watch's own "activates once..." note.
export function buildPlayerStatsTable(elements, teamsById, nextFixtureMap, statsAgg) {
  const per90 = (total, minutes) => (minutes > 0 ? (total / minutes) * 90 : 0);
  return elements
    .filter((e) => e.status === 'a')
    .map((e) => {
      const agg = statsAgg?.[e.id] || {
        apps: 0, minutes: 0, points: 0, goals: 0, assists: 0, cleanSheets: 0,
        goalsConceded: 0, tackles: 0, cbi: 0, recoveries: 0, xG: 0, xA: 0, xGI: 0, xGC: 0, dcPerGw: [], gwPoints: {},
      };
      const threshold = dcThreshold(e.element_type);
      const dcHits = e.element_type === 1 ? 0 : agg.dcPerGw.filter((v) => v >= threshold).length;
      const dcTotal = agg.dcPerGw.reduce((s, v) => s + v, 0);
      const gi = agg.goals + agg.assists;
      return {
        ...playerCard(e, teamsById, nextFixtureMap),
        apps: agg.apps,
        minsPerApp: agg.apps > 0 ? Math.round(agg.minutes / agg.apps) : 0,
        pts: agg.points,
        pts90: Number(per90(agg.points, agg.minutes).toFixed(2)),
        goals: agg.goals,
        goals90: Number(per90(agg.goals, agg.minutes).toFixed(2)),
        xG: Number(agg.xG.toFixed(2)),
        xG90: Number(per90(agg.xG, agg.minutes).toFixed(2)),
        assists: agg.assists,
        assists90: Number(per90(agg.assists, agg.minutes).toFixed(2)),
        xA: Number(agg.xA.toFixed(2)),
        xA90: Number(per90(agg.xA, agg.minutes).toFixed(2)),
        gi,
        gi90: Number(per90(gi, agg.minutes).toFixed(2)),
        xGI: Number(agg.xGI.toFixed(2)),
        xGI90: Number(per90(agg.xGI, agg.minutes).toFixed(2)),
        dcHits,
        dcHitPct: agg.apps > 0 ? Math.round((dcHits / agg.apps) * 100) : 0,
        dc90: Number(per90(dcTotal, agg.minutes).toFixed(2)),
        cleanSheets: agg.cleanSheets,
        goalsConceded: agg.goalsConceded,
        xGC: Number(agg.xGC.toFixed(2)),
        tackles: agg.tackles,
        cbi: agg.cbi,
        recoveries: agg.recoveries,
        ictIndexTotal: num(e.ict_index),
        gwPoints: agg.gwPoints || {},
      };
    });
}

// The wide pool above carries full playerCard fields (photo/teamBadge URLs,
// ids, etc.) because it also doubles as the lookup source for the FINAL
// rendered player cards after consensus merging. But sending all of that to
// an LLM is pure waste — live-tested and found it can trip Groq's request
// size limit outright (413) well before any token limit even comes into
// play. This strips it down to just what's needed to reason about team
// selection, for the PROMPT text only — the full pool objects (used for the
// actual lookup) are untouched.
export function compactPoolForPrompt(pool) {
  return pool.map((p) => ({
    name: p.name,
    team: p.team,
    position: p.position,
    price: p.price,
    news: p.news || null,
    form: p.form,
    ownership: p.ownership,
    epNext: p.epNext,
    nextFixture: p.nextFixture,
    fixtureDifficulty: p.fixtureDifficulty,
    xGI: p.xGI,
    defensiveContribution: p.defensiveContribution,
  }));
}

// Grounds the Gemini/Groq starting-XI/differential/captain picks in the same
// real team-news analysis the Team News tab shows (see lib/teamNews.mjs) —
// an explicit "who's actually likely to start" signal that FPL's own bare
// status flags don't capture (a fringe player can be status "a" and still be
// a bench option). Shared by both AI prompt builders so the two independent
// voters get identically-worded grounding text, not two different summaries
// of the same data. Framed as a signal to weigh, not a fact to defer to —
// this IS itself AI-generated, so treating it as ground truth would let one
// AI call's guess quietly become another's "fact".
// Deliberately just names, no summary/fixture text — the POOL above already
// carries each player's own `news` field, so the summary sentences would be
// mostly redundant, and a real production failure (Groq silently dropping
// its vote — see lib/refresh.mjs) confirmed the fuller version was enough
// added prompt size to trip Groq's per-minute token ceiling on this
// already-sizable consensus prompt. Names-only keeps the genuinely new
// signal (who's predicted to actually start) at a fraction of the size.
export function teamNewsPromptBlock(teamNews) {
  if (!teamNews) return '';
  const lines = Object.entries(teamNews)
    .filter(([, v]) => v.predictedXI?.length)
    .map(([team, v]) => `${team}: ${v.predictedXI.join(', ')}`);
  if (!lines.length) return '';
  return `\n\nToday's predicted starting XIs per club (independently AI-generated from real official injury/status data — a helpful signal on who's actually likely to start, NOT a confirmed lineup or an infallible fact; weigh it alongside the real stats above, don't defer to it blindly):\n${lines.join('\n')}`;
}

// Real names/prices/categories manually extracted from the official FPL
// Scout Picks article each gameweek (see public/scoutPicks.json — a plain,
// hand-updated static file, zero API/AI cost to refresh; the actual PL news
// pages are JS-rendered, so a server-side fetch from the cron worker can't
// reliably discover or read them itself). Only used when `gameweek` in the
// file matches the gameweek this prompt is actually for — a stale file left
// over from a prior week is silently ignored rather than presented as
// current, since callers only pass a non-null `scoutPicks` after checking
// that match themselves (see lib/refresh.mjs).
export function scoutPicksPromptBlock(scoutPicks) {
  if (!scoutPicks?.picks?.length) return '';
  const lines = scoutPicks.picks.map((p) => `${p.name} (£${p.price}m, ${p.category}${p.reason ? ` — ${p.reason}` : ''})`);
  return `\n\nThis gameweek's official FPL Scout Picks (the Premier League's own editorial FPL team, real names extracted from their published article — a strong extra signal worth real weight in your reasoning, but still just one more input alongside the real stats above, not an instruction to copy it outright):\n${lines.join('\n')}`;
}

// FPL's own official injury/availability flags only — automated, no manual
// upkeep required. Sorted by news_added (latest first), so a fresh update
// today always surfaces above an older one, regardless of severity.
function pickInjuryWatch(elements, teamsById, nextFixtureMap) {
  return elements
    .filter((e) => e.news && e.news.trim().length > 0)
    .sort((a, b) => new Date(b.news_added || 0) - new Date(a.news_added || 0))
    .slice(0, 12)
    .map((e) => playerCard(e, teamsById, nextFixtureMap));
}

function pickPriceWatch(elements, teamsById, nextFixtureMap) {
  const active = elements.some((e) => e.transfers_in_event > 0 || e.transfers_out_event > 0);
  if (!active) return { active: false, risers: [], fallers: [] };

  const withDelta = elements
    .filter((e) => e.status === 'a')
    .map((e) => ({ ...e, netTransfers: e.transfers_in_event - e.transfers_out_event }));

  const risers = withDelta
    .filter((e) => e.netTransfers > 0)
    .sort((a, b) => b.netTransfers - a.netTransfers)
    .slice(0, 5)
    .map((e) => ({ ...playerCard(e, teamsById, nextFixtureMap), netTransfers: e.netTransfers }));

  const fallers = withDelta
    .filter((e) => e.netTransfers < 0)
    .sort((a, b) => a.netTransfers - b.netTransfers)
    .slice(0, 5)
    .map((e) => ({ ...playerCard(e, teamsById, nextFixtureMap), netTransfers: e.netTransfers }));

  return { active: true, risers, fallers };
}

// Full teams x next-N-gameweeks difficulty grid (an "FDR table" in FPL
// community terms) — every team, sorted easiest overall run first, rather
// than just a top-6-easiest / top-6-hardest split. Blends FPL's own 1-5
// difficulty with real Elo-based team strength (see lib/eloRatings.mjs)
// exactly like the scoring engine's fixtureMultiplier does, so the same
// sharper signal shows up here too — falls back to FPL's own rating alone
// wherever a team's Elo isn't known.
function pickFixtureSwings(teams, fixtures, eloByCode = null, lookAhead = 6) {
  const upcoming = fixtures.filter((f) => !f.finished).sort((a, b) => a.event - b.event);
  const perTeam = {};
  for (const team of teams) perTeam[team.id] = [];
  const teamsByIdLocal = Object.fromEntries(teams.map((t) => [t.id, t]));

  const blendedDifficulty = (teamId, opponentId, fplDifficulty) => {
    const gap = eloGapFor(teamId, opponentId, teamsByIdLocal, eloByCode);
    return gap == null ? fplDifficulty : Math.round(((fplDifficulty + (3 + gap / 400)) / 2) * 10) / 10;
  };

  for (const fx of upcoming) {
    if (perTeam[fx.team_h] && perTeam[fx.team_h].length < lookAhead) {
      perTeam[fx.team_h].push({
        opponent: fx.team_a,
        difficulty: blendedDifficulty(fx.team_h, fx.team_a, fx.team_h_difficulty),
        home: true,
        event: fx.event,
      });
    }
    if (perTeam[fx.team_a] && perTeam[fx.team_a].length < lookAhead) {
      perTeam[fx.team_a].push({
        opponent: fx.team_h,
        difficulty: blendedDifficulty(fx.team_a, fx.team_h, fx.team_a_difficulty),
        home: false,
        event: fx.event,
      });
    }
  }

  const rows = teams.map((team) => {
    const runs = perTeam[team.id] || [];
    const avgDifficulty = runs.length ? runs.reduce((s, r) => s + r.difficulty, 0) / runs.length : null;
    return {
      team: team.short_name,
      teamName: team.name,
      badge: `${BADGE_BASE}/t${team.code}.png`,
      avgDifficulty: avgDifficulty ? Number(avgDifficulty.toFixed(2)) : null,
      fixtures: runs.map((r) => ({
        opponent: teamsByIdLocal[r.opponent]?.short_name || '?',
        difficulty: r.difficulty,
        venue: r.home ? 'H' : 'A',
        event: r.event,
      })),
    };
  }).filter((t) => t.avgDifficulty !== null);

  rows.sort((a, b) => a.avgDifficulty - b.avgDifficulty);
  return { teams: rows };
}

function teamSummary(t) {
  return {
    id: t.id,
    name: t.name,
    shortName: t.short_name,
    badge: `${BADGE_BASE}/t${t.code}.png`,
    strengthAttackHome: t.strength_attack_home,
    strengthAttackAway: t.strength_attack_away,
    strengthDefenceHome: t.strength_defence_home,
    strengthDefenceAway: t.strength_defence_away,
  };
}

// `overrideGwId`, when given, is the gameweek the history tracker has decided
// is "active" (see history.mjs) and wins over FPL's own next/current flags —
// those flip forward the moment a deadline passes, before that gameweek's
// matches are even played, which is too early for our purposes.
export function computeInsights(bootstrap, fixtures, overrideGwId = null, eloByCode = null, statsAgg = null) {
  const teamsById = Object.fromEntries(bootstrap.teams.map((t) => [t.id, t]));
  const elementsById = Object.fromEntries(bootstrap.elements.map((e) => [e.id, e]));
  const currentEvent = bootstrap.events.find((e) => e.is_current);
  const nextEvent = bootstrap.events.find((e) => e.is_next);
  const isPreseason = !currentEvent;
  const nextFixtureMap = nextFixtureByTeam(bootstrap.teams, fixtures);
  const fixturesMap = fixturesByTeamId(bootstrap.teams, fixtures, 12, eloByCode);
  const targetGwId = overrideGwId ?? (nextEvent || currentEvent)?.id;
  const targetEvent = bootstrap.events.find((e) => e.id === targetGwId);
  const gameweeksList = bootstrap.events.map((e) => ({
    id: e.id,
    name: e.name,
    deadline: e.deadline_time,
    isCurrent: !!e.is_current,
    isNext: !!e.is_next,
  }));

  return {
    isPreseason,
    gameweek: targetEvent?.name || currentEvent?.name || nextEvent?.name || null,
    gameweekId: targetGwId ?? null,
    deadline: targetEvent?.deadline_time || nextEvent?.deadline_time || null,
    bestXI: buildGameweekSquad(bootstrap.elements, teamsById, nextFixtureMap, fixturesMap, targetGwId),
    setPieceTakers: pickSetPieceTakers(bootstrap.elements, teamsById),
    chipWindows: pickChipWindows(bootstrap.teams, fixtures),
    differentials: pickDifferentials(bootstrap.elements, teamsById, nextFixtureMap, 8),
    injuryWatch: pickInjuryWatch(bootstrap.elements, teamsById, nextFixtureMap),
    priceWatch: pickPriceWatch(bootstrap.elements, teamsById, nextFixtureMap),
    newSignings: pickNewSignings(bootstrap.elements, teamsById),
    fixtureSwings: pickFixtureSwings(bootstrap.teams, fixtures, eloByCode),
    allGameweekFixtures: pickAllGameweekFixtures(teamsById, elementsById, fixtures, gameweeksList),
    playerStats: buildPlayerStatsTable(bootstrap.elements, teamsById, nextFixtureMap, statsAgg),

    // Full datasets powering the client-side interactive tools (compare players,
    // compare teams, rate my squad) so those can run entirely in the browser
    // with no extra backend calls.
    allPlayers: bootstrap.elements
      .filter((e) => !e.removed)
      .map((e) => playerCard(e, teamsById, nextFixtureMap)),
    allTeams: bootstrap.teams.map(teamSummary),
    fixturesByTeamId: fixturesMap,
    gameweeks: gameweeksList,
  };
}
