# Inferno FPL

A free, self-updating FPL dashboard for the Inferno league: Best XI (locked hard
~10 hours before each gameweek's first kick-off, tracked through to its actual
result), differentials with a week-by-week track record, fixture swings, set piece
takers, a full season fixture browser, injury watch, price watch, an AI
Recommendation tile, and an AI-written Team News tab. Data comes from the official
Fantasy Premier League API.

**Live site:** https://inferno-fpl.pages.dev

Hosted on **Cloudflare Pages** (static site + a small serverless function that
serves data) plus a separate **Cloudflare Worker** that runs every 3 hours on a
cron trigger to refresh that data — including resolving each gameweek's actual
result once FPL marks it finished. Everything runs under one free Cloudflare
account.

## Publishing updates

Any time you edit files in `public/` (the site itself) or `functions/get-data.js`,
redeploy with:
```bash
cd ~/fpl-dashboard
npx wrangler pages deploy public --project-name=inferno-fpl
```

If you change the analysis logic in `lib/insights.mjs` or `lib/history.mjs`, or
edit `cron-worker/refresh-data.js`, redeploy the worker instead:
```bash
cd ~/fpl-dashboard/cron-worker
npx wrangler deploy
```

The live FPL sections (Best XI, differentials, fixtures, injuries, prices, Team
News) need no manual work otherwise — the cron worker refreshes them every 3 hours
on its own (currently `0 */3 * * *` UTC, set in `cron-worker/wrangler.toml`). The
3-hourly cadence exists specifically so the lock threshold in `lib/history.mjs`
(~10h before each gameweek's first kick-off — see `LOCK_WINDOW_MS`) gets caught
close to the real moment, not up to a day late the way a single fixed daily run
could miss it. Once a gameweek locks, it's a hard freeze — no further changes, not
even for a late injury.

`public/friendlies.json` is a legacy, hand-edited pre-season-only input (real
friendly goals/assists, used only while `isPreseason` is true as a minor scoring
nudge in `lib/insights.mjs`) — it has no dedicated UI tab any more and is inert for
the rest of the season once Gameweek 1 starts.

## If you ever need to manually refresh the data right now

The cron worker only runs on its scheduled cadence and isn't reachable over the
public internet (`workers_dev = false`), so to force an immediate refresh, run
the same logic locally and push straight to the live KV store:

```bash
cd ~/fpl-dashboard
node --input-type=module -e "
import { computeInsights } from './lib/insights.mjs';
import { resolvePendingEntries, determineActiveGwId, ensurePendingEntry } from './lib/history.mjs';
import { writeFileSync } from 'fs';

const [bootstrapRes, fixturesRes] = await Promise.all([
  fetch('https://fantasy.premierleague.com/api/bootstrap-static/'),
  fetch('https://fantasy.premierleague.com/api/fixtures/?future=1'),
]);
const bootstrap = await bootstrapRes.json();
const fixtures = await fixturesRes.json();

let history = await resolvePendingEntries([], bootstrap); // pass the previous history in if you have it saved
const activeGwId = determineActiveGwId(history, bootstrap);
const insights = computeInsights(bootstrap, fixtures, activeGwId);
history = ensurePendingEntry(history, activeGwId, insights.bestXI, insights.differentials);

writeFileSync('/tmp/kv-data.json', JSON.stringify({ ...insights, history, updatedAt: new Date().toISOString() }));
"
npx wrangler kv key put --namespace-id=5f69f4ededf24cb89c07ee611c9d5fb4 "latest" --path=/tmp/kv-data.json --remote
```

Note this overwrites `history` from scratch (starts as if no gameweek has been
tracked yet) unless you first read back the current live value with
`npx wrangler kv key get --namespace-id=5f69f4ededf24cb89c07ee611c9d5fb4 "latest" --remote`
and pass its `history` array in instead of `[]`.

## Project structure

```
public/                    the site (HTML/CSS/JS + friendlies.json)
functions/get-data.js       Cloudflare Pages Function — serves the latest KV data to the page
lib/
  insights.mjs              all the analysis logic (Best XI, differentials, fixtures, etc.)
  history.mjs               gameweek pick-tracking (snapshots picks, resolves actual results)
cron-worker/
  refresh-data.js           the scheduled job (every 3h) — fetches FPL API, computes insights, stores them
  wrangler.toml             worker config (cron schedule, KV binding)
wrangler.toml               Pages project config (KV binding)
```
