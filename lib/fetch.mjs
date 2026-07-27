// Wolt fetch wrapper. Reads endpoint by name from auth.json, ensures a fresh
// access token (auto-refreshes via __wrtoken if expired), substitutes
// {placeholders} in the URL, and returns parsed JSON.

import { ensureAccessToken, authHeaders, loadAuth, WoltAuthError } from "./auth.mjs";

export function fillTemplate(str, params) {
  if (!str) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in params)) throw new Error(`Missing template param: ${k}`);
    return encodeURIComponent(String(params[k]));
  });
}

export async function woltFetch(endpointName, params = {}, opts = {}) {
  const auth = opts.auth || (await loadAuth());
  const tmpl = auth.endpoints?.[endpointName];
  const url = opts.url || fillTemplate(tmpl, params);
  if (!url) throw new Error(`No endpoint "${endpointName}" in auth.json`);
  const token = await ensureAccessToken(auth);
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: authHeaders(token),
    body: opts.body,
  });
  const text = await res.text();
  if (res.status === 401) {
    // Force one refresh + retry. ensureAccessToken won't refresh again if it
    // just renewed, so blow away expiration to force renewal.
    auth.access_token_expires_at = 0;
    const fresh = await ensureAccessToken(auth);
    const res2 = await fetch(url, {
      method: opts.method || "GET",
      headers: authHeaders(fresh),
      body: opts.body,
    });
    const text2 = await res2.text();
    if (!res2.ok) {
      throw new WoltAuthError(
        `Wolt ${endpointName} → ${res2.status} after retry. Body: ${text2.slice(0, 200)}`,
        { status: res2.status, body: text2 },
      );
    }
    return JSON.parse(text2);
  }
  if (!res.ok) {
    throw new Error(`Wolt ${endpointName} ${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
