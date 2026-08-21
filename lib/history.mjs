// Tracks how each gameweek's Best XI + Differentials picks actually performed,
// so the dashboard can learn from real results instead of only ever showing a
// forward-looking guess. Stored across daily refreshes inside the same Blob
// the rest of the data lives in.
//
// Deliberately does NOT follow FPL's own "next gameweek" flag, because that
// flips forward as soon as a deadline passes — before that gameweek's matches
// have even been played. Instead the "active" gameweek stays put until its
// matches are actually finished, so the site always shows one gameweek's pick
// through to a real result before moving to the next.

function snapshotPicks(bestXI, differentials) {
  const xiPlayers = [...bestXI.rows.gkp, ...bestXI.rows.def, ...bestXI.rows.mid, ...bestXI.rows.fwd].map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
  }));
  const diffPlayers = differentials.map((p) => ({ id: p.id, name: p.name, team: p.team }));
  return { xiPlayers, diffPlayers, captainId: bestXI.captain.id, viceCaptainId: bestXI.viceCaptain?.id ?? null };
}

// FPL's deadline is always exactly 90 minutes before the first kick-off of
// the gameweek (a fixed, documented FPL rule) — so "lock 10 hours before
// kick-off" is the same threshold as "lock 8.5 hours before deadline",
// without needing to separately fetch/track kick-off times here.
const KICKOFF_TO_DEADLINE_MS = 90 * 60 * 1000;
const LOCK_BEFORE_KICKOFF_MS = 10 * 60 * 60 * 1000;
const LOCK_WINDOW_MS = LOCK_BEFORE_KICKOFF_MS - KICKOFF_TO_DEADLINE_MS;

// Once a gameweek is within the lock window of its deadline (~10h before its
// first kick-off), freeze the pick — no more day-to-day changes, even though
// the underlying stats keep moving. Once the deadline itself passes, it's
// "live" until FPL marks the gameweek finished.
function lockPhase(deadline) {
  if (!deadline) return 'open';
  const msToDeadline = new Date(deadline).getTime() - Date.now();
  if (msToDeadline <= 0) return 'live';
  if (msToDeadline <= LOCK_WINDOW_MS) return 'locked';
  return 'open';
}

async function fetchEventLivePoints(eventId) {
  const res = await fetch(`https://fantasy.premierleague.com/api/event/${eventId}/live/`);
  if (!res.ok) return null;
  const data = await res.json();
  const map = {};
  for (const el of data.elements || []) {
    map[el.id] = { points: el.stats?.total_points ?? 0, minutes: el.stats?.minutes ?? 0 };
  }
  return map;
}

async function resolveEntry(entry, bootstrap) {
  if (entry.status !== 'pending') return entry;
  const event = bootstrap.events.find((e) => e.id === entry.event);
  // Real bug: this used to wait for event.finished before fetching ANY
  // points, so a gameweek in progress for days (different kickoff times
  // across fixtures) showed a flat "TBD" the whole time even though the
  // cron ran daily and FPL's own live endpoint already has real, updating
  // numbers throughout. Now fetches as soon as the gameweek has actually
  // started (is_current), giving a genuine running total each day — status
  // only flips to 'complete' once the whole gameweek is truly finished.
  if (!event || (!event.is_current && !event.finished)) return entry;

  const live = await fetchEventLivePoints(entry.event);
  if (!live) return entry;

  const xiScored = entry.xiPlayers.map((p) => ({ ...p, points: live[p.id]?.points ?? 0 }));
  const diffScored = entry.diffPlayers.map((p) => ({ ...p, points: live[p.id]?.points ?? 0 }));

  // Real FPL rule: the vice-captain's points get doubled instead of the
  // captain's if the captain played 0 minutes that gameweek — going by
  // minutes (not points) so a captain who actually played but nets 0 points
  // from cards/an own goal correctly keeps the armband. Only decided once
  // the gameweek is truly finished — mid-gameweek, a captain's own fixture
  // may simply not have kicked off yet (different teams play on different
  // days), which isn't the same as genuinely not playing that gameweek.
  const viceCaptainEntry = entry.viceCaptainId ? xiScored.find((p) => p.id === entry.viceCaptainId) : null;
  const captainDidNotPlay = event.finished && (live[entry.captainId]?.minutes ?? 0) === 0;
  const armbandId = captainDidNotPlay && viceCaptainEntry ? entry.viceCaptainId : entry.captainId;

  const totalScore = xiScored.reduce((sum, p) => sum + (p.id === armbandId ? p.points * 2 : p.points), 0);
  const armbandSwapped = armbandId !== entry.captainId;

  if (!event.finished) {
    // Live/in-progress — a real, updating running total, but not final yet.
    return { ...entry, xiPlayers: xiScored, diffPlayers: diffScored, totalScore, armbandId, armbandSwapped };
  }

  const bestDiff = diffScored.slice().sort((a, b) => b.points - a.points)[0];
  const worstXI = xiScored.slice().sort((a, b) => a.points - b.points)[0];

  return {
    ...entry,
    status: 'complete',
    totalScore,
    armbandId,
    armbandSwapped,
    xiPlayers: xiScored,
    diffPlayers: diffScored,
    summary: `Scored ${totalScore} pts.${armbandSwapped ? ` Captain didn't play — vice-captain ${viceCaptainEntry.name} got the armband instead.` : ''}${bestDiff ? ` Best differential: ${bestDiff.name} (${bestDiff.points}).` : ''}${worstXI ? ` Weakest XI pick: ${worstXI.name} (${worstXI.points}).` : ''}`,
  };
}

