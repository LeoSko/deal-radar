#!/usr/bin/env node
// Bolt Food (food.bolt.eu) deal scanner — sibling of deals.mjs (Wolt). Emits the
// SAME unified deal shape + NDJSON stream events so serve.mjs can merge both
// providers. v1 is VENUE-LEVEL: Bolt's Home screen tags each venue with a
// discount label ("−35%", "Up to 20% off") plus rating / image / ETA. Per-item
// Bolt discounts need the auth-gated venue-menu endpoint (not yet captured).
//
//   node bolt.mjs                  # ranked table
//   node bolt.mjs --json           # unified deal objects
//   node bolt.mjs --stream         # NDJSON: start / deal / progress / done
//   node bolt.mjs --min-discount 20
//   node bolt.mjs --set-refresh eyJ...   # store a new ~yearly refresh token (rare: on expiry/logout)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { configPath } from "../lib/config.mjs";

const AUTH_PATH = configPath("bolt_auth.json");

// ── Bolt Food API topology (non-secret, stable) — embedded so setup needs ONLY a
// refresh token. deviceId/session_id are generated on first run; coords + city_id
// are derived live from the account's saved delivery address (getDeliveryLocation).
const BASE = "https://deliveryuser.live.boltsvc.net";
const HOME_PATH = "/deliveryClient/getScreenContent";   // venue feed (GET, screen_id+coords+city_id)
const LOCATION_PATH = "/deliveryClient/v2/getDeliveryLocation";  // account address → lat/lng/city_id
const ACCESS_PATH = "/profile/eater/auth/getAccessToken";        // mint ~1h access token from refresh
const SCREEN_ID = "870006";                              // food home screen
const STATIC_PARAMS = { version: "FW.1.112", language: "en-US", device_name: "web", device_os_version: "web", deviceType: "web" };

function parseArgs() {
  const a = process.argv.slice(2);
  const flag = (n, d = null) => { const i = a.indexOf(n); return i < 0 ? d : a[i + 1]; };
  return {
    json: a.includes("--json"),
    stream: a.includes("--stream"),
    minDiscount: parseFloat(flag("--min-discount", "15")),
    limit: parseInt(flag("--limit", "5000"), 10),           // effectively no cap
    lat: flag("--lat"), lon: flag("--lon"),  // override auth coords (chosen address)
    setRefresh: flag("--set-refresh"),       // store a new long-lived refresh token, then exit
  };
}

// Persist a freshly-captured refresh token (long-lived ~1yr). Re-capture is rare
// (token expiry / logout). Bolt keeps its tokens XOR-obfuscated (react-native-MMKV)
// in localStorage["mmkv_9$a_store_9$a_persist:root"]; the JWT with a multi-day
// exp is the refresh bearer. To grab it, in a PRIVATE window logged in to
// food.bolt.eu, on a /en/<city>/… URL:
//   node bin/capture.mjs bolt              # prints the console snippet
//   node bin/import-tokens.mjs bolt '<paste>'
// That path also stores city_slug. This flag takes a bare token and nothing else:
//   node bolt.mjs --set-refresh eyJ...
async function setRefreshToken(tok) {
  const exp = jwtExp(tok);
  if (!exp) { console.error("not a JWT — expected the eyJ… refresh bearer"); process.exit(1); }
  const days = ((exp - Math.floor(Date.now() / 1000)) / 86400).toFixed(0);
  if (days <= 0) { console.error(`token already expired (${new Date(exp * 1000).toISOString()})`); process.exit(1); }
  const auth = await readAuth();
  auth.refresh_token = tok;
  delete auth.token;            // drop any stale access token — re-minted on next run
  ensureDevice(auth);
  await saveAuth(auth);
  console.log(`refresh token stored — valid until ${new Date(exp * 1000).toISOString()} (~${days} days). Access tokens now auto-mint; coords + city_id derive from your delivery address.`);
}

