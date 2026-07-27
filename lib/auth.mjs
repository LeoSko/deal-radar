// Load + save Wolt auth state.
//
// wolt_auth.json shape:
// {
//   "access_token":             "<JWT>",          // for Authorization: Bearer
//   "access_token_expires_at":  1779194088000,    // ms epoch
//   "refresh_token":            "DFHg...",        // used to renew via Wolt's wauth2
//   "endpoints": { me, addresses, promotions, venue_static, assortment, refresh },
//   "work_address": { "alias": "Office", "lat": ..., "lon": ... }
// }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./config.mjs";

export const AUTH_PATH = configPath("wolt_auth.json");

const REFRESH_LEEWAY_MS = 60_000; // refresh 1 minute before stated expiry

export async function loadAuth() {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(
      `Missing auth file: ${AUTH_PATH}\n` +
        "Capture tokens with: node bin/import-tokens.mjs '<paste>'",
    );
  }
  const raw = await readFile(AUTH_PATH, "utf8");
  return JSON.parse(raw);
}

export async function saveAuth(auth) {
  await mkdir(dirname(AUTH_PATH), { recursive: true });
  await writeFile(AUTH_PATH, JSON.stringify(auth, null, 2) + "\n");
}

function tokenStillValid(auth) {
  return (
    auth.access_token &&
    typeof auth.access_token_expires_at === "number" &&
    auth.access_token_expires_at - Date.now() > REFRESH_LEEWAY_MS
  );
}

// Decode JWT exp claim (in seconds → ms) — fallback when expires_at not stored.
function jwtExpMs(token) {
  try {
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {}
  return null;
}

// Exchange refresh_token for a fresh access_token. Mutates `auth` in place
// and persists it. Throws WoltAuthError on failure (caller should prompt
// for fresh tokens).
export class WoltAuthError extends Error {
  constructor(msg, { status, body } = {}) {
    super(msg);
    this.name = "WoltAuthError";
    this.status = status;
    this.body = body;
  }
}

async function callRefresh(auth) {
  if (!auth.refresh_token) {
    throw new WoltAuthError("No refresh_token in wolt_auth.json — re-import tokens.");
  }
  const url = auth.endpoints?.refresh || "https://authentication.wolt.com/v1/wauth2/access_token";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
  }).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new WoltAuthError(
      `Refresh failed (${res.status}). Wolt session likely expired — re-import tokens via ` +
        `bin/import-tokens.mjs`,
      { status: res.status, body: text.slice(0, 200) },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new WoltAuthError(`Refresh returned non-JSON: ${text.slice(0, 100)}`);
  }
  if (!parsed.access_token) {
    throw new WoltAuthError("Refresh response missing access_token");
  }
  auth.access_token = parsed.access_token;
  // Prefer JWT exp (more accurate), else use expires_in.
  const fromJwt = jwtExpMs(parsed.access_token);
  if (fromJwt) {
    auth.access_token_expires_at = fromJwt;
  } else if (typeof parsed.expires_in === "number") {
    auth.access_token_expires_at = Date.now() + parsed.expires_in * 1000;
  } else {
    auth.access_token_expires_at = Date.now() + 25 * 60 * 1000; // safe default
  }
  if (parsed.refresh_token) auth.refresh_token = parsed.refresh_token;
  await saveAuth(auth);
  return auth;
}

// Returns the access_token to use, refreshing if necessary.
export async function ensureAccessToken(auth) {
  if (tokenStillValid(auth)) return auth.access_token;
  await callRefresh(auth);
  return auth.access_token;
}

export function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "app-language": "en",
    "client-version": "1.16.107",
    "clientversionnumber": "1.16.107",
    platform: "Web",
  };
}
