const params = new URLSearchParams(location.search);
const DATA_URL = params.get('demo') ? 'sample-data.json' : '/get-data';

const STATE = { data: null };

// Real cost cut (2026-08-23, part of the season-long CPU/payload gatekeeper
// work): the backend used to send a full ~65-char badge URL and ~75-char
// photo URL for every one of ~600 players in allPlayers alone, even though
// every single one is built from the exact same two template strings plus
// a short code. Sending just the code and reconstructing the URL here cuts
// real, permanent weight off the payload the cron worker has to
// JSON.stringify and write on every 5-minute tick, all season.
const BADGE_BASE = 'https://resources.premierleague.com/premierleague/badges/70';
const PHOTO_BASE = 'https://resources.premierleague.com/premierleague/photos/players/110x140';
function teamBadgeUrl(teamCode) { return teamCode ? `${BADGE_BASE}/t${teamCode}.png` : ''; }
function playerPhotoUrl(photoCode) { return photoCode ? `${PHOTO_BASE}/p${photoCode}.png` : ''; }
// GW1's own locked/frozen player cards (see history[gw].lockedBestXI) were
// captured before this compaction existed and carry the OLD shape (a full
// `teamBadge`/`photo` URL string) permanently — GW1 can never be
// recomputed, so this has to keep accepting both shapes forever, not just
// during a one-time transition window. New-shape (`teamCode`/`photoCode`)
// wins when present; old-shape full URLs are used as-is otherwise.
function playerBadgeSrc(p) { return p.teamCode ? teamBadgeUrl(p.teamCode) : (p.teamBadge || ''); }
function playerPhotoSrc(p) { return p.photoCode ? playerPhotoUrl(p.photoCode) : (p.photo || ''); }

const FALLBACK_PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="82" viewBox="0 0 64 82">' +
      '<rect width="64" height="82" rx="8" fill="#2a1230"/>' +
      '<circle cx="32" cy="30" r="14" fill="#4a2a55"/>' +
      '<path d="M8 78 C8 58 56 58 56 78 Z" fill="#4a2a55"/>' +
      '</svg>'
  );

// Primary photos come from the official FPL CDN. Some newer signings don't have
// one yet (403s) — fall back to a free Wikipedia thumbnail by full name, and
// only drop to a plain silhouette if neither source has an image.
window.handlePhotoError = function handlePhotoError(img) {
  if (img.dataset.fallbackStage === 'wiki') {
    img.onerror = null;
    img.src = FALLBACK_PHOTO;
    return;
  }
  img.dataset.fallbackStage = 'wiki';
  const name = img.dataset.fullname || '';
  img.onerror = () => {
    img.onerror = null;
    img.src = FALLBACK_PHOTO;
  };
  fetch(
    `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(name)}&prop=pageimages&piprop=thumbnail&pithumbsize=200&format=json&origin=*`
  )
    .then((r) => r.json())
    .then((data) => {
      const pages = data && data.query && data.query.pages;
      const page = pages && Object.values(pages)[0];
      if (page && page.thumbnail && page.thumbnail.source) {
        img.src = page.thumbnail.source;
      } else {
        img.onerror = null;
        img.src = FALLBACK_PHOTO;
      }
    })
    .catch(() => {
      img.onerror = null;
      img.src = FALLBACK_PHOTO;
    });
};

function photoImg(p, cls = 'photo') {
  return `<img class="${cls}" src="${playerPhotoSrc(p)}" alt="${p.name}" data-fullname="${p.fullName}" onerror="handlePhotoError(this)" />`;
}

function pitchPlayerHTML(p, isCaptain, pointsText = 'TBD', note = null, isViceCaptain = false) {
  const isTBD = pointsText === 'TBD';
  // isFiller means this player never actually appeared in any of the 3
  // sources' picks — they were added only to complete the XI/budget when
  // the real candidates ran out (see mergeBestXI in lib/consensus.mjs).
  // Showing that as "0/3 XI" would look identical to a real vote count and
  // wrongly imply all 3 sources considered and rejected them.
  const votesTag = p.isFiller
    ? '<span class="votes-tag votes-tag-fill" title="Not picked by any of the 3 sources — added only to complete the XI/budget">Fill</span>'
    : p.votes != null
      ? `<span class="votes-tag" title="${p.votes}/3 independent sources started this player">${p.votes}/3 XI</span>`
      : '';
  return `
    <div class="pitch-player" data-player-id="${p.id}">
      ${isCaptain ? '<span class="captain-tag">C</span>' : isViceCaptain ? '<span class="captain-tag vc-tag">VC</span>' : ''}
      ${votesTag}
      <div class="pitch-card">
        ${photoImg(p)}
        <div class="pitch-name">${p.name}</div>
        <div class="pitch-meta">£${p.price}m${p.nextFixture ? ` · ${p.nextFixture}` : ''}</div>
        ${note ? `<div class="pitch-meta" style="opacity:0.75;">${note}</div>` : ''}
        <div class="pitch-points ${isTBD ? 'tbd' : 'scored'}">${isTBD ? 'TBD' : `${pointsText} pts`}</div>
      </div>
    </div>
  `;
}

function playerCardHTML(p, { showReason = false, showStat = null } = {}) {
  return `
    <div class="player-card" data-player-id="${p.id}">
      ${playerBadgeSrc(p) ? `<img class="badge" src="${playerBadgeSrc(p)}" alt="${p.team}" />` : ''}
      ${photoImg(p)}
      <div class="name">${p.name}</div>
      <div class="meta">${p.position} · ${p.team} · £${p.price}m</div>
      ${showStat ? `<div class="stat-row">${showStat(p)}</div>` : ''}
      ${showReason && p.reason ? `<div class="reason">${p.reason}</div>` : ''}
    </div>
  `;
}

function listRowHTML(p, statHTML) {
  return `
    <div class="list-row">
      ${playerBadgeSrc(p) ? `<img class="mini-badge" src="${playerBadgeSrc(p)}" alt="${p.team}" />` : ''}
      <span class="list-name">${p.name}</span>
      <span class="list-stat">${statHTML}</span>
    </div>
  `;
}

// Real bug caught in production: fixture difficulty is now Elo-blended
// (see lib/insights.mjs's fixturesByTeamId) so it's often a fraction like
// 3.3, not a clean 1-5 integer — but only diff-1 through diff-5 exist as
// CSS classes, so `diff-${d}` with a raw fraction silently matched no rule
// at all and rendered as unstyled bold text instead of a colored pill.
// Rounds for both the class AND the displayed number — a compact chip like
// this has no room for decimal precision anyway (the full FDR grid table
// still shows the exact blended value for anyone who wants it).
function diffPill(d) {
  const rounded = Math.min(5, Math.max(1, Math.round(d)));
  return `<span class="diff-pill diff-${rounded}">${rounded}</span>`;
}

// Real mobile touch scrolling turned out to be unreliable across devices
// (see the touch-action history above .fdr-scroll in styles.css — every
// custom value tried fixed one gesture direction while breaking another,
// and that's not something guessable/testable from here without a real
// device). Explicit tap buttons sidestep the whole problem: a button click
// is unambiguous on every device, so this guarantees every column is
// actually reachable on mobile regardless of how touch-scroll behaves.
// Wired once via delegation in setupScrollHints(), not per-instance, so
// this can be dropped into any wide table's markup for free.
function scrollHintHTML(targetId) {
  return `
    <div class="scroll-hint-bar">
      <button type="button" class="scroll-btn" data-scroll-target="${targetId}" data-dir="-1" aria-label="Scroll left">◀</button>
      <span class="scroll-hint-text">Scroll for more columns</span>
      <button type="button" class="scroll-btn" data-scroll-target="${targetId}" data-dir="1" aria-label="Scroll right">▶</button>
    </div>
  `;
}

function setupScrollHints() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.scroll-btn');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.scrollTarget);
    if (!target) return;
    target.scrollBy({ left: 220 * Number(btn.dataset.dir), behavior: 'smooth' });
  });
}