async function readAuth() {
  try { return JSON.parse(await readFile(AUTH_PATH, "utf8")); } catch { return {}; }
}
async function saveAuth(auth) { await writeFile(AUTH_PATH, JSON.stringify(auth, null, 2) + "\n"); }

// Generate the per-install identity once (random — NOT bound to the refresh token)
// and persist it so it stays stable across runs. Returns true if anything changed.
function ensureDevice(auth) {
  let changed = false;
  if (!auth.deviceId) { auth.deviceId = randomUUID(); changed = true; }
  if (!auth.session_id) { auth.session_id = `${auth.deviceId}eater${Math.floor(Date.now() / 1000)}`; changed = true; }
  return changed;
}

// Read a field from a JWT's data payload (e.g. user_id) without verifying it.
function jwtField(jwt, key) {
  try { const p = JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64").toString()); return p.data?.[key] ?? p[key]; }
  catch { return null; }
}

// The query params Bolt stamps on every call: embedded static set + this install's
// generated identity + distinct_id derived from the refresh token's user_id.
function commonParams(auth) {
  const uid = jwtField(auth.refresh_token, "user_id");
  return { ...STATIC_PARAMS, deviceId: auth.deviceId, session_id: auth.session_id, distinct_id: `delivery-${uid}` };
}

// "−35%" / "-35%" / "Up to 20% off" → 35 / 20. "Up to €3 off" → null (no basket → no %).
function parseLabelPct(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})\s*%/);
  return m ? parseInt(m[1], 10) : null;
}

// Join key across providers: first two significant words, normalized. Drops
// branch/location noise so "Burger King Makariou" (Wolt) ≈ "Burger King" (Bolt).
function venueKey(name) {
  return String(name || "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").filter(Boolean).slice(0, 2).join(" ");
}

function secsToEta(eta) {
  const lo = eta?.delivery?.min, hi = eta?.delivery?.max;
  if (lo == null || hi == null) return null;
  return `${Math.round(lo / 60)}-${Math.round(hi / 60)}`;
}

// Bolt deals are venue-level, so classify drinks by venue name (coffee/juice/
// tea bars) — the UI hides them by default. A venue whose name ALSO says food
// (bakery, kitchen, grill…) stays food, so "Hellenic Bakery & Coffee" isn't hidden.
const DRINK_VENUE = /coffee|caff[eèé]|café|espresso|cappucc|\blatte\b|\bbean\b|\bbrew|roaster|barista|matcha|\bjuice|juego|smoothie|bubble ?tea|\bboba\b|tea ?house|lemonade/i;
const FOOD_VENUE = /bakery|\bfood\b|kitchen|grill|restaurant|pizz|burger|bistro|\bdeli\b|souvla|tavern|gyro|brunch|breakfast|bites|eatery|diner/i;

function providerToDeal(p, auth) {
  const labels = [...(p.labels?.full || []), ...(p.labels?.short || [])];
  let pct = 0;
  for (const l of labels) { const v = parseLabelPct(l?.text); if (v && v > pct) pct = v; }
  const headline = labels.find((l) => l?.text)?.text || null;
  const ratingNative = p.rating?.value ? parseFloat(p.rating.value) : null;  // /5
  const cover = p.images?.cover || null;
  const url = p.slug ? `https://food.bolt.eu/en/${auth.city_slug}/p/${p.slug}` : null;
  // Bolt+ (subscription) deal — Bolt's menu discounts are mostly Plus-gated.
  const boltPlus = p.icon_keys?.name_suffix === "bolt_plus" || (p.icon_keys?.name_suffixes || []).includes("bolt_plus");
  return {
    provider: "bolt",
    venue_level: true,
    name: p.name,                 // the venue IS the offer (whole-menu discount)
    item_name: null,
    image: cover,
    venue_name: null,             // venue-level: UI renders a "whole-menu" subtitle, not a fee note
    venue_key: venueKey(p.name),
    venue_id: String(p.id),
    eta: secsToEta(p.eta),
    rating: ratingNative,
    rating_scale: 5,
    rating10: ratingNative != null ? +(ratingNative * 2).toFixed(1) : null,
    price_minor: null,
    original_minor: null,
    currency: "EUR",
    discount_percentage: pct,
    headline,
    is_wolt_plus: false,
    is_plus: boltPlus,
    plus_label: boltPlus ? "B+" : null,
    is_drink: DRINK_VENUE.test(p.name || "") && !FOOD_VENUE.test(p.name || ""),
    item_url: url,
    venue_url: url,
  };
}