// Resolves any gameweek whose matches have actually finished since the last run.
export async function resolvePendingEntries(previousHistory, bootstrap) {
  const history = await Promise.all((previousHistory || []).map((entry) => resolveEntry(entry, bootstrap)));
  history.sort((a, b) => a.event - b.event);
  return history;
}

// The one gameweek the site should currently be picking/showcasing: the
// earliest still-pending one, or the gameweek right after the last resolved
// one, or GW1 if there's no history yet at all.
export function determineActiveGwId(history, bootstrap) {
  const pending = history.find((e) => e.status === 'pending');
  if (pending) return pending.event;

  const lastResolved = history.filter((e) => e.status === 'complete').sort((a, b) => b.event - a.event)[0];
  if (lastResolved) {
    const next = bootstrap.events.find((e) => e.id === lastResolved.event + 1);
    if (next) return next.id;
  }

  const nextEvent = bootstrap.events.find((e) => e.is_next);
  const currentEvent = bootstrap.events.find((e) => e.is_current);
  return (nextEvent || currentEvent || bootstrap.events[0])?.id ?? null;
}

// Creates (or updates) the tracked entry for the active gameweek.
//
// Phases:
//  - 'open'   more than ~10h before kick-off — picks can still change daily
//             as stats/news update, matching how a real manager would still
//             be free to make transfers.
//  - 'locked' within ~10h of kick-off but kick-off hasn't happened — frozen
//             from here on, even though the underlying stats keep moving.
//             A true hard freeze: no exceptions, not even a fresh injury —
//             once locked, it's the final answer.
//  - 'live'   deadline has passed, gameweek not yet finished — still frozen,
//             shown with a "live" badge instead of a "locked" one.
export function ensurePendingEntry(history, activeGwId, bestXI, differentials, deadline, ai = null) {
  if (!activeGwId) return history;
  const rawPhase = lockPhase(deadline);
  const existingIndex = history.findIndex((e) => e.event === activeGwId);

  if (existingIndex === -1) {
    const phase = rawPhase;
    const snap = snapshotPicks(bestXI, differentials);
    const entry = {
      event: activeGwId,
      generatedAt: new Date().toISOString(),
      status: 'pending',
      phase,
      captainId: snap.captainId,
      viceCaptainId: snap.viceCaptainId,
      xiPlayers: snap.xiPlayers,
      diffPlayers: snap.diffPlayers,
      lockedBestXI: phase !== 'open' ? bestXI : null,
      lockedDifferentials: phase !== 'open' ? differentials : null,
      // The AI's captain/differential picks are advisory but still count as
      // "the pick" for locking purposes — freeze them alongside the
      // deterministic Best XI/Differentials so there's no loophole where a
      // fresher AI suggestion leaks post-lock signal.
      lockedAi: phase !== 'open' ? ai : null,
    };
    const updated = [...history, entry];
    updated.sort((a, b) => a.event - b.event);
    // Keep the full season — a 38-gameweek cap is really just a safety bound,
    // not a rolling window. Storage cost is negligible (a few KB/gameweek).
    return updated.slice(-38);
  }

  const entry = history[existingIndex];
  if (entry.status !== 'pending') return history; // already resolved — leave it alone

  // Ratchet: once genuinely frozen (lockedBestXI already exists), phase can
  // only ever move forward (locked -> live), never back to 'open'. Guards
  // against exactly the bug a future lock-window retune could otherwise
  // cause — shrinking LOCK_WINDOW_MS could make an already-locked gameweek's
  // raw phase recompute as 'open' again for the remaining gap until its real
  // deadline, which without this ratchet would silently start overwriting
  // picks that were supposed to be a true hard freeze.
  const phase = entry.lockedBestXI && rawPhase === 'open' ? 'locked' : rawPhase;

  const updatedEntry = { ...entry, phase };
  if (phase === 'open') {
    // Still free to change day to day.
    const snap = snapshotPicks(bestXI, differentials);
    updatedEntry.captainId = snap.captainId;
    updatedEntry.viceCaptainId = snap.viceCaptainId;
    updatedEntry.xiPlayers = snap.xiPlayers;
    updatedEntry.diffPlayers = snap.diffPlayers;
  } else if (!entry.lockedBestXI) {
    // Just crossed into locked/live for the first time — freeze it now, and
    // make sure the point-tracking snapshot matches what's actually frozen.
    // This is the FINAL answer — a true hard freeze, no exceptions (not even
    // a fresh injury) once locked.
    const snap = snapshotPicks(bestXI, differentials);
    updatedEntry.lockedBestXI = bestXI;
    updatedEntry.lockedDifferentials = differentials;
    updatedEntry.lockedAi = ai;
    updatedEntry.captainId = snap.captainId;
    updatedEntry.viceCaptainId = snap.viceCaptainId;
    updatedEntry.xiPlayers = snap.xiPlayers;
    updatedEntry.diffPlayers = snap.diffPlayers;
  }
  // Already locked and staying locked — nothing more to do, on purpose.

  const updatedHistory = [...history];
  updatedHistory[existingIndex] = updatedEntry;
  return updatedHistory;
}
