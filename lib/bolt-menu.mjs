// Bolt Food venue menu (auth-gated), the piece bolt.mjs's venue-level scan cannot
// give you: a Bolt deal is a WHOLE-MENU discount with no dish and no price, so the
// only way to answer "what does it actually cost" is to read the venue's own menu.
//
// One observed call: GET /deliveryClient/getMenuCategories?provider_id=… returns a
// flat node map (menu / category / dish / option_*_group / option_*) linked by
// child_ids. Bolt already applies the venue campaign to every node, so a dish
// carries the DISCOUNTED price plus price.original_price and price.discount_percent.
// Nothing here computes a price from a percentage.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { configPath } from "./config.mjs";

const BASE = "https://deliveryuser.live.boltsvc.net";
const STATIC_PARAMS = { version: "FW.1.112", language: "en-US", device_name: "web", device_os_version: "web", deviceType: "web" };

const jwtField = (jwt, key) => {
  try { const p = JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64").toString()); return p.data?.[key] ?? p[key]; }
  catch { return null; }
};
// Bolt prices are euros as a number; the rest of deal-radar speaks minor units.
const eur = (v) => (v == null ? null : Math.round(v * 100));
const txt = (x) => (x && typeof x === "object" ? x.value : x) ?? null;
// Dish images nest as images[group].aspect_ratio_map[ratio][density].
const boltImg = (images) => {
  for (const grp of Object.values(images || {}))
    for (const ratio of Object.values(grp?.aspect_ratio_map || {})) {
      const u = ratio?.["3x"] || ratio?.["2x"] || ratio?.["1x"];
      if (u) return u;
    }
  return null;
};

async function boltHeaders() {
  const auth = JSON.parse(await readFile(configPath("bolt_auth.json"), "utf8"));
  if (!auth.refresh_token) throw new Error("Bolt: no refresh_token, run: node bin/capture.mjs bolt");
  // A menu read is stateless: if the scan never ran, stand in a device id for this
  // call instead of writing one back into the shared auth file.
  const deviceId = auth.deviceId || randomUUID();
  const cp = new URLSearchParams({
    ...STATIC_PARAMS, deviceId,
    session_id: auth.session_id || `${deviceId}eater${Math.floor(Date.now() / 1000)}`,
    distinct_id: `delivery-${jwtField(auth.refresh_token, "user_id")}`,
  }).toString();
  const res = await fetch(`${BASE}/profile/eater/auth/getAccessToken?${cp}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${auth.refresh_token}`, Referer: "https://food.bolt.eu/" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Bolt getAccessToken HTTP ${res.status}`);
  const at = (await res.json()).data?.access_token;
  if (!at) throw new Error("Bolt: no access_token in refresh response");
  return { cp, headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${at}`, Referer: "https://food.bolt.eu/" } };
}

// A "Choose variation"-style group is mandatory, and its options are price deltas
// (already discounted). The cheapest pick in every required group is what the dish
// really costs, the same minimum the Wolt scanner reports as effective_min_minor.
function requiredAddonMinor(dish, byId) {
  let sum = 0;
  for (const gid of dish.child_ids || []) {
    const g = byId[String(gid)];
    if (!g?.is_required || !(g.child_ids || []).length) continue;
    let min = Infinity;
    for (const oid of g.child_ids) min = Math.min(min, byId[String(oid)]?.price?.value ?? 0);
    if (isFinite(min)) sum += min;
  }
  return eur(sum);
}

function dishToItem(n, byId) {
  const p = n.price || {};
  const price = eur(p.value);
  const addon = requiredAddonMinor(n, byId);
  return {
    id: String(n.id),
    name: txt(n.name),
    description: txt(n.description),
    price_minor: price,
    original_minor: eur(p.original_price?.value),
    discount_percentage: p.discount_percent || 0,
    // What the cheapest orderable configuration costs (size, base, …).
    mandatory_addon_minor: addon,
    effective_min_minor: price != null ? price + addon : null,
    currency: "EUR",
    image: boltImg(n.images),
  };
}

// Returns [{ name, items: [...] }] for one Bolt venue id. Throws on an auth/HTTP
// failure so the caller can say WHY the menu is missing, not render an empty venue.
export async function boltVenueMenu(venueId, { lat, lon } = {}) {
  const { cp, headers } = await boltHeaders();
  const geo = lat != null && lon != null ? `&delivery_lat=${lat}&delivery_lng=${lon}` : "";
  const res = await fetch(`${BASE}/deliveryClient/getMenuCategories?provider_id=${venueId}${geo}&${cp}`, { headers });
  if (!res.ok) throw new Error(`Bolt getMenuCategories HTTP ${res.status}`);
  const nodes = Object.values((await res.json())?.data?.items || {});
  const byId = Object.fromEntries(nodes.map((n) => [String(n.id), n]));
  return nodes
    .filter((n) => n?.type === "category" && (n.child_ids || []).length)
    .map((c) => ({
      name: txt(c.name) || "Menu",
      items: (c.child_ids || []).map((id) => byId[String(id)])
        .filter((n) => n?.type === "dish")
        .map((n) => dishToItem(n, byId)),
    }))
    .filter((c) => c.items.length);
}
