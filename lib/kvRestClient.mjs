// A drop-in stand-in for Cloudflare Workers' `env.FPL_KV` binding
// ({ get(key), put(key, value) }), backed by Cloudflare's public REST API
// instead of the binding — this is what lets runRefresh() (lib/refresh.mjs)
// run completely unchanged from a GitHub Actions job (see
// scripts/gh-actions-refresh.mjs) instead of only from inside a Cloudflare
// Worker. GitHub Actions has no CPU-time ceiling like a Free-plan
// scheduled Worker does, so moving the heavy computation here sidesteps
// the CPU-limit problem at its root rather than continuing to fight it in
// application code.
//
// Only implements what runRefresh's own call chain actually uses (plain
// get/put, no TTL/metadata) — see the grep that confirmed this before
// writing it. If a future caller needs expirationTtl, extend put() then,
// don't guess at the shape now.
const API_BASE = 'https://api.cloudflare.com/client/v4';

export function createKvRestClient({ accountId, namespaceId, apiToken }) {
  if (!accountId || !namespaceId || !apiToken) {
    throw new Error('createKvRestClient requires accountId, namespaceId, and apiToken');
  }
  const base = `${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
  const headers = { Authorization: `Bearer ${apiToken}` };

  return {
    async get(key) {
      const res = await fetch(`${base}/${encodeURIComponent(key)}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`KV REST get('${key}') failed: ${res.status} ${await res.text().catch(() => '')}`);
      }
      return res.text();
    },
    async put(key, value) {
      const res = await fetch(`${base}/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'text/plain' },
        body: value,
      });
      if (!res.ok) {
        throw new Error(`KV REST put('${key}') failed: ${res.status} ${await res.text().catch(() => '')}`);
      }
    },
  };
}