function jwtExp(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64").toString()).exp || 0; }
  catch { return 0; }
}

// Mint a fresh ~1h access token from the long-lived (~year) refresh token saved
// in bolt_auth.json — the same /getAccessToken call the web app makes on expiry
// (Bearer = refresh token, empty body). Captured once from a logged-in browser.
async function refreshAccessToken(auth) {
  const cp = new URLSearchParams(commonParams(auth)).toString();
  const res = await fetch(BASE + ACCESS_PATH + "?" + cp, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${auth.refresh_token}`, Referer: "https://food.bolt.eu/" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`getAccessToken HTTP ${res.status}`);
  const j = await res.json();
  const at = j.access_token || j.data?.access_token;
  if (!at) throw new Error("no access_token in refresh response");
  return at;
}

// Derive the delivery coords + city_id from the account's saved address — so a
// changed address in the app is followed automatically, nothing to re-capture.
async function fetchLocation(auth) {
  const cp = new URLSearchParams(commonParams(auth)).toString();
  const res = await fetch(BASE + LOCATION_PATH + "?" + cp, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${auth.token}`, Referer: "https://food.bolt.eu/" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`getDeliveryLocation HTTP ${res.status}`);
  const loc = (await res.json()).data?.location || {};
  return { lat: loc.location_address?.lat, lng: loc.location_address?.lng, city_id: loc.city_id };
}

async function loadHome(opts) {
  const auth = await readAuth();
  if (!auth.refresh_token) {
    process.stderr.write("Bolt: no refresh_token in bolt_auth.json — capture one: node bin/capture.mjs bolt\n");
    return { auth, stale: true };
  }
  if (!auth.city_slug) throw new Error(`Set "city_slug" in ${AUTH_PATH} (the slug in your food.bolt.eu URL).`);
  let changed = ensureDevice(auth);
  const nowSec = Math.floor(Date.now() / 1000);
  // Access token lives ~1h. Mint a fresh one from the refresh token when it's
  // missing/near-expiry and persist it so the next run also starts valid.
  if (jwtExp(auth.token) < nowSec + 120) {
    try { auth.token = await refreshAccessToken(auth); changed = true; }
    catch (e) { process.stderr.write(`Bolt token mint failed: ${e.message} — refresh token may be expired (re-capture via --set-refresh).\n`); }
  }
  if (changed) await saveAuth(auth);
  if (jwtExp(auth.token) < nowSec) {
    process.stderr.write("Bolt: no valid access token — skipping.\n");
    return { auth, stale: true };
  }
  // Coords + city from the account's saved delivery address (overridable via --lat/--lon),
  // cached back for use if a later lookup fails.
  let lat = opts.lat, lng = opts.lon, cityId = auth.city_id;
  try {
    const loc = await fetchLocation(auth);
    lat = lat || loc.lat; lng = lng || loc.lng; cityId = loc.city_id || cityId;
    if (loc.lat != null) { auth.lat = loc.lat; auth.lng = loc.lng; auth.city_id = loc.city_id; await saveAuth(auth); }
  } catch (e) {
    process.stderr.write(`Bolt location lookup failed: ${e.message}; using cached coords.\n`);
    lat = lat || auth.lat; lng = lng || auth.lng;
  }
  if (lat == null || cityId == null) {
    process.stderr.write("Bolt: no delivery address on the account — set one in the app.\n");
    return { auth, stale: true };
  }
  const screenId = auth.home_screen_id || SCREEN_ID;
  const cp = new URLSearchParams(commonParams(auth)).toString();
  const url = `${BASE}${HOME_PATH}?screen_id=${screenId}&delivery_lat=${lat}&delivery_lng=${lng}&city_id=${cityId}&${cp}`;
  const res = await fetch(url, { headers: { accept: "*/*", authorization: `Bearer ${auth.token}`, Referer: "https://food.bolt.eu/" } });
  if (!res.ok) {
    process.stderr.write(`Bolt home → HTTP ${res.status}; skipping (live data unavailable).\n`);
    return { auth, stale: true };
  }
  return { home: await res.json(), auth };
}

