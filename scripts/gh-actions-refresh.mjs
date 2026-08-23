// Entry point for the GitHub Actions scheduled workflow (see
// .github/workflows/refresh.yml) — runs the EXACT SAME runRefresh() used by
// the Cloudflare cron worker (cron-worker/refresh-data.js), unchanged, just
// swapping the KV binding for a REST-backed equivalent (see
// lib/kvRestClient.mjs) since GitHub Actions runs outside Cloudflare's
// infrastructure and has no Workers KV binding to use directly.
//
// Why this exists: Cloudflare's Free Workers plan has a real, unconfigurable
// CPU-time ceiling per invocation (confirmed directly - a [limits] cpu_ms
// block in wrangler.toml was rejected outright: "CPU limits are not
// supported for the Free plan"), and this dashboard's refresh pipeline has
// repeatedly exceeded it despite real optimization work (see git log for
// the localeCompare fix, skipXIComputation, fixture/player-stats caching,
// payload compaction). GitHub Actions has no equivalent per-run CPU ceiling
// for a job like this, so running the SAME heavy computation there instead
// sidesteps the constraint entirely rather than continuing to fight it.
import { runRefresh } from '../lib/refresh.mjs';
import { createKvRestClient } from '../lib/kvRestClient.mjs';

const required = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_KV_NAMESPACE_ID', 'CLOUDFLARE_API_TOKEN'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing required environment variable(s):', missing.join(', '));
  process.exit(1);
}

const env = {
  FPL_KV: createKvRestClient({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  }),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  FOOTBALLDATA_API_KEY: process.env.FOOTBALLDATA_API_KEY,
};

const ok = await runRefresh(env);
if (!ok) {
  console.error('runRefresh returned false (handled failure, e.g. FPL API was down)');
  process.exit(1);
}
console.log('Refresh completed successfully.');