// Only meaningful pre-GW1: real form/totalPoints are near-zero or carried
function fmtUpdated(iso) {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// The cron runs every 5 minutes on the clock (see cron-worker/wrangler.toml
// — */5 * * * * UTC) — compute the next actual 5-minute mark rather than
// just saying "soon", so it's obvious exactly when to expect fresh data.
function nextRefreshTime() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  const mins = next.getUTCMinutes();
  next.setUTCMinutes(Math.ceil((mins + 1) / 5) * 5);
  return next.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// Real rule for the 2026/27 season (confirmed live, 2026-08-26): FPL price
// changes apply at midnight UK time — changed this season from the old
// 1:30am GMT / 2:30am BST cutoff. Computed via a locale round-trip rather
// than a hardcoded UTC offset, since UK clocks shift between GMT and BST
// across the season and a fixed offset would drift wrong twice a year.
function nextPriceUpdateTime() {
  const now = new Date();
  const londonNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const nextMidnightLondon = new Date(londonNow);
  nextMidnightLondon.setHours(24, 0, 0, 0);
  const offsetMs = now.getTime() - londonNow.getTime();
  const next = new Date(nextMidnightLondon.getTime() + offsetMs);
  const msLeft = next.getTime() - now.getTime();
  const hoursLeft = Math.floor(msLeft / 3600000);
  const minsLeft = Math.round((msLeft % 3600000) / 60000);
  const timeText = next.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${timeText} (in ${hoursLeft}h ${minsLeft}m)`;
}

// Real false-alarm bug caught live (2026-08-24): this was 20 minutes,
// calibrated back when Cloudflare's 5-minute cron was the only scheduler
// and a 20-minute gap genuinely meant 4 missed ticks in a row. Since
// GitHub Actions became a second, redundant scheduler (see
// .github/workflows/refresh.yml — added specifically to survive
// Cloudflare's Free-plan CPU limit), its own schedule trigger has real,
// confirmed gaps well past 20 minutes even when working completely
// normally (measured directly from run history: most gaps 15-30 min, but
// genuine outliers up to ~99 min are a known GitHub Actions
// characteristic, not a failure). 60 minutes comfortably covers the normal
// range from either scheduler without crying wolf on routine variance,
// while still surfacing a genuinely broken refresh within the hour
// instead of silently serving stale data indefinitely.
function isStale(iso) {
  if (!iso) return true;
  return (Date.now() - new Date(iso).getTime()) > 60 * 60 * 1000;
}

// ---------- Static info sections (best XI, differentials, fixtures, sidebar) ----------

// Real per-team news facts (see lib/teamNews.mjs) — FPL's own official
// injury/status data synthesized once a day into an original per-team
// summary + predicted lineup by the same AI models already wired into this
// site. Deliberately NOT a scrape of any news site's actual articles
// (fantasyfootballscout.co.uk, premierleague.com/en/news/*, etc.) — those
// are copyrighted editorial writeups, not a public data feed. This is
// original text grounded in real structured facts instead.
// Real gap flagged by the user (2026-08-26): early in a gameweek, before a
// club's own pre-match press conference has actually happened (managers
// typically hold these 1-2 days out, not further ahead), "no fresh injury
// concerns" only means nothing NEW has been officially reported YET — not
// that the squad is confirmed fully fit. Computed from the real kickoff
// timestamp at render time (not baked into the cached AI text), so it
// stays accurate no matter how long this result sits around, and clears
// itself automatically once within the real pre-match window — no manual
// action needed, the same scheduled refresh that already regenerates this
// content will pick up real news the moment a club actually reports it.
const PRESSER_WINDOW_HOURS = 48;
function pressConferenceCaveat(kickoffIso) {
  if (!kickoffIso) return '';
  const hoursOut = (new Date(kickoffIso).getTime() - Date.now()) / 3600000;
  if (hoursOut <= PRESSER_WINDOW_HOURS) return '';
  const daysOut = Math.round(hoursOut / 24);
  return `<p class="rule-note" style="margin-bottom:8px;">⏳ This club's own pre-match press conference likely hasn't happened yet (kickoff is still ~${daysOut} day${daysOut === 1 ? '' : 's'} away) — the status below is the latest officially reported so far, not final confirmation. Updates automatically as real news comes in.</p>`;
}

function teamNewsCardHTML(team, news) {
  const summary = news?.newsSummary || 'No team news generated yet — check back after the next daily refresh.';
  const xi = news?.predictedXI || [];
  return `
    <section class="block side-block">
      <h2><img class="mini-badge" src="${team.badge}" alt="${team.shortName}" />${team.name}</h2>
      ${news?.nextFixture ? `<p class="block-desc" style="margin-bottom:8px;">Next: ${news.nextFixture}</p>` : ''}
      ${pressConferenceCaveat(news?.kickoff)}
      <p class="block-desc" style="margin-bottom:10px;">${summary}</p>
      ${xi.length ? `
        <div class="list-subhead">Predicted XI</div>
        <div>${xi.map((n) => `<span class="xi-chip">${n}</span>`).join('')}</div>
      ` : ''}
    </section>
  `;
}

// Labeled with the actual gameweek number (not just a bare "last updated"
// timestamp) so it's never ambiguous which week's news this is once the
// season's underway and gameweeks start rolling over week to week.
function teamNewsPageHTML(data) {
  const teams = data.allTeams || [];
  const newsByTeam = data.teamNews || {};
  const gwLabel = data.gameweek ? ` — ${data.gameweek}` : '';
  if (!teams.length) {
    return `
      <section class="block tile-full">
        <h2>📰 Team News${gwLabel}</h2>
        <p class="block-desc">No team data available right now — check back after the next refresh.</p>
      </section>
    `;
  }
  return `
    <section class="block tile-full">
      <h2>📰 Team News${gwLabel}</h2>
      <p class="block-desc">AI-written team news &amp; predicted lineups for ${data.gameweek || 'the upcoming gameweek'}, grounded in FPL's own official injury/availability data. Refreshes right up until this gameweek's picks lock, then reflects the next gameweek once it starts. Predicted XIs are an estimate, not a confirmed lineup — clubs don't announce those until close to kickoff.</p>
    </section>
    <div class="dashboard-grid">
      ${teams.map((t) => teamNewsCardHTML(t, newsByTeam[t.shortName])).join('')}
    </div>
  `;
}

function lockBadgeHTML(entry) {
  if (!entry) return '';
  if (entry.phase === 'live') return '<span class="formation-tag lock-badge lock-live">🔒 Locked — deadline passed, gameweek in progress</span>';
  if (entry.phase === 'locked') return '<span class="formation-tag lock-badge lock-locked">🔒 Picks locked (final — no more changes)</span>';
  return '';
}

// Shared across Best XI, Differentials, and AI Recommendation — all three
// are driven by the same lockPhase/ensurePendingEntry mechanism in
// lib/history.mjs, so the one caveat applies identically everywhere: free to
// change with every refresh until ~10 hours before that gameweek's first
// kick-off, at which point lockedBestXI/lockedDifferentials/lockedAi freeze
// it for real — a true hard freeze, no exceptions, not even a late injury.
function updatesDisclaimerHTML() {
  return `<p class="rule-note" style="margin-top:10px;">Not a final pick — this can shift with every refresh until it locks for good roughly 10 hours before the gameweek's first kick-off.</p>`;
}

function bestXIHTML(data) {
  const history = data.history || [];
  const activeEntry = history.find((e) => e.event === data.gameweekId);
  const frozen = activeEntry && (activeEntry.phase === 'locked' || activeEntry.phase === 'live') && activeEntry.lockedBestXI;
  const xi = frozen || data.bestXI;
  const rows = xi.rows;
  const cap = xi.captain;
  const totalPointsText = activeEntry && activeEntry.status === 'complete'
    ? `${activeEntry.totalScore} pts`
    : activeEntry && activeEntry.phase === 'live' && typeof activeEntry.totalScore === 'number'
      ? `${activeEntry.totalScore} pts (live, updates daily)`
      : 'TBD';
  // Real per-player live points while the gameweek is in progress but not
  // yet fully finished (see lib/history.mjs resolveEntry) — id -> points,
  // so pitch cards show real running scores instead of a flat "TBD" for
  // days while a gameweek's fixtures are still being played across
  // different kickoff times.
  const livePointsById = activeEntry && activeEntry.phase === 'live' && Array.isArray(activeEntry.xiPlayers)
    ? Object.fromEntries(activeEntry.xiPlayers.map((p) => [p.id, p.points]))
    : null;
  // Real bug caught live (2026-08-23): the total score above already
  // doubles whoever holds the armband (see armbandId in lib/history.mjs's
  // resolveEntry — vice-captain gets it instead if the captain didn't
  // play), but this per-card figure was showing the same player's RAW,
  // un-doubled points — a captain who'd actually contributed 4 to that
  // total showed "2 pts" on their own card, silently inconsistent with
  // the number right above it.
  const armbandId = activeEntry?.armbandId ?? cap.id;
  const pointsFor = (p) => {
    if (!livePointsById || livePointsById[p.id] == null) return 'TBD';
    const raw = livePointsById[p.id];
    return String(p.id === armbandId ? raw * 2 : raw);
  };
  const completedEntries = history.filter((e) => e.status === 'complete');

  const gwOptions = (data.gameweeks || []).map((g) => {
    const isActive = g.id === data.gameweekId;
    const completed = completedEntries.find((e) => e.event === g.id);
    const selectable = isActive || !!completed;
    const label = isActive ? g.name : completed ? `${g.name} — ${completed.totalScore} pts` : `${g.name} (locked)`;
    return `<option value="${g.id}" ${isActive ? 'selected' : ''} ${selectable ? '' : 'disabled'}>${label}</option>`;
  }).join('');

  const pastPanels = completedEntries.map((e) => {
    // armbandId is whoever actually got the 2x multiplier that gameweek —
    // normally the captain, but the vice-captain if the captain didn't play
    // (see lib/history.mjs resolveEntry, the real FPL auto-substitution rule).
    const armbandId = e.armbandId ?? e.captainId;
    return `
    <div class="past-gw-panel" id="bestxi-past-${e.event}">
      <p class="block-desc">Final GW${e.event} squad — ${e.totalScore} pts.${e.armbandSwapped ? ' Captain did not play, so the armband passed to the vice-captain.' : ''}</p>
      <div class="grid">
        ${e.xiPlayers.map((p) => `
          <div class="player-card" data-player-id="${p.id}">
            <div class="name">${p.id === armbandId ? '⭐ ' : p.id === e.viceCaptainId ? '🅱️ ' : ''}${p.name}</div>
            <div class="meta">${p.team}</div>
            <div class="stat-row">${p.points} pts${p.id === armbandId ? ` × 2 (${p.id === e.captainId ? 'captain' : 'vice-captain'})` : ''}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  }).join('');

  return `
    <section class="block hero-block tile-full">
      <div class="hero-top-row">
        <h2>🧠 Best XI</h2>
        <select class="tool-input gw-lock-select" id="bestxi-gw-select">${gwOptions}</select>
      </div>
      <p class="block-desc">Starting XI (£${xi.totalCost.toFixed(1)}m squad cost) chosen by 3-way consensus — our own deterministic scoring, Google Gemini, and Groq each independently analyze the real stats and vote. A player needs 2 of 3 votes to make the cut; ties break on real expected points.</p>
      <div id="bestxi-live-view">
        <span class="formation-tag">Formation ${xi.formation}</span>
        <span class="formation-tag" style="background:var(--purple-light);">Total points: ${totalPointsText}</span>
        ${lockBadgeHTML(activeEntry)}
        <div class="pitch">
          <div class="pitch-row">${rows.gkp.map((p) => pitchPlayerHTML(p, p.id === cap.id, pointsFor(p), p.id === armbandId && livePointsById ? '×2' : null, p.id === xi.viceCaptain?.id)).join('')}</div>
          <div class="pitch-row">${rows.def.map((p) => pitchPlayerHTML(p, p.id === cap.id, pointsFor(p), p.id === armbandId && livePointsById ? '×2' : null, p.id === xi.viceCaptain?.id)).join('')}</div>
          <div class="pitch-row">${rows.mid.map((p) => pitchPlayerHTML(p, p.id === cap.id, pointsFor(p), p.id === armbandId && livePointsById ? '×2' : null, p.id === xi.viceCaptain?.id)).join('')}</div>
          <div class="pitch-row">${rows.fwd.map((p) => pitchPlayerHTML(p, p.id === cap.id, pointsFor(p), p.id === armbandId && livePointsById ? '×2' : null, p.id === xi.viceCaptain?.id)).join('')}</div>
        </div>
        <div class="bench-row">
          <div class="list-subhead">Subs (within budget) — reserve picks, not part of the 3-way vote</div>
          <div class="pitch-row">${xi.bench.map((p) => pitchPlayerHTML(p, false, 'TBD', `Reserve · xPts ${parseFloat(p.epNext || 0).toFixed(1)}`)).join('')}</div>
        </div>
        <div class="captaincy-box">
          <div class="list-subhead">Captaincy pick</div>
          ${xi.captaincyPicks.map((p, i) => {
            // Fall back to position-based labeling for any pre-existing KV
            // snapshot written before this field existed (no captaincyPicks
            // entry had a `role` yet) — never render a raw "undefined".
            const role = p.role || (i === 0 ? 'Captain' : 'Vice-Captain');
            // Real, confirmed case (GW1's own locked/frozen data, 2026-08-22):
            // an even older snapshot can have `role` but no `reason` key at
            // all — GW1 is hard-locked and can never be recomputed, so this
            // has to be a display-side fallback, not a data fix.
            const reason = p.reason || (p.epNext != null ? `xPts ${parseFloat(p.epNext).toFixed(1)}` : 'Backup captaincy option');
            return `
            <div class="list-row">
              ${playerBadgeSrc(p) ? `<img class="mini-badge" src="${playerBadgeSrc(p)}" alt="${p.team}" />` : ''}
              <span class="list-name">${role === 'Captain' ? '⭐ ' : '🅱️ '}${p.name} <span style="color:var(--text-dim);font-weight:400;">(${role})</span></span>
              <span class="list-stat">${reason}</span>
            </div>
          `;
          }).join('')}
        </div>
        ${updatesDisclaimerHTML()}
      </div>
      ${pastPanels}
    </section>
  `;
}

function setupGwSwitcher(selectId, liveViewId, panelPrefix, activeGwId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.addEventListener('change', (e) => {
    const gwId = Number(e.target.value);
    const liveView = document.getElementById(liveViewId);
    if (liveView) liveView.style.display = gwId === activeGwId ? '' : 'none';
    document.querySelectorAll(`[id^="${panelPrefix}-past-"]`).forEach((el) => {
      el.style.display = 'none';
    });
    if (gwId !== activeGwId) {
      const panel = document.getElementById(`${panelPrefix}-past-${gwId}`);
      if (panel) panel.style.display = 'block';
    }
  });
}

function fmtKickoff(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function seasonFixturesShellHTML() {
  return `
    <section class="block tile-full" id="season-fixtures-block">
      <h2>📅 Season Fixtures</h2>
      <p class="block-desc">Browse any gameweek across the full season. Click a match to expand it — kickoff time if it hasn't been played, or BPS/cards/goals/assists once it's finished.</p>
      <select id="fixtures-gw-select" class="tool-input"></select>
      <div id="fixtures-list" class="fixtures-grid" style="margin-top:14px;"></div>
    </section>
  `;
}

function h2hFixturesShellHTML() {
  return `
    <section class="block tile-wide" id="h2h-fixtures-block">
      <h2>🏆 Inferno League</h2>
      <p class="block-desc">Our own 14-person mini-league — H2H fixtures and overall standings. FPL only generates these once Gameweek 1 kicks off.</p>
      <h3 style="color:var(--pink);margin-top:6px;margin-bottom:8px;">H2H Fixtures</h3>
      <select id="h2h-gw-select" class="tool-input"></select>
      <div id="h2h-fixtures-list" style="margin-top:14px;"></div>
      <h3 style="color:var(--pink);margin-top:24px;margin-bottom:8px;">⚔️ Inferno 14 H2H — League Table</h3>
      <div id="h2h-standings-list"></div>
      <h3 style="color:var(--green);margin-top:24px;margin-bottom:8px;">🏅 Inferno 14 League — Classic Standings</h3>
      <div id="league-standings-list"></div>
    </section>
  `;
}

function renderLeagueStandings() {
  const list = document.getElementById('league-standings-list');
  const standings = STATE.data.leagueStandings;
  if (!standings || !standings.length) {
    list.innerHTML = '<p class="block-desc">Not generated yet — check back once Gameweek 1 results are in.</p>';
    return;
  }
  const moveIcon = (m) => m === 'up'
    ? '<span style="color:var(--green);">▲</span>'
    : m === 'down'
      ? '<span style="color:var(--pink);">▼</span>'
      : '<span style="color:var(--text-dim,#9a94a8);">•</span>';
  list.innerHTML = `
    <div class="table-scroll">
    <table class="compare-table">
      <thead><tr><th></th><th>Team</th><th>Manager</th><th>GW pts</th><th>Total</th></tr></thead>
      <tbody>
        ${standings.map((s) => `
          <tr>
            <td>${moveIcon(s.movement)} ${s.rank}</td>
            <td>${s.teamName}</td>
            <td>${s.managerName}</td>
            <td>${s.gwPoints}</td>
            <td><strong>${s.totalPoints}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function renderH2HStandings() {
  const list = document.getElementById('h2h-standings-list');
  const standings = STATE.data.h2hStandings;
  if (!standings || !standings.length) {
    list.innerHTML = '<p class="block-desc">Not generated yet — check back once Gameweek 1 results are in.</p>';
    return;
  }
  // Real FPL behavior, not a bug: H2H match results (and this table) only
  // finalize once FPL fully processes a gameweek, which lags behind the
  // live "GW pts" shown in the classic table above — every row can
  // legitimately show 0 played mid-gameweek even while real points are
  // being scored live elsewhere on the site.
  const allZero = standings.every((s) => s.played === 0);
  const moveIcon = (m) => m === 'up'
    ? '<span style="color:var(--green);">▲</span>'
    : m === 'down'
      ? '<span style="color:var(--pink);">▼</span>'
      : '<span style="color:var(--text-dim,#9a94a8);">•</span>';
  list.innerHTML = `
    ${allZero ? '<p class="rule-note" style="margin-bottom:8px;">Results still processing on FPL\'s side for this gameweek — win/loss records update once they finalize it, usually shortly after the gameweek fully finishes.</p>' : ''}
    <div class="table-scroll">
    <table class="compare-table">
      <thead><tr><th></th><th>Team</th><th>Manager</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Pts</th></tr></thead>
      <tbody>
        ${standings.map((s) => `
          <tr>
            <td>${moveIcon(s.movement)} ${s.rank}</td>
            <td>${s.teamName}</td>
            <td>${s.managerName}</td>
            <td>${s.played}</td>
            <td>${s.won}</td>
            <td>${s.drawn}</td>
            <td>${s.lost}</td>
            <td><strong>${s.leaguePoints}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function renderH2HFixtures(gwId) {
  const list = document.getElementById('h2h-fixtures-list');
  const matches = STATE.data.h2hFixturesByGw?.[gwId];
  if (!matches || !matches.length) {
    list.innerHTML = '<p class="block-desc">Not generated yet — check back once this gameweek\'s schedule is live.</p>';
    return;
  }
  // Dedicated grid layout, not the generic single-line .fixture-row it used
  // to reuse — H2H team names are free-text, user-chosen fantasy team names
  // (real example: "Skibidi Red Devils", "Unal mudiyath thambi"), routinely
  // much longer than the short real-club names (e.g. "ARS") that
  // .fixture-row was actually designed for. Forcing name+player+score,
  // twice, into one flex line caused exactly the cramped, unpredictably-
  // wrapped mess a real device screenshot caught. Three explicit grid
  // columns (team | score | team) let each side wrap within its OWN column
  // instead of the whole row reflowing unpredictably, and collapses to a
  // stacked single column below 480px (see CSS) where even one column is
  // tight for these names.
  list.innerHTML = matches.map((m) => `
    <div class="h2h-match-card">
      <div class="h2h-team h2h-team-home">
        <span class="h2h-team-name">${m.home.name}</span>
        <span class="h2h-player">${m.home.playerName}</span>
      </div>
      <div class="h2h-score">
        <span class="h2h-score-num">${typeof m.home.points === 'number' ? m.home.points : '–'}</span>
        <span class="vs">v</span>
        <span class="h2h-score-num">${typeof m.away.points === 'number' ? m.away.points : '–'}</span>
      </div>
      <div class="h2h-team h2h-team-away">
        <span class="h2h-team-name">${m.away.name}</span>
        <span class="h2h-player">${m.away.playerName}</span>
      </div>
    </div>
  `).join('');
}

function setupH2HFixtures() {
  const select = document.getElementById('h2h-gw-select');
  select.innerHTML = STATE.data.gameweeks
    .map((g) => `<option value="${g.id}">${g.name}${g.isNext ? ' (next)' : ''}</option>`).join('');
  // Our own tracked gameweekId (see determineActiveGwId in lib/history.mjs),
  // not FPL's raw "is_next" flag — that flips forward the moment a deadline
  // passes, even while that gameweek's matches are still being played, which
  // would default this selector one gameweek ahead of what's actually live.
  const defaultGw = STATE.data.gameweeks.find((g) => g.id === STATE.data.gameweekId)
    || STATE.data.gameweeks.find((g) => g.isNext)
    || STATE.data.gameweeks[0];
  select.value = defaultGw.id;
  renderH2HFixtures(defaultGw.id);
  select.addEventListener('change', (e) => renderH2HFixtures(Number(e.target.value)));
  renderLeagueStandings();
  renderH2HStandings();
}

function renderFixturesList(gwId) {
  const gw = STATE.data.allGameweekFixtures.find((g) => g.event === gwId);
  const list = document.getElementById('fixtures-list');
  if (!gw || !gw.fixtures.length) {
    list.innerHTML = '<p class="block-desc">No fixtures scheduled for this gameweek.</p>';
    return;
  }
  list.innerHTML = gw.fixtures.map((f, i) => {
    // FPL's own official `finished` flag only flips once bonus points are
    // fully confirmed, which can lag an hour+ behind the match itself
    // actually ending — `finishedProvisional` (true once the match is
    // over, regardless of bonus-point confirmation) is the real "is this
    // still being played" signal; without it, a match sitting in that gap
    // shows LIVE long after full time.
    const over = f.finished || f.finishedProvisional;
    const live = f.started && !over;
    const scoreTag = (over || live) && f.homeScore != null
      ? `<span class="score">${f.homeScore}-${f.awayScore}</span>`
      : '';
    const statusTag = live
      ? '<span class="kickoff" style="color:#d4222a;font-weight:700;">🔴 LIVE</span>'
      : over
        ? '<span class="kickoff" style="color:var(--green);font-weight:700;">FT</span>'
        : `<span class="kickoff">${fmtKickoff(f.kickoff)}</span>`;
    return `
    <div class="fixture-row-wrap">
      <button class="fixture-row" data-idx="${i}" type="button">
        <img class="mini-badge" src="${f.homeBadge}" />${f.home}
        <span class="vs">v</span>
        ${f.away}<img class="mini-badge" src="${f.awayBadge}" />
        ${scoreTag}
        ${statusTag}
      </button>
      <div class="fixture-detail" id="fixture-detail-${i}"></div>
    </div>
  `;
  }).join('');

  list.querySelectorAll('.fixture-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      const detail = document.getElementById(`fixture-detail-${idx}`);
      const isOpen = detail.classList.contains('open');
      if (isOpen) {
        detail.classList.remove('open');
        detail.innerHTML = '';
        return;
      }
      const f = gw.fixtures[idx];
      const statEntries = Object.entries(f.stats || {});
      const statHTML = statEntries.length
        ? statEntries.map(([label, entries]) => `
          <div class="stat-line">
            <span class="stat-label">${label}</span>
            <span class="stat-chips">${entries.map((en) => `<span class="stat-chip">${en}</span>`).join('')}</span>
          </div>`).join('')
        : null;
      // Same finished-vs-finishedProvisional distinction as the row badge
      // above — a provisionally-finished match is genuinely over, just
      // still waiting on FPL's own bonus-point confirmation, so it gets
      // the same "finished" detail view, not the live-in-progress one.
      if (f.finished || f.finishedProvisional) {
        detail.innerHTML = statHTML || '<p class="block-desc">Match finished, no stat breakdown recorded.</p>';
      } else if (f.started) {
        // Real events as of the last daily refresh — this site isn't a
        // live minute-by-minute ticker, so goals/cards recorded after the
        // most recent refresh won't show until the next one.
        detail.innerHTML = `${statHTML || '<p class="block-desc">Match in progress — no events recorded as of the last refresh yet.</p>'}<p class="rule-note" style="margin-top:6px;">🔴 Live — reflects events as of the last daily refresh, not real-time.</p>`;
      } else {
        detail.innerHTML = `<p class="block-desc">Kickoff: ${fmtKickoff(f.kickoff)}</p>`;
      }
      detail.classList.add('open');
    });
  });
}

function setupSeasonFixtures() {
  const select = document.getElementById('fixtures-gw-select');
  select.innerHTML = STATE.data.gameweeks
    .map((g) => `<option value="${g.id}">${g.name}${g.isNext ? ' (next)' : ''}</option>`).join('');
  // Same reasoning as setupH2HFixtures — default to our own tracked active
  // gameweek, not FPL's raw "is_next" flag.
  const defaultGw = STATE.data.gameweeks.find((g) => g.id === STATE.data.gameweekId)
    || STATE.data.gameweeks.find((g) => g.isNext)
    || STATE.data.gameweeks[0];
  select.value = defaultGw.id;
  renderFixturesList(defaultGw.id);
  select.addEventListener('change', (e) => renderFixturesList(Number(e.target.value)));
}

function setPieceTakersHTML(data) {
  const items = data.setPieceTakers || [];
  if (!items.length) return '';
  return `
    <section class="block tile-wide">
      <h2>🎯 Set Piece Takers</h2>
      <p class="block-desc">First-choice penalty and free-kick takers per team, straight from the official FPL data.</p>
      ${scrollHintHTML('setpiece-scroll')}
      <div class="fdr-scroll" id="setpiece-scroll">
        <table class="fixture-table">
          <thead><tr><th>Team</th><th>Penalties</th><th>Free Kicks</th></tr></thead>
          <tbody>
            ${items.map((t) => `
              <tr>
                <td><img class="mini-badge" src="${t.badge}" />${t.team}</td>
                <td>${t.penalty || '-'}</td>
                <td>${t.freekicks || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function aiRecommendationHTML(data) {
  const history = data.history || [];
  const activeEntry = history.find((e) => e.event === data.gameweekId);

  // Once locked, the AI's picks freeze right alongside Best XI/Differentials
  // (see lockedAi in history.mjs) — otherwise this panel would leak a
  // fresher post-lock signal through the back door.
  const aiFrozen = activeEntry && (activeEntry.phase === 'locked' || activeEntry.phase === 'live') && activeEntry.lockedAi;
  const ai = aiFrozen || data.ai;

  const unavailable = '<p class="block-desc">Unavailable this refresh.</p>';
  const captainVotes = Array.isArray(ai?.captainSources) ? ai.captainSources.length : null;
  const captainBlock = ai?.captainPick
    ? `<div class="list-subhead" style="color:#ffcc00">Consensus captain pick (${captainVotes ?? '?'}/3 agree)</div><p class="block-desc"><strong>${ai.captainPick}</strong>${ai?.viceCaptainPick ? ` <span style="color:var(--text-dim)">· VC: <strong>${ai.viceCaptainPick}</strong></span>` : ''}</p>`
    : `<div class="list-subhead" style="color:#ffcc00">Consensus captain pick</div>${unavailable}`;
  const diffNames = (ai?.differentialPicks || []).map((p) => `${p.name} (${(p.sources || []).length}/3)`);
  const diffBlock = diffNames.length
    ? `<div class="list-subhead" style="color:var(--pink)">Consensus differential picks</div><p class="block-desc"><strong>${diffNames.join(', ')}</strong></p>`
    : `<div class="list-subhead" style="color:var(--pink)">Consensus differential picks</div>${unavailable}`;
  const chipBlock = ai?.chipStrategy
    ? `<div class="list-subhead" style="color:var(--green)">Chip strategy</div><p class="block-desc">${ai.chipStrategy}</p>`
    : `<div class="list-subhead" style="color:var(--green)">Chip strategy</div>${unavailable}`;

  return `
    <section class="block side-block">
      <div class="hero-top-row">
        <h2>🤖 AI Recommendation</h2>
        <span class="formation-tag" style="white-space:nowrap;">${data.gameweek || `Gameweek ${data.gameweekId}`}</span>
      </div>
      ${lockBadgeHTML(activeEntry)}
      <p class="block-desc">Best XI, captain, and differentials are a 3-way consensus: FPL Data (our own deterministic scoring), Google Gemini, and Groq each independently analyze the real stats from scratch and vote — a player needs 2 of 3 to make the final pick.</p>
      ${captainBlock}
      ${diffBlock}
      ${chipBlock}
      ${updatesDisclaimerHTML()}
    </section>
  `;
}

function differentialsHTML(data) {
  const history = data.history || [];
  const activeEntry = history.find((e) => e.event === data.gameweekId);
  const frozen = activeEntry && (activeEntry.phase === 'locked' || activeEntry.phase === 'live') && activeEntry.lockedDifferentials;
  const diffs = frozen || data.differentials;
  const completedEntries = history.filter((e) => e.status === 'complete');
  const liveDiffPointsById = activeEntry && activeEntry.phase === 'live' && Array.isArray(activeEntry.diffPlayers)
    ? Object.fromEntries(activeEntry.diffPlayers.map((p) => [p.id, p.points]))
    : null;
  const diffPointsFor = (p) => (liveDiffPointsById && liveDiffPointsById[p.id] != null ? String(liveDiffPointsById[p.id]) : 'TBD');

  const gwOptions = (data.gameweeks || []).map((g) => {
    const isActive = g.id === data.gameweekId;
    const completed = completedEntries.find((e) => e.event === g.id);
    const selectable = isActive || !!completed;
    const label = isActive ? g.name : completed ? `${g.name} — resolved` : `${g.name} (locked)`;
    return `<option value="${g.id}" ${isActive ? 'selected' : ''} ${selectable ? '' : 'disabled'}>${label}</option>`;
  }).join('');

  const pastPanels = completedEntries.map((e) => {
    return `
    <div class="past-gw-panel" id="differentials-past-${e.event}">
      <p class="block-desc">GW${e.event} differential picks and what they actually scored.</p>
      <div class="grid" style="margin-top:14px;">
        ${e.diffPlayers.map((p) => `
          <div class="player-card" data-player-id="${p.id}">
            <div class="name">${p.name}</div>
            <div class="meta">${p.team}</div>
            <div class="stat-row">${p.points} pts</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  }).join('');

  return `
    <section class="block tile-wide">
      <div class="hero-top-row">
        <h2>💎 Differentials</h2>
        <select class="tool-input gw-lock-select" id="differentials-gw-select">${gwOptions}</select>
      </div>
      <p class="block-desc">Low-ownership players (under 10% picked) with strong underlying form for ${data.gameweek || 'this gameweek'} — the punts that can win you rank. Ranked by 3-way consensus (our own scoring, Gemini, and Groq each vote independently).</p>
      <div id="differentials-live-view">
        ${lockBadgeHTML(activeEntry)}
        <div class="grid" style="margin-top:14px;">
          ${diffs.map((p) => playerCardHTML(p, { showReason: true, showStat: (pl) => `${pl.nextFixture || 'Fixture TBC'} · Points: ${diffPointsFor(pl)}` })).join('')}
        </div>
        ${updatesDisclaimerHTML()}
      </div>
      ${pastPanels}
    </section>
  `;
}

// Clamps and rounds a (possibly Elo-blended, fractional) difficulty value
// onto the existing 5-tier diff-N color classes — those only exist for
// whole numbers 1-5, so a blended 2.4 still needs a concrete bucket to color.
function diffClass(d) {
  return `diff-${Math.min(5, Math.max(1, Math.round(d)))}`;
}

function fdrCellHTML(f) {
  if (!f) return '<td class="fdr-cell fdr-blank">-</td>';
  const winPct = typeof f.winProbability === 'number' ? `<br><span class="win-prob">${f.winProbability.toFixed(0)}% win</span>` : '';
  return `<td class="fdr-cell ${diffClass(f.difficulty)}" title="Difficulty ${f.difficulty}">${f.opponent} (${f.venue})${winPct}</td>`;
}

// Full teams x next-gameweeks grid, sorted easiest overall run first — a
// complete picture in one table rather than a top-6-easiest/top-6-hardest
// split, matching how FDR tables are usually presented in the FPL community.
function fixtureSwingsHTML(data) {
  const teams = data.fixtureSwings.teams || [];
  const events = [...new Set(teams.flatMap((t) => t.fixtures.map((f) => f.event)))].sort((a, b) => a - b);
  const gwName = (id) => (data.gameweeks || []).find((g) => g.id === id)?.name?.replace('Gameweek ', 'GW') || `GW${id}`;
  return `
    <section class="block tile-full">
      <div class="hero-top-row">
        <h2>📊 Fixture Difficulty Rating</h2>
        <span class="fdr-legend">Easy <span class="fdr-legend-swatch diff-1"></span><span class="fdr-legend-swatch diff-2"></span><span class="fdr-legend-swatch diff-3"></span><span class="fdr-legend-swatch diff-4"></span><span class="fdr-legend-swatch diff-5"></span> Hard</span>
      </div>
      <p class="block-desc">Every team's next ${events.length} fixtures, easiest overall run first. Blends FPL's own rating with real Elo team-strength data where available. Where shown, the % is that team's win probability for the match.</p>
      ${scrollHintHTML('fdr-grid-scroll')}
      <div class="fdr-scroll" id="fdr-grid-scroll">
        <table class="fixture-table fdr-table">
          <thead>
            <tr>
              <th>Team</th>
              <th>Avg FDR</th>
              ${events.map((e) => `<th>${gwName(e)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${teams.map((t) => {
              const byEvent = Object.fromEntries(t.fixtures.map((f) => [f.event, f]));
              return `
              <tr>
                <td><img class="mini-badge" src="${t.badge}" />${t.team}</td>
                <td><span class="fdr-avg-pill ${diffClass(t.avgDifficulty)}">${t.avgDifficulty}</span></td>
                ${events.map((e) => fdrCellHTML(byEvent[e])).join('')}
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function injuryStatusText(p) {
  if (p.news) {
    const text = p.news.trim();
    const unknownMatch = text.match(/^(.*?)\s*-\s*unknown return date$/i);
    if (unknownMatch) {
      const reason = unknownMatch[1].trim();
      return reason ? `${reason} — return unknown` : 'Return unknown';
    }
    if (text) return text;
  }
  if (p.chanceOfPlaying != null) return `${p.chanceOfPlaying}% chance of playing`;
  return 'Unknown';
}

function injuryRowHTML(p) {
  return listRowHTML(p, injuryStatusText(p));
}

function injuryWatchHTML(data) {
  const items = data.injuryWatch;
  return `
    <section class="block tile-wide">
      <h2>🚑 Injury Watch</h2>
      <p class="block-desc" style="margin-bottom:8px;">Straight from FPL's own official status data, latest updates first.</p>
      ${items.length
        ? items.map(injuryRowHTML).join('')
        : '<p class="block-desc">No fitness concerns flagged right now.</p>'
      }
    </section>
  `;
}

function newSigningsHTML(data) {
  const items = data.newSignings || [];
  if (!items.length) return '';
  return `
    <section class="block side-block">
      <h2>🆕 New Signings</h2>
      ${items.map((p) => listRowHTML(p, `£${p.price}m`)).join('')}
    </section>
  `;
}

function priceWatchHTML(data) {
  const pw = data.priceWatch;
  return `
    <section class="block side-block">
      <h2>💰 Price Watch</h2>
      <p class="block-desc">Predicted moves — ranked by this gameweek's net transfer momentum, before FPL's overnight price update actually happens.</p>
      ${!pw.active
        ? '<p class="block-desc">Activates once the season starts and transfers kick in.</p>'
        : `
          <div class="list-subhead" style="color:var(--green)">Likely risers</div>
          ${pw.risers.map((p) => listRowHTML(p, `£${p.price}m · +${p.netTransfers.toLocaleString()}`)).join('')}
          <div class="list-subhead" style="color:var(--pink)">Likely fallers</div>
          ${pw.fallers.map((p) => listRowHTML(p, `£${p.price}m · ${p.netTransfers.toLocaleString()}`)).join('')}
        `
      }
    </section>
  `;
}

// Real, already-happened price moves (FPL's own cost_change_event) —
// distinct from Price Watch above, which predicts a move BEFORE it
// happens from transfer momentum. This shows what's actually already
// moved, so a rise/fall shown here is real and final for today, not a
// forecast.
function priceChangesHTML(data) {
  const pc = data.priceChanges;
  if (!pc) return '';
  return `
    <section class="block side-block">
      <h2>📈 Price Changes <span class="formation-tag" style="vertical-align:middle;">⏱ ${nextPriceUpdateTime()}</span></h2>
      <p class="block-desc">Real moves already applied by FPL's overnight price update — not a prediction.</p>
      ${!pc.active
        ? '<p class="block-desc">No price changes yet today.</p>'
        : `
          <div class="list-subhead" style="color:var(--green)">Risen today</div>
          ${pc.risers.length ? pc.risers.map((p) => listRowHTML(p, `£${p.price}m · +£${(p.costChangeEvent / 10).toFixed(1)}m`)).join('') : '<p class="block-desc">None today.</p>'}
          <div class="list-subhead" style="color:var(--pink)">Fallen today</div>
          ${pc.fallers.length ? pc.fallers.map((p) => listRowHTML(p, `£${p.price}m · -£${Math.abs(p.costChangeEvent / 10).toFixed(1)}m`)).join('') : '<p class="block-desc">None today.</p>'}
        `
      }
    </section>
  `;
}

// ---------- Analysis Tools shell (tabs) ----------

function toolsShellHTML() {
  return `
    <section class="block tools-block tile-full">
      <h2>🔬 Analysis Tools</h2>
      <p class="block-desc">Comparisons are based on form, points per game, goals, assists, xG, xA, ICT Index, threat, creativity and defensive contribution.</p>
      <div class="tabs">
        <button class="tab-btn active" data-tab="players">Compare Players</button>
        <button class="tab-btn" data-tab="teams">Compare Teams</button>
        <button class="tab-btn" data-tab="rate">Rate My First 11</button>
        <button class="tab-btn" data-tab="playerstats">Player Statistics</button>
        <button class="tab-btn" data-tab="statsgw">Stats Per GW</button>
      </div>

      <div class="tab-panel active" id="tab-players">
        <div class="picker-row">
          <input type="text" id="player-search" class="tool-input" placeholder="Search a player to add (up to 5)…" autocomplete="off" />
          <div id="player-search-results" class="search-results"></div>
        </div>
        <div id="player-tray" class="compare-tray"></div>
        <label class="slider-label">Fixture horizon: <span id="player-horizon-val">5</span> GWs ahead
          <input type="range" id="player-horizon" min="1" max="10" value="5" />
        </label>
        <div id="player-compare-output"></div>
      </div>

      <div class="tab-panel" id="tab-teams">
        <div class="picker-row">
          <input type="text" id="team-search" class="tool-input" placeholder="Search a team to add (up to 5)…" autocomplete="off" />
          <div id="team-search-results" class="search-results"></div>
        </div>
        <div id="team-tray" class="compare-tray"></div>
        <label class="slider-label">Fixture horizon: <span id="team-horizon-val">5</span> GWs ahead
          <input type="range" id="team-horizon" min="1" max="10" value="5" />
        </label>
        <div id="team-compare-output"></div>
      </div>

      <div class="tab-panel" id="tab-rate">
        <div class="picker-row">
          <input type="text" id="rate-search" class="tool-input" placeholder="Add your picks (up to 11)…" autocomplete="off" />
          <div id="rate-search-results" class="search-results"></div>
        </div>
        <div id="rate-tray" class="compare-tray"></div>
        <label class="slider-label">Rate against next <span id="rate-horizon-val">5</span> GWs
          <input type="range" id="rate-horizon" min="1" max="10" value="5" />
        </label>
        <div id="rate-output"></div>
      </div>

      <div class="tab-panel" id="tab-playerstats">
        <p class="rule-note">Real per-gameweek data (Tck/CBI/Rec/DC Hit) sourced from the open FPL-Core-Insights dataset. All-zero until Gameweek 1 actually kicks off — this isn't a bug, the season just hasn't started yet.</p>
        <div class="picker-row">
          <input type="text" id="playerstats-search" class="tool-input" placeholder="Search players…" autocomplete="off" />
          <select id="playerstats-position" class="tool-input" style="max-width:140px;">
            <option value="ALL">All positions</option>
            <option value="GKP">GKP</option>
            <option value="DEF">DEF</option>
            <option value="MID">MID</option>
            <option value="FWD">FWD</option>
          </select>
        </div>
        ${scrollHintHTML('playerstats-scroll')}
        <div class="fdr-scroll" id="playerstats-scroll"><table class="fixture-table stats-table" id="playerstats-table"></table></div>
        <div class="table-pagination" id="playerstats-pagination"></div>
      </div>

      <div class="tab-panel" id="tab-statsgw">
        <p class="rule-note">Real per-gameweek points, only for gameweeks FPL itself has marked finished — blank cells are gameweeks not yet played, not zero scores.</p>
        <div class="picker-row">
          <input type="text" id="statsgw-search" class="tool-input" placeholder="Search players…" autocomplete="off" />
        </div>
        ${scrollHintHTML('statsgw-scroll')}
        <div class="fdr-scroll" id="statsgw-scroll"><table class="fixture-table stats-table" id="statsgw-table"></table></div>
        <div class="table-pagination" id="statsgw-pagination"></div>
      </div>
    </section>
  `;
}

// Blue heat scale for the Stats Per Gameweek grid — deliberately a plain
// linear ramp on raw points (not percentile-normalized) so a 10-point haul
// always reads the same dark blue regardless of what anyone else scored
// that week; a manager scanning for "big weeks" wants an absolute read, not
// a relative one that shifts week to week.
function heatColor(pts) {
  if (pts == null) return 'transparent';
  if (pts <= 0) return 'rgba(255,255,255,0.03)';
  const clamped = Math.min(pts, 15);
  const alpha = 0.12 + (clamped / 15) * 0.7;
  return `rgba(0, 148, 255, ${alpha.toFixed(2)})`;
}

function renderStatsPerGwTable() {
  const table = document.getElementById('statsgw-table');
  if (!table) return;
  const t = STATE.statsGwTool;
  const all = STATE.data.playerStats || [];
  const gwIds = (STATE.data.gameweeks || []).map((g) => g.id);

  const q = t.search.trim().toLowerCase();
  let rows = all.filter((p) => !q || p.name.toLowerCase().includes(q));
  const totalOf = (p) => Object.values(p.gwPoints || {}).reduce((s, v) => s + v, 0);
  rows.sort((a, b) => totalOf(b) - totalOf(a));

  const totalPages = Math.max(1, Math.ceil(rows.length / t.perPage));
  t.page = Math.min(t.page, totalPages);
  const pageRows = rows.slice((t.page - 1) * t.perPage, t.page * t.perPage);

  table.innerHTML = `
    <thead>
      <tr>
        <th>Player</th>
        <th>Total</th>
        ${gwIds.map((gw) => `<th>GW${gw}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${pageRows.map((p) => `
        <tr data-player-id="${p.id}" style="cursor:pointer;">
          <td><img class="mini-badge" src="${playerBadgeSrc(p)}" />${p.name} <span class="block-desc">${p.team}·${p.position}</span></td>
          <td>${totalOf(p)}</td>
          ${gwIds.map((gw) => {
            const pts = p.gwPoints?.[gw];
            return `<td style="background:${heatColor(pts)};">${pts != null ? pts : '-'}</td>`;
          }).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;

  const pagination = document.getElementById('statsgw-pagination');
  pagination.innerHTML = `
    <button type="button" id="statsgw-prev" ${t.page <= 1 ? 'disabled' : ''}>◀ Prev</button>
    <span>Page ${t.page} of ${totalPages} · ${rows.length} players</span>
    <button type="button" id="statsgw-next" ${t.page >= totalPages ? 'disabled' : ''}>Next ▶</button>
  `;
  document.getElementById('statsgw-prev')?.addEventListener('click', () => { t.page--; renderStatsPerGwTable(); });
  document.getElementById('statsgw-next')?.addEventListener('click', () => { t.page++; renderStatsPerGwTable(); });
}

function setupStatsPerGwTool() {
  if (!STATE.data.playerStats) return;
  STATE.statsGwTool = { search: '', page: 1, perPage: 50 };
  document.getElementById('statsgw-search').addEventListener('input', (e) => {
    STATE.statsGwTool.search = e.target.value;
    STATE.statsGwTool.page = 1;
    renderStatsPerGwTable();
  });
  renderStatsPerGwTable();
}

const PLAYER_STATS_COLUMNS = [
  { key: 'name', label: 'Player' },
  { key: 'ownership', label: 'Own %' },
  { key: 'apps', label: 'Apps' },
  { key: 'minsPerApp', label: 'Mins/gm' },
  { key: 'pts', label: 'Pts' },
  { key: 'pts90', label: 'Pts/90' },
  { key: 'goals', label: 'G' },
  { key: 'goals90', label: 'G/90' },
  { key: 'xG', label: 'xG' },
  { key: 'xG90', label: 'xG/90' },
  { key: 'assists', label: 'A' },
  { key: 'assists90', label: 'A/90' },
  { key: 'xA', label: 'xA' },
  { key: 'xA90', label: 'xA/90' },
  { key: 'gi', label: 'GI' },
  { key: 'gi90', label: 'GI/90' },
  { key: 'xGI', label: 'xGI' },
  { key: 'xGI90', label: 'xGI/90' },
  { key: 'dcHits', label: 'DC Hit' },
  { key: 'dcHitPct', label: 'DC Hit %' },
  { key: 'dc90', label: 'DC/90' },
  { key: 'cleanSheets', label: 'CS' },
  { key: 'goalsConceded', label: 'GC' },
  { key: 'xGC', label: 'xGC' },
  { key: 'tackles', label: 'Tck' },
  { key: 'cbi', label: 'CBI' },
  { key: 'recoveries', label: 'Rec' },
  { key: 'ictIndexTotal', label: 'ICT' },
];

function renderPlayerStatsTable() {
  const table = document.getElementById('playerstats-table');
  if (!table) return;
  const t = STATE.playerStatsTool;
  const all = STATE.data.playerStats || [];

  const q = t.search.trim().toLowerCase();
  let rows = all.filter((p) => (t.position === 'ALL' || p.position === t.position) && (!q || p.name.toLowerCase().includes(q)));
  rows.sort((a, b) => {
    const av = a[t.sortKey];
    const bv = b[t.sortKey];
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return t.sortDir === 'asc' ? cmp : -cmp;
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / t.perPage));
  t.page = Math.min(t.page, totalPages);
  const pageRows = rows.slice((t.page - 1) * t.perPage, t.page * t.perPage);

  const arrow = (key) => (t.sortKey === key ? (t.sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  table.innerHTML = `
    <thead>
      <tr>
        ${PLAYER_STATS_COLUMNS.map((c) => `<th class="sortable-th" data-sort="${c.key}">${c.label}${arrow(c.key)}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${pageRows.map((p) => `
        <tr data-player-id="${p.id}" style="cursor:pointer;">
          <td><img class="mini-badge" src="${playerBadgeSrc(p)}" />${p.name} <span class="block-desc">${p.team}·${p.position}</span></td>
          <td>${p.ownership.toFixed(1)}%</td>
          <td>${p.apps}</td>
          <td>${p.minsPerApp}</td>
          <td>${p.pts}</td>
          <td>${p.pts90}</td>
          <td>${p.goals}</td>
          <td>${p.goals90}</td>
          <td>${p.xG}</td>
          <td>${p.xG90}</td>
          <td>${p.assists}</td>
          <td>${p.assists90}</td>
          <td>${p.xA}</td>
          <td>${p.xA90}</td>
          <td>${p.gi}</td>
          <td>${p.gi90}</td>
          <td>${p.xGI}</td>
          <td>${p.xGI90}</td>
          <td>${p.dcHits}</td>
          <td>${p.dcHitPct}%</td>
          <td>${p.dc90}</td>
          <td>${p.cleanSheets}</td>
          <td>${p.goalsConceded}</td>
          <td>${p.xGC}</td>
          <td>${p.tackles}</td>
          <td>${p.cbi}</td>
          <td>${p.recoveries}</td>
          <td>${p.ictIndexTotal}</td>
        </tr>
      `).join('')}
    </tbody>
  `;

  const pagination = document.getElementById('playerstats-pagination');
  pagination.innerHTML = `
    <button type="button" id="playerstats-prev" ${t.page <= 1 ? 'disabled' : ''}>◀ Prev</button>
    <span>Page ${t.page} of ${totalPages} · ${rows.length} players</span>
    <button type="button" id="playerstats-next" ${t.page >= totalPages ? 'disabled' : ''}>Next ▶</button>
  `;

  table.querySelectorAll('.sortable-th').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (t.sortKey === key) t.sortDir = t.sortDir === 'asc' ? 'desc' : 'asc';
      else { t.sortKey = key; t.sortDir = key === 'name' ? 'asc' : 'desc'; }
      renderPlayerStatsTable();
    });
  });
  document.getElementById('playerstats-prev')?.addEventListener('click', () => { t.page--; renderPlayerStatsTable(); });
  document.getElementById('playerstats-next')?.addEventListener('click', () => { t.page++; renderPlayerStatsTable(); });
}

function setupPlayerStatsTool() {
  if (!STATE.data.playerStats) return;
  STATE.playerStatsTool = { search: '', position: 'ALL', sortKey: 'ownership', sortDir: 'desc', page: 1, perPage: 50 };
  document.getElementById('playerstats-search').addEventListener('input', (e) => {
    STATE.playerStatsTool.search = e.target.value;
    STATE.playerStatsTool.page = 1;
    renderPlayerStatsTable();
  });
  document.getElementById('playerstats-position').addEventListener('change', (e) => {
    STATE.playerStatsTool.position = e.target.value;
    STATE.playerStatsTool.page = 1;
    renderPlayerStatsTable();
  });
  renderPlayerStatsTable();
}

// ---------- Shared scoring helpers (transparent, rule-based — not a live AI model) ----------

function fixturesAhead(teamId, horizon) {
  return (STATE.data.fixturesByTeamId[teamId] || []).slice(0, horizon);
}

function avgDifficulty(teamId, horizon) {
  const fx = fixturesAhead(teamId, horizon);
  if (!fx.length) return null;
  return fx.reduce((s, f) => s + f.difficulty, 0) / fx.length;
}

function fixtureChipsHTML(teamId, horizon) {
  const fx = fixturesAhead(teamId, horizon);
  if (!fx.length) return '<span class="block-desc">No scheduled fixtures found.</span>';
  return fx.map((f) => `<span class="fixture-chip">${diffPill(f.difficulty)}${f.opponent} (${f.venue})</span>`).join(' ');
}

// ---------- Shared on-demand AI analysis (Rate My Squad, Compare Players, Compare Teams) ----------
// All three tools call the same /ai-analyze endpoint, which shares one daily
// cap across all of them (see functions/ai-analyze.js) — the payload is
// always real, already-computed data the user picked; Gemini only comments
// on it, never invents a name.

async function requestAiAnalysis(kind, payload) {
  try {
    const res = await fetch('/ai-analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, payload }),
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      return {
        error: body.error === 'daily_cap_reached'
          ? 'Daily AI analysis limit reached for today — try again tomorrow.'
          : 'AI analysis unavailable right now.',
      };
    }
    return { text: body.text, aiScore: body.aiScore };
  } catch {
    return { error: 'AI analysis unavailable right now.' };
  }
}

function aiAskButtonHTML(id, label = '🤖 Ask AI') {
  return `<button id="${id}-btn" type="button" class="tool-input" style="margin-top:10px;cursor:pointer;">${label}</button><div id="${id}-output" style="margin-top:8px;"></div>`;
}

// `getRecapLine`, when given, restates the already-known score/pick (which
// we computed ourselves, so it's always accurate) right next to the AI's
// short take — no need to scroll back up to see both together.
function wireAiAskButton(id, kind, getPayload, getRecapLine) {
  const btn = document.getElementById(`${id}-btn`);
  if (!btn) return;
  const out = document.getElementById(`${id}-output`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Asking Gemini…';
    out.innerHTML = '';
    const result = await requestAiAnalysis(kind, getPayload());
    const recap = !result.error && getRecapLine ? `<p class="block-desc"><strong>${getRecapLine()}</strong></p>` : '';
    // aiScore only comes back for kind='squad' — a genuinely independent
    // second opinion that can differ from the rule-based rating above,
    // since it's allowed to factor in things the formula can't see
    // (injury/transfer context, preseason form). Labeled distinctly so it's
    // never mistaken for the same number.
    const aiScoreLine = !result.error && typeof result.aiScore === 'number'
      ? `<p class="block-desc"><strong style="color:#ffcc00">🤖 AI's independent score: ${result.aiScore}/100</strong></p>`
      : '';
    out.innerHTML = `${recap}${aiScoreLine}<p class="block-desc">${result.error || result.text}</p>`;
    btn.disabled = false;
    btn.textContent = original;
  });
}

// ---------- Compare Players tool ----------

function playerCompareScore(p, horizon) {
  const diff = avgDifficulty(p.teamId, horizon);
  const fixtureEase = diff == null ? 3 : 6 - diff; // 1..5, higher = easier
  const value = p.totalPoints / Math.max(parseFloat(p.price), 4);
  // epNext (FPL's own forward-looking projection) weighted heaviest — catches
  // squad-role changes (transfers, new signings, depth-chart shifts) that pure
  // last-season stats can't see.
  return p.epNext * 2.5 + p.form * 0.25 + p.pointsPerGame * 0.15 + p.xGI * 3 * 0.15 + fixtureEase * 0.12 + value * 0.08;
}

// Highlights the best (green) and worst (pink) value in a comparison row at
// a glance — same read fplcore's own side-by-side layout gives — rather
// than making the reader eyeball raw numbers across columns themselves.
// `invert`: true for metrics where LOWER is actually better (e.g. fixture
// difficulty), so that value gets the "best" highlight instead of the max.
function metricRowHTML(label, items, valueFn, formatFn = (v) => v, invert = false) {
  const values = items.map(valueFn);
  const numeric = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const max = numeric.length > 1 ? Math.max(...numeric) : null;
  const min = numeric.length > 1 ? Math.min(...numeric) : null;
  const bestVal = invert ? min : max;
  const worstVal = invert ? max : min;
  const cellClass = (v) => (bestVal != null && v === bestVal && bestVal !== worstVal ? 'cmp-best' : worstVal != null && v === worstVal && bestVal !== worstVal ? 'cmp-worst' : '');
  return `<tr><td>${label}</td>${values.map((v) => `<td class="${cellClass(v)}">${formatFn(v)}</td>`).join('')}</tr>`;
}

function compareCardsRowHTML(cardsHTML) {
  return `<div class="compare-cards-row">${cardsHTML.join('')}</div>`;
}

function playerCompareCardHTML(p, horizon) {
  return `
    <div class="compare-card" data-player-id="${p.id}">
      ${photoImg(p, 'compare-card-photo')}
      <div class="compare-card-name">${p.name}</div>
      <div class="compare-card-meta">${p.position} · ${p.team}</div>
      <div class="compare-card-pills">
        <span class="formation-tag" style="background:var(--purple-light);">£${p.price}m</span>
        <span class="formation-tag" style="background:var(--purple-light);">${p.ownership.toFixed(1)}%</span>
      </div>
      <div class="fixture-cell compare-card-fixtures">${fixtureChipsHTML(p.teamId, horizon)}</div>
    </div>
  `;
}

function teamCompareCardHTML(t, horizon) {
  return `
    <div class="compare-card">
      <img class="compare-card-photo badge-photo" src="${t.badge}" />
      <div class="compare-card-name">${t.shortName}</div>
      <div class="compare-card-meta">${t.name}</div>
      <div class="fixture-cell compare-card-fixtures">${fixtureChipsHTML(t.id, horizon)}</div>
    </div>
  `;
}

function renderPlayerCompare() {
  const tray = toolState.players;
  const trayEl = document.getElementById('player-tray');
  trayEl.innerHTML = tray.length
    ? tray.map((p) => `<span class="tray-chip">${p.name} <button data-remove="${p.id}">&times;</button></span>`).join('')
    : '<span class="block-desc">No players added yet.</span>';

  const output = document.getElementById('player-compare-output');
  if (!tray.length) {
    output.innerHTML = '';
    return;
  }
  const horizon = toolState.playerHorizon;
  const metrics = [
    ['Expected pts (next GW)', (p) => p.epNext, (v) => v.toFixed(1)],
    ['Form', (p) => p.form, (v) => v.toFixed(1)],
    ['Points/Game', (p) => p.pointsPerGame, (v) => v.toFixed(1)],
    ['Total Points', (p) => p.totalPoints, (v) => v],
    ['Goals', (p) => p.goals, (v) => v],
    ['Assists', (p) => p.assists, (v) => v],
    ['xG', (p) => p.xG, (v) => v.toFixed(2)],
    ['xA', (p) => p.xA, (v) => v.toFixed(2)],
    ['xGI', (p) => p.xGI, (v) => v.toFixed(2)],
    ['ICT Index', (p) => p.ictIndex, (v) => v.toFixed(1)],
    ['Threat', (p) => p.threat, (v) => v.toFixed(0)],
    ['Creativity', (p) => p.creativity, (v) => v.toFixed(0)],
    ['Influence', (p) => p.influence, (v) => v.toFixed(0)],
    ['Def. Contribution', (p) => p.defensiveContribution ?? 0, (v) => v],
    ['Minutes', (p) => p.minutes, (v) => v],
  ];

  const scored = tray.map((p) => ({ p, s: playerCompareScore(p, horizon) })).sort((a, b) => b.s - a.s);
  const pick = scored[0];

  output.innerHTML = `
    <div class="compare-pick">
      <strong>Recommended pick: ${pick.p.name}</strong> — best blend of form (${pick.p.form.toFixed(1)}), fixtures, and underlying stats over the next ${horizon} GWs.
    </div>
    ${compareCardsRowHTML(tray.map((p) => playerCompareCardHTML(p, horizon)))}
    <div class="table-scroll">
      <table class="compare-table">
        <tbody>
          ${metrics.map(([label, valueFn, formatFn]) => metricRowHTML(label, tray, valueFn, formatFn)).join('')}
          <tr><td>Next ${horizon} fixtures</td>${tray.map((p) => `<td class="fixture-cell">${fixtureChipsHTML(p.teamId, horizon)}</td>`).join('')}</tr>
        </tbody>
      </table>
    </div>
    ${aiAskButtonHTML('player-compare-ai')}
  `;

  wireAiAskButton('player-compare-ai', 'players', () => ({
    players: tray.map((p) => ({
      name: p.name, team: p.team, price: p.price, epNext: p.epNext, form: p.form,
      pointsPerGame: p.pointsPerGame, totalPoints: p.totalPoints, ownership: p.ownership,
      xG: p.xG, xA: p.xA, xGI: p.xGI, ictIndex: p.ictIndex,
    })),
    horizon,
    ruleBasedPick: pick.p.name,
  }), () => `Rule-based pick: ${pick.p.name}`);
}

// ---------- Compare Teams tool ----------

function teamAggregate(teamId) {
  const squad = STATE.data.allPlayers.filter((p) => p.teamId === teamId);
  const topScorer = squad.slice().sort((a, b) => b.goals - a.goals)[0];
  return {
    totalGoals: squad.reduce((s, p) => s + p.goals, 0),
    totalCleanSheets: Math.max(...squad.map((p) => p.cleanSheets), 0),
    topScorer,
  };
}

function renderTeamCompare() {
  const tray = toolState.teams;
  const trayEl = document.getElementById('team-tray');
  trayEl.innerHTML = tray.length
    ? tray.map((t) => `<span class="tray-chip">${t.shortName} <button data-remove="${t.id}">&times;</button></span>`).join('')
    : '<span class="block-desc">No teams added yet.</span>';

  const output = document.getElementById('team-compare-output');
  if (!tray.length) {
    output.innerHTML = '';
    return;
  }
  const horizon = toolState.teamHorizon;

  const rows = tray.map((t) => {
    const agg = teamAggregate(t.id);
    const diff = avgDifficulty(t.id, horizon);
    return { t, agg, diff };
  });
  const best = rows.slice().sort((a, b) => (a.diff ?? 5) - (b.diff ?? 5))[0];

  output.innerHTML = `
    <div class="compare-pick">
      <strong>Kindest run: ${best.t.shortName}</strong> — average fixture difficulty ${best.diff != null ? best.diff.toFixed(2) : 'n/a'} over the next ${horizon} GWs.
    </div>
    ${compareCardsRowHTML(tray.map((t) => teamCompareCardHTML(t, horizon)))}
    <div class="table-scroll">
      <table class="compare-table">
        <tbody>
          ${metricRowHTML('Attack (Home)', tray, (t) => t.strengthAttackHome, (v) => v)}
          ${metricRowHTML('Attack (Away)', tray, (t) => t.strengthAttackAway, (v) => v)}
          ${metricRowHTML('Defence (Home)', tray, (t) => t.strengthDefenceHome, (v) => v)}
          ${metricRowHTML('Defence (Away)', tray, (t) => t.strengthDefenceAway, (v) => v)}
          ${metricRowHTML('Avg fixture difficulty', rows, (r) => r.diff, (v) => (v != null ? v.toFixed(2) : 'n/a'), true)}
          ${metricRowHTML('Squad goals (season)', rows, (r) => r.agg.totalGoals, (v) => v)}
          ${metricRowHTML('Best clean sheet run', rows, (r) => r.agg.totalCleanSheets, (v) => v)}
          <tr><td>Top scorer</td>${rows.map((r) => `<td>${r.agg.topScorer ? r.agg.topScorer.name + ' (' + r.agg.topScorer.goals + ')' : '-'}</td>`).join('')}</tr>
          <tr><td>Next ${horizon} fixtures</td>${tray.map((t) => `<td class="fixture-cell">${fixtureChipsHTML(t.id, horizon)}</td>`).join('')}</tr>
        </tbody>
      </table>
    </div>
    ${aiAskButtonHTML('team-compare-ai')}
  `;

  wireAiAskButton('team-compare-ai', 'teams', () => ({
    teams: rows.map((r) => ({
      name: r.t.shortName,
      avgDifficulty: r.diff,
      totalGoals: r.agg.totalGoals,
      bestCleanSheetRun: r.agg.totalCleanSheets,
      topScorer: r.agg.topScorer ? `${r.agg.topScorer.name} (${r.agg.topScorer.goals})` : null,
    })),
    horizon,
    ruleBasedPick: best.t.shortName,
  }), () => `Rule-based pick: ${best.t.shortName}`);
}

// ---------- Rate My Squad tool ----------

function scaleClamp(v, max) {
  return Math.max(0, Math.min(10, (v / max) * 10));
}

// Per-player current-season match log, fetched on demand (only for players
// actually in the tray, up to 11) via our own proxy — FPL's API has no CORS
// headers so the browser can't hit it directly. Caches for the page's
// lifetime; a stale 30min edge cache sits in front of it too (see
// functions/player-history.js).
const playerHistoryCache = {};

function ensurePlayerHistory(id, onLoaded) {
  if (playerHistoryCache[id] !== undefined) return;
  playerHistoryCache[id] = 'loading';
  fetch(`/player-history?id=${id}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      playerHistoryCache[id] = data && !data.error ? data : { history: [] };
    })
    .catch(() => {
      playerHistoryCache[id] = { history: [] };
    })
    .finally(onLoaded);
}

// Average points a player has actually scored in past meetings against their
// specific next opponent, this season. Returns null (no signal) until real
// matches vs that exact opponent exist — universally true pre-season, and
// still true for most fixtures early on since teams only meet once or twice
// a season. That's intentional: this factor phases itself in as real
// head-to-head results accumulate, rather than guessing before they exist.
function vsOpponentHistory(id, opponentTeamId) {
  const entry = playerHistoryCache[id];
  if (!entry || entry === 'loading' || !opponentTeamId) return null;
  const matches = (entry.history || []).filter((h) => h.opponent_team === opponentTeamId);
  if (!matches.length) return null;
  return { avg: matches.reduce((s, m) => s + m.total_points, 0) / matches.length, n: matches.length };
}

function renderRateSquad() {
  const tray = toolState.rate;
  const trayEl = document.getElementById('rate-tray');
  trayEl.innerHTML = tray.length
    ? tray.map((p) => `<span class="tray-chip">${p.name} <button data-remove="${p.id}">&times;</button></span>`).join('')
    : '<span class="block-desc">No picks added yet.</span>';

  const output = document.getElementById('rate-output');
  if (tray.length < 1) {
    output.innerHTML = '';
    return;
  }
  const horizon = toolState.rateHorizon;

  const posCount = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of tray) posCount[p.position]++;
  const validFormation = tray.length === 11 && posCount.GKP === 1 &&
    posCount.DEF >= 3 && posCount.DEF <= 5 && posCount.MID >= 2 && posCount.MID <= 5 &&
    posCount.FWD >= 1 && posCount.FWD <= 3;

  const gwId = STATE.data?.gameweekId || 1;
  const seasonProgress = Math.max(0, Math.min(1, (gwId - 1) / 14));

  const avgEpNext = tray.reduce((s, p) => s + p.epNext, 0) / tray.length;
  const avgForm = tray.reduce((s, p) => s + p.form, 0) / tray.length;
  const avgFixtureEase = tray.reduce((s, p) => {
    const d = avgDifficulty(p.teamId, horizon);
    return s + (d == null ? 3 : 6 - d);
  }, 0) / tray.length;
  const totalPrice = tray.reduce((s, p) => s + parseFloat(p.price), 0);
  const uniqueTeams = new Set(tray.map((p) => p.teamId)).size;

  // "Value" blends two different pts-per-£m signals rather than picking one:
  // totalPoints/price is LAST season's cumulative total divided by TODAY's
  // price pre-season (FPL doesn't reset it until GW1 actually kicks off), so
  // on its own it saturates near the top for almost any proven player
  // regardless of squad — Haaland, João Pedro, Shaw all land at 15-29 against
  // an old max=15 ceiling, flattening every squad to the same 10/10. Blending
  // in ep_next/price (this season's forward-looking projection, always
  // meaningful) fixes that, and the blend itself shifts with season
  // progress — same principle as the weights below.
  const avgEpValue = tray.reduce((s, p) => s + p.epNext / Math.max(parseFloat(p.price), 4), 0) / tray.length;
  const avgPtsValue = tray.reduce((s, p) => s + p.totalPoints / Math.max(parseFloat(p.price), 4), 0) / tray.length;
  const epValueScore = scaleClamp(avgEpValue, 0.5);
  const ptsValueScore = scaleClamp(avgPtsValue, 15);
  const valueScore = epValueScore * (1 - seasonProgress) + ptsValueScore * seasonProgress;

  // Verified against real live data (GW1, 2026/27): the single highest
  // epNext in the entire ~600-player pool is 4.0, and even a THEORETICAL
  // best-possible XI (picking the single top epNext player at every
  // position, ignoring budget entirely) only averages ~3.35 across all 11
  // spots — GKP/DEF naturally run lower than MID/FWD, pulling any real XI's
  // average well below any one star's number. A fixed late-season ceiling
  // of 6 (only reachable once double-gameweeks/hot streaks exist) structurally
  // capped even a genuinely optimal early-season XI in the 50s, since
  // nothing on earth could reach it yet. Blends the same way the weights
  // below already do: a realistic-for-right-now early ceiling (tuned so a
  // real, well-built early-season XI lands in the 80s, not the 50s, while a
  // deliberately weak squad still clearly separates in the 40s — verified
  // against both), rising to a realistic established-season ceiling that
  // allows for real DGW spikes later.
  const expectedCeiling = 3.0 + (6.5 - 3.0) * seasonProgress;
  const expectedScore = scaleClamp(avgEpNext, expectedCeiling);
  // FPL's own `form` field is genuinely 0 for the ENTIRE player pool before
  // any match has been played this season (verified: all ~600 players read
  // form=0 pre-GW1) — scoring every possible squad 0/10 here isn't a real
  // quality signal, it's "no data exists yet" for literally everyone.
  // Treated as unavailable and its weight redistributed, the exact same
  // pattern already used below for matchupScore.
  const formScore = avgForm > 0 ? scaleClamp(avgForm, 8) : null;
  const fixtureScore = scaleClamp(avgFixtureEase, 5);
  const balanceScore = scaleClamp(uniqueTeams, tray.length || 1);

  // Head-to-head history vs each player's specific next opponent. Kicks off
  // a background fetch per tray player (cached after the first load) and
  // re-renders once it lands — cheap no-op if the tray has already changed.
  const teamIdByShortName = Object.fromEntries((STATE.data.allTeams || []).map((t) => [t.shortName, t.id]));
  const matchups = tray.map((p) => {
    ensurePlayerHistory(p.id, () => renderRateSquad());
    const nextFx = fixturesAhead(p.teamId, 1)[0];
    const opponentTeamId = nextFx ? teamIdByShortName[nextFx.opponent] : null;
    return vsOpponentHistory(p.id, opponentTeamId);
  }).filter(Boolean);
  const matchupScore = matchups.length
    ? scaleClamp(matchups.reduce((s, m) => s + m.avg, 0) / matchups.length, 8)
    : null;
  const matchupMeetings = matchups.reduce((s, m) => s + m.n, 0);

  // Weights shift as the season plays out. Gameweek 1-4, "form" is 1-2 games
  // of noise and nobody has a track record yet, so FPL's own forward-looking
  // ep_next projection and fixture run carry the rating. By ~GW15, actual
  // season form and value have enough sample size to be trusted more than a
  // pre-season projection, so they take over as the dominant factors.
  // Matchup history gets its own weight slot but only actually counts once
  // real head-to-head data exists — until then its weight is redistributed
  // proportionally across the other factors so a missing factor never just
  // deflates the score.
  const early = { expected: 0.35, form: 0.10, fixture: 0.20, value: 0.10, balance: 0.15, matchup: 0.10 };
  const established = { expected: 0.10, form: 0.25, fixture: 0.10, value: 0.20, balance: 0.15, matchup: 0.20 };
  const w = Object.fromEntries(
    Object.keys(early).map((k) => [k, early[k] + (established[k] - early[k]) * seasonProgress])
  );
  // Redistribute any factor that's genuinely unavailable right now (no real
  // signal yet, not a bad score) proportionally across whatever's left —
  // sequential so each removal re-normalizes what remains to sum back to 1.
  for (const [key, val] of [['matchup', matchupScore], ['form', formScore]]) {
    if (val == null) {
      const remaining = 1 - w[key];
      delete w[key];
      for (const k of Object.keys(w)) w[k] = w[k] / remaining;
    }
  }

  const rating = Math.round((
    expectedScore * w.expected + (formScore != null ? formScore * w.form : 0) + fixtureScore * w.fixture +
    valueScore * w.value + balanceScore * w.balance +
    (matchupScore != null ? matchupScore * w.matchup : 0)
  ) * 10);

  const matchupRow = matchupScore != null
    ? `<tr><td>Matchup history (weight ${(w.matchup * 100).toFixed(0)}%, ${matchupMeetings} past meeting${matchupMeetings === 1 ? '' : 's'})</td><td>${matchupScore.toFixed(1)}/10</td></tr>`
    : `<tr><td>Matchup history</td><td>No head-to-head data yet this season</td></tr>`;
  const formRow = formScore != null
    ? `<tr><td>Form (weight ${(w.form * 100).toFixed(0)}%)</td><td>${formScore.toFixed(1)}/10</td></tr>`
    : `<tr><td>Form</td><td>No real gameweek data yet this season</td></tr>`;

  output.innerHTML = `
    ${!validFormation ? `<div class="rule-note" style="color:var(--pink)">${tray.length !== 11 ? `Add ${11 - tray.length > 0 ? (11 - tray.length) + ' more to reach 11' : (tray.length - 11) + ' fewer to reach 11'}.` : 'Formation looks off (need 1 GKP, 3-5 DEF, 2-5 MID, 1-3 FWD) — rating still shown below.'}</div>` : ''}
    <div class="compare-pick">
      <strong>First 11 Rating: ${rating}/100</strong>
    </div>
    <table class="compare-table rating-table">
      <tbody>
        <tr><td>Expected points (weight ${(w.expected * 100).toFixed(0)}%)</td><td>${expectedScore.toFixed(1)}/10</td></tr>
        ${formRow}
        <tr><td>Fixture ease (next ${horizon}, weight ${(w.fixture * 100).toFixed(0)}%)</td><td>${fixtureScore.toFixed(1)}/10</td></tr>
        <tr><td>Value (pts per £m, weight ${(w.value * 100).toFixed(0)}%)</td><td>${valueScore.toFixed(1)}/10</td></tr>
        <tr><td>Team variety (weight ${(w.balance * 100).toFixed(0)}%)</td><td>${balanceScore.toFixed(1)}/10</td></tr>
        ${matchupRow}
        <tr><td>Total price</td><td>£${totalPrice.toFixed(1)}m</td></tr>
      </tbody>
    </table>
    <p class="block-desc" style="margin-top:8px;">GW${gwId}: weights shift from projection-led (early season) to form-led (established season) as real results build up — see % next to each factor above. Value itself blends the same way: projected pts/£m pre-season, actual pts/£m once this season's results exist.</p>
    ${aiAskButtonHTML('rate-squad-ai', '🤖 Ask AI to review this XI')}
  `;

  wireAiAskButton('rate-squad-ai', 'squad', () => {
    const newSigningIds = new Set((STATE.data.newSignings || []).map((p) => p.id));
    return {
      rating,
      subscores: {
        expected: expectedScore, form: formScore, fixture: fixtureScore,
        value: valueScore, balance: balanceScore, matchup: matchupScore,
      },
      players: tray.map((p) => ({
        name: p.name, team: p.team, position: p.position, price: p.price,
        epNext: p.epNext, form: p.form, totalPoints: p.totalPoints, ownership: p.ownership,
        minutesLastSeason: p.minutes,
        status: p.status === 'a' ? 'available' : p.status === 'd' ? 'doubtful' : p.status === 'i' ? 'injured' : p.status === 's' ? 'suspended' : p.status,
        news: p.news || null,
        chanceOfPlaying: p.chanceOfPlaying ?? null,
        recentTransfer: newSigningIds.has(p.id),
      })),
      horizon,
    };
  }, () => `First 11 Rating: ${rating}/100`);
}

// ---------- Picker widgets (search + tray) ----------

const toolState = {
  players: [], playerHorizon: 5,
  teams: [], teamHorizon: 5,
  rate: [], rateHorizon: 5,
};

function setupPicker({ searchId, resultsId, filterFn, max, onAdd }) {
  const input = document.getElementById(searchId);
  const results = document.getElementById(resultsId);
  input.addEventListener('input', () => {
    const matches = filterFn(input.value.trim());
    results.innerHTML = matches
      .map((m) => `<div class="search-item" data-id="${m.id}">${m.label}</div>`)
      .join('');
  });
  results.addEventListener('click', (e) => {
    const item = e.target.closest('.search-item');
    if (!item) return;
    onAdd(item.dataset.id, max);
    input.value = '';
    results.innerHTML = '';
  });
}

function addUnique(list, item, max) {
  if (list.some((x) => x.id === item.id)) return list;
  if (list.length >= max) return list;
  return [...list, item];
}

function setupTraysAndTabs() {
  setupPicker({
    searchId: 'player-search', resultsId: 'player-search-results', max: 5,
    filterFn: (q) => !q ? [] : STATE.data.allPlayers
      .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 8)
      .map((p) => ({ id: p.id, label: `${p.name} (${p.team}, ${p.position})` })),
    onAdd: (id) => {
      const p = STATE.data.allPlayers.find((x) => x.id == id);
      toolState.players = addUnique(toolState.players, p, 5);
      renderPlayerCompare();
    },
  });
  document.getElementById('player-tray').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-remove]');
    if (!btn) return;
    toolState.players = toolState.players.filter((p) => p.id != btn.dataset.remove);
    renderPlayerCompare();
  });
  document.getElementById('player-horizon').addEventListener('input', (e) => {
    toolState.playerHorizon = Number(e.target.value);
    document.getElementById('player-horizon-val').textContent = e.target.value;
    renderPlayerCompare();
  });

  setupPicker({
    searchId: 'team-search', resultsId: 'team-search-results', max: 5,
    filterFn: (q) => !q ? [] : STATE.data.allTeams
      .filter((t) => t.name.toLowerCase().includes(q.toLowerCase()) || t.shortName.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 8)
      .map((t) => ({ id: t.id, label: t.name })),
    onAdd: (id) => {
      const t = STATE.data.allTeams.find((x) => x.id == id);
      toolState.teams = addUnique(toolState.teams, t, 5);
      renderTeamCompare();
    },
  });
  document.getElementById('team-tray').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-remove]');
    if (!btn) return;
    toolState.teams = toolState.teams.filter((t) => t.id != btn.dataset.remove);
    renderTeamCompare();
  });
  document.getElementById('team-horizon').addEventListener('input', (e) => {
    toolState.teamHorizon = Number(e.target.value);
    document.getElementById('team-horizon-val').textContent = e.target.value;
    renderTeamCompare();
  });

  setupPicker({
    searchId: 'rate-search', resultsId: 'rate-search-results', max: 11,
    filterFn: (q) => !q ? [] : STATE.data.allPlayers
      .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 8)
      .map((p) => ({ id: p.id, label: `${p.name} (${p.team}, ${p.position})` })),
    onAdd: (id) => {
      const p = STATE.data.allPlayers.find((x) => x.id == id);
      toolState.rate = addUnique(toolState.rate, p, 11);
      renderRateSquad();
    },
  });
  document.getElementById('rate-tray').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-remove]');
    if (!btn) return;
    toolState.rate = toolState.rate.filter((p) => p.id != btn.dataset.remove);
    renderRateSquad();
  });
  document.getElementById('rate-horizon').addEventListener('input', (e) => {
    toolState.rateHorizon = Number(e.target.value);
    document.getElementById('rate-horizon-val').textContent = e.target.value;
    renderRateSquad();
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ---------- Top-level render ----------

// Ticks down live, second by second, re-computed from the real deadline
// timestamp on every tick rather than a one-shot value frozen at page load
// or at the last cron refresh — so a tab left open overnight (or just sat on
// during the final hour before deadline) always shows a genuinely live
// countdown, not a number that's stale until the next daily refresh.
function updateDeadlineChip(deadlineIso, gwLabel) {
  const chip = document.getElementById('deadline-chip');
  if (!chip) return;
  if (!deadlineIso) {
    chip.style.display = 'none';
    return;
  }
  const msLeft = new Date(deadlineIso).getTime() - Date.now();
  const deadlineText = new Date(deadlineIso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  chip.style.display = 'inline-block';
  chip.classList.remove('deadline-soon', 'deadline-live');

  if (msLeft <= 0) {
    chip.classList.add('deadline-live');
    chip.textContent = `🔴 ${gwLabel} deadline has passed — gameweek underway`;
    return;
  }

  const totalSeconds = Math.floor(msLeft / 1000);
  const totalHours = Math.floor(totalSeconds / 3600);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  // Always includes minutes (even days out) so the chip visibly ticks over
  // every minute rather than sitting static on "9d 8h" for hours at a time —
  // seconds only get added once it's under an hour, the point where a
  // manager is actually watching it count down rather than just glancing.
  const shortLeft = days > 0
    ? `${days}d ${hours}h ${minutes}m`
    : hours > 0
      ? `${hours}h ${minutes}m`
      : `${minutes}m ${seconds}s`;
  if (totalHours <= 24) chip.classList.add('deadline-soon');
  chip.textContent = `⏰ ${gwLabel} deadline: ${deadlineText} · ${shortLeft} left (${totalHours}h total)`;
}

function render(data) {
  const app = document.getElementById('app');
  const subtitle = document.getElementById('subtitle');

  if (data.error) {
    app.innerHTML = `<p class="loading">Data isn't ready yet — the daily refresh function hasn't run. If you just deployed, run <code>netlify functions:invoke refresh-data</code> once.</p>`;
    subtitle.textContent = 'Waiting on first data refresh…';
    return;
  }

  const gwLabel = data.isPreseason ? 'Pre-season — Gameweek 1 is coming up' : `Gameweek ${data.gameweek?.replace('Gameweek ', '') ?? ''}`;
  if (isStale(data.updatedAt)) {
    subtitle.innerHTML = `${gwLabel} · <span style="color:var(--pink);font-weight:700;">⚠️ Data hasn't refreshed since ${fmtUpdated(data.updatedAt)} — the daily update may have failed, worth checking.</span>`;
  } else {
    subtitle.textContent = `${gwLabel} · last updated ${fmtUpdated(data.updatedAt)} · next refresh ~${nextRefreshTime()}`;
  }

  const shortGwLabel = data.gameweek || gwLabel;
  updateDeadlineChip(data.deadline, shortGwLabel);
  clearInterval(STATE.deadlineTimer);
  STATE.deadlineTimer = setInterval(() => updateDeadlineChip(data.deadline, shortGwLabel), 1000);

  const crestStrip = document.getElementById('crest-strip');
  if (crestStrip && data.allTeams) {
    crestStrip.innerHTML = data.allTeams
      .map((t) => `<img src="${t.badge}" alt="${t.shortName}" title="${t.name}" />`)
      .join('');
  }

  app.innerHTML = `
    <div class="page active-page" data-page="home">
      <div class="dashboard-grid">
        ${bestXIHTML(data)}
        ${aiRecommendationHTML(data)}
      </div>
    </div>
    <div class="page" data-page="teamnews">
      ${teamNewsPageHTML(data)}
    </div>
    <div class="page" data-page="differentials">
      <div class="dashboard-grid">
        ${differentialsHTML(data)}
      </div>
    </div>
    <div class="page" data-page="tools">
      <div class="dashboard-grid">
        ${toolsShellHTML()}
      </div>
    </div>
    <div class="page" data-page="fixtures">
      <div class="dashboard-grid">
        ${fixtureSwingsHTML(data)}
        ${setPieceTakersHTML(data)}
        ${seasonFixturesShellHTML()}
      </div>
    </div>
    <div class="page" data-page="watchlist">
      <div class="dashboard-grid">
        ${priceWatchHTML(data)}
        ${priceChangesHTML(data)}
        ${newSigningsHTML(data)}
        ${injuryWatchHTML(data)}
      </div>
    </div>
    <div class="page" data-page="league">
      <div class="dashboard-grid">
        ${h2hFixturesShellHTML()}
      </div>
    </div>
  `;

  setupGwSwitcher('bestxi-gw-select', 'bestxi-live-view', 'bestxi', data.gameweekId);
  setupGwSwitcher('differentials-gw-select', 'differentials-live-view', 'differentials', data.gameweekId);
  setupH2HFixtures();
  setupSeasonFixtures();
  setupTraysAndTabs();
  setupPlayerStatsTool();
  setupStatsPerGwTool();
}

// Nav is static markup (see index.html), wired once independent of render()
// (which only ever runs once per page load — see init()) — clicking a nav
// item just toggles which .page wrapper is visible via CSS, all pages'
// content already exists in the DOM either way, so no re-fetch or re-render
// is needed to switch pages.
function setupNav() {
  const toggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('side-nav');
  if (!nav) return;

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    const pageId = btn.dataset.page;

    nav.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el === btn));
    document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active-page', el.dataset.page === pageId));
    nav.classList.remove('open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  toggle?.addEventListener('click', () => nav.classList.toggle('open'));
}

// ---------- FPL AI chat widget ----------
// Minimized by default (the panel stays `hidden` until the toggle button is
// clicked) — never pops up on its own. Uses textContent (not innerHTML) for
// every rendered message since content here includes live LLM output, not
// just our own trusted strings.
// Suggests real player names while the user types in chat, the same
// substring match against STATE.data.allPlayers already used by the Compare
// Players / Rate My Squad pickers — this doubles as a fix for the chat
// needing an exact name match: clicking a suggestion guarantees the real
// spelling instead of the user guessing (e.g. "gibbs-white" vs "Gibbs-White").
// Unlike those pickers, chat is free-text, so this only replaces the current
// in-progress WORD at the cursor, not the whole input.
function setupChatAutocomplete(input, suggestBox) {
  const currentWordRange = () => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos);
    const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf(',')) + 1;
    return { start, end: pos, word: before.slice(start) };
  };

  const hide = () => { suggestBox.innerHTML = ''; };

  input.addEventListener('input', () => {
    const { word } = currentWordRange();
    if (word.trim().length < 2 || !STATE.data?.allPlayers) { hide(); return; }
    const q = word.toLowerCase();
    const matches = STATE.data.allPlayers.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
    if (!matches.length) { hide(); return; }
    suggestBox.innerHTML = matches
      .map((p) => `<div class="search-item" data-name="${p.name}">${p.name} (${p.team}, ${p.position})</div>`)
      .join('');
  });

  suggestBox.addEventListener('mousedown', (e) => {
    // mousedown (not click) so this fires before the input's blur
    const item = e.target.closest('.search-item');
    if (!item) return;
    e.preventDefault();
    const { start, end } = currentWordRange();
    const name = item.dataset.name;
    input.value = input.value.slice(0, start) + name + ' ' + input.value.slice(end);
    const cursor = start + name.length + 1;
    input.setSelectionRange(cursor, cursor);
    hide();
    input.focus();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
}

// ---------- Player stat modal (click a Best XI / Differentials card) ----------

// Cumulative box-score stats (totalPoints/goals/assists/cleanSheets/saves/
// ictIndex) come straight from FPL's own API, and pre-season FPL hasn't
// reset them yet — they're still LAST season's final tallies (confirmed via
// real data: a "pre-season" player showing 3420 minutes, a full season's
// worth). "form" is the one field FPL does reset immediately, which is why
// it already correctly shows 0 pre-season. Rather than hide or fake-zero
// real numbers, label them honestly as last season's until the real season
// resets them — at that point these same fields become genuinely
// current-season-only with no extra logic needed on our end.
function playerModalBodyHTML(p) {
  const seasonNote = STATE.data?.isPreseason ? ' (last season)' : '';
  const tile = (val, label) => `<div class="player-modal-stat"><div class="val">${val}</div><div class="lbl">${label}</div></div>`;

  // "How did they do last gameweek" while browsing the NEXT gameweek's
  // picks — e.g. viewing GW2's Best XI, this shows their real GW1 score.
  // Only shown once a gameweek has actually completed (nothing to show
  // pre-season), found from history rather than assumed from gameweekId-1
  // in case a gameweek was ever skipped/blank.
  const lastCompleted = (STATE.data?.history || [])
    .filter((e) => e.status === 'complete')
    .sort((a, b) => b.event - a.event)[0];
  const lastGwTile = lastCompleted ? tile(p.eventPoints ?? '-', `GW${lastCompleted.event} Pts`) : '';

  const positionTiles = p.position === 'GKP'
    ? [tile(p.cleanSheets ?? '-', `Clean Sheets${seasonNote}`), tile(p.saves ?? '-', `Saves${seasonNote}`)]
    : p.position === 'DEF'
      ? [
          tile(p.cleanSheets ?? '-', `Clean Sheets${seasonNote}`),
          tile(p.defensiveContribution ?? '-', `Def. Contribution${seasonNote}`),
          tile(p.goals ?? '-', `Goals${seasonNote}`),
          tile(p.assists ?? '-', `Assists${seasonNote}`),
        ]
      : [
          tile(p.assists ?? '-', `Assists${seasonNote}`),
          tile(p.goals ?? '-', `Goals${seasonNote}`),
          tile(p.ictIndex != null ? Number(p.ictIndex).toFixed(1) : '-', `ICT Index${seasonNote}`),
        ];

  return `
    <div class="player-modal-head">
      ${photoImg(p)}
      <div class="name">${p.name}</div>
      <div class="meta">${p.position} · ${p.team} · £${p.price}m</div>
      ${p.news ? `<div class="meta" style="color:var(--pink);margin-top:4px;">⚠️ ${p.news}</div>` : ''}
    </div>
    <div class="player-modal-stats">
      ${lastGwTile}
      ${tile(p.totalPoints ?? '-', `Total Pts${seasonNote}`)}
      ${tile(p.pointsPerGame != null ? Number(p.pointsPerGame).toFixed(1) : '-', `Pts/Game${seasonNote}`)}
      ${positionTiles.join('')}
      ${tile(p.form != null ? Number(p.form).toFixed(1) : '-', 'Form')}
    </div>
    <div class="player-modal-fixtures">
      <div style="font-size:0.68rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.03em;margin-bottom:6px;">Next 3 fixtures</div>
      <div class="fixture-cell" style="display:flex;flex-wrap:wrap;justify-content:center;gap:4px;">${fixtureChipsHTML(p.teamId, 3)}</div>
    </div>
  `;
}

// Single delegated click listener rather than one per card — cards get
// re-rendered constantly (gameweek switches, tool interactions), so binding
// per-card would mean re-wiring listeners on every render; delegation just
// works regardless of what's currently in the DOM.
function setupPlayerStatModal() {
  const backdrop = document.getElementById('player-modal-backdrop');
  const body = document.getElementById('player-modal-body');
  const closeBtn = document.getElementById('player-modal-close');
  if (!backdrop || !body || !closeBtn) return;

  const close = () => { backdrop.hidden = true; };

  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-player-id]');
    if (!card) return;
    const p = (STATE.data?.allPlayers || []).find((x) => String(x.id) === card.dataset.playerId);
    if (!p) return;
    body.innerHTML = playerModalBodyHTML(p);
    backdrop.hidden = false;
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

function setupChatWidget() {
  const toggle = document.getElementById('chat-toggle');
  const panel = document.getElementById('chat-panel');
  const closeBtn = document.getElementById('chat-close');
  const messagesEl = document.getElementById('chat-messages');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const suggestBox = document.getElementById('chat-suggest');
  if (!toggle || !panel || !form || !input) return;
  if (suggestBox) setupChatAutocomplete(input, suggestBox);

  const history = [];

  const addMessage = (text, cls) => {
    const div = document.createElement('div');
    div.className = `chat-msg ${cls}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  });
  closeBtn.addEventListener('click', () => {
    panel.hidden = true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    addMessage(message, 'chat-msg-user');
    input.value = '';
    if (suggestBox) suggestBox.innerHTML = '';
    const submitBtn = form.querySelector('button');
    input.disabled = true;
    submitBtn.disabled = true;

    try {
      const res = await fetch('/fpl-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, history }),
      });
      const body = await res.json();
      if (!res.ok || body.error) {
        const text = body.error === 'daily_cap_reached'
          ? 'Daily chat limit reached for today — try again tomorrow.'
          : 'Sorry, the assistant is unavailable right now.';
        addMessage(text, 'chat-msg-error');
      } else {
        addMessage(body.reply, 'chat-msg-bot');
        history.push({ role: 'user', content: message }, { role: 'assistant', content: body.reply });
      }
    } catch {
      addMessage('Sorry, the assistant is unavailable right now.', 'chat-msg-error');
    } finally {
      input.disabled = false;
      submitBtn.disabled = false;
      input.focus();
    }
  });
}

async function init() {
  const data = await fetch(DATA_URL).then((r) => r.json()).catch(() => ({ error: true }));

  STATE.data = data;

  try {
    render(data);
  } catch (err) {
    document.getElementById('app').innerHTML = `<p class="loading">Something went wrong rendering the page: ${err.message}</p>`;
  }
}

init();
setupChatWidget();
setupPlayerStatModal();
setupNav();
setupScrollHints();