function rankBolt(deals, minDiscount, limit) {
  return deals
    .filter((d) => (d.discount_percentage || 0) >= minDiscount)
    .sort((a, b) =>
      (b.discount_percentage - a.discount_percentage) ||
      ((b.rating10 || 0) - (a.rating10 || 0)))
    .slice(0, limit);
}

async function main() {
  const opts = parseArgs();
  if (opts.setRefresh) { await setRefreshToken(opts.setRefresh); return; }
  const { home, auth, stale } = await loadHome(opts);
  // Expired token / HTTP error: emit nothing rather than risk wrong data.
  if (stale) {
    process.stderr.write("Bolt: live data unavailable (stale token) — skipping (availability can't be trusted).\n");
    if (opts.stream) {
      const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
      emit({ type: "start", address: `Bolt ${auth.city_slug}`, provider: "bolt" });
      emit({ type: "done", deals: [], provider: "bolt" });
    } else if (opts.json) { process.stdout.write("[]\n"); }
    else { console.log("Bolt Food: live data unavailable (stale token); skipped.\n"); }
    return;
  }
  const providers = home?.data?.providers?.data || {};
  // Drop non-food verticals (grocery / alcohol / pharmacy / pet / retail) — Bolt
  // lists them all; we only want restaurants. Build the exclude set from the
  // store-ish provider_categories.
  const cats = home?.data?.provider_categories?.data || {};
  const nonFood = new Set();
  for (const c of Object.values(cats)) {
    if (/store|grocer|alcohol|market|pharmac|\bpet\b|beauty|flower|florist/i.test(c.name || "")) {
      for (const id of c.provider_ids || []) nonFood.add(String(id));
    }
  }
  // Availability: only venues open for instant delivery right now and in range.
  const open = Object.values(providers).filter((p) =>
    p.availability?.delivery?.instant === true && p.is_in_range !== false && !nonFood.has(String(p.id)));
  const all = open.map((p) => providerToDeal(p, auth));
  const ranked = rankBolt(all, opts.minDiscount, opts.limit);

  if (opts.stream) {
    const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
    emit({ type: "start", address: `Bolt ${auth.city_slug}`, provider: "bolt" });
    for (const d of ranked) emit({ type: "deal", deal: d });
    emit({ type: "progress", done: 1, total: 1 });
    emit({ type: "done", deals: ranked, provider: "bolt" });
    return;
  }
  if (opts.json) { process.stdout.write(JSON.stringify(ranked, null, 2) + "\n"); return; }

  console.log(`Bolt Food deals near ${auth.city_slug} — ${ranked.length} venue-level offers:\n`);
  for (const d of ranked) {
    const r = d.rating != null ? ` ★${d.rating}/5` : "";
    const eta = d.eta ? ` ${d.eta}m` : "";
    console.log(`[bolt] ${String(d.discount_percentage).padStart(3)}% off${r}${eta}  ${d.name}${d.venue_name ? "  ("+d.venue_name+")" : ""}`);
    if (d.venue_url) console.log(`        ${d.venue_url}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
}

export { providerToDeal, parseLabelPct, venueKey, secsToEta };
