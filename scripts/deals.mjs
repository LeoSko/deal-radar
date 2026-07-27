#!/usr/bin/env node
// Find truly good Wolt deals deliverable to the user's saved Work address.
//
// Two strategies:
//   1. promotions-near-you: Wolt's own discovery page. Fast. Often empty.
//   2. Default scan: fall back to scanning top-N nearby venues' assortments for items
//      with `original_price > price`. Slower (one HTTP request per venue) but
//      catches deals the promotions page doesn't surface.
//
// Ranking:
//   1. Wolt+ deals at 50%+ off on food
//   2. Wolt+ deals 30–49% off on food
//   3. Any Wolt+ food deal
//   4. Non-Wolt+ food deals (descending discount %)
// Non-food (sauces, drinks, coffee, water, sides) filtered out via banlist.json.
//
// Usage:
//   node deals.mjs                        # promotions endpoint + scan top-N venues
//   node deals.mjs --no-scan              # promotions endpoint only
//   node deals.mjs --scan-limit 50        # max total venues to scan (default 150)
//   node deals.mjs --lat 52.52 --lon 13.40
//   node deals.mjs --min-discount 30      # default 30 (with fallback to --floor)
//   node deals.mjs --floor 15             # hard floor if nothing meets --min-discount (default 15)
//   node deals.mjs --limit 25             # rows to print (default 100)
//   node deals.mjs --json
//   node deals.mjs --dump                 # raw promotions JSON
//   node deals.mjs --show-unparsed        # summarize logged badge texts that
//                                         # didn't parse to a discount %, grouped
//                                         # by kind+count (e.g. fixed_price,
//                                         # named_offer). Use to decide which new
//                                         # parser rules or banlist entries to add.

import { woltFetch } from "../lib/fetch.mjs";
import { loadAuth } from "../lib/auth.mjs";
import { fmtMoney, fmtPercent } from "../lib/format.mjs";
import { configPath } from "../lib/config.mjs";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const BANLIST_PATH = new URL("../banlist.json", import.meta.url);
const UNPARSED_LOG_PATH = configPath("unparsed_promos.jsonl");

async function loadBanlist() {
  const raw = await readFile(BANLIST_PATH, "utf8");
  return JSON.parse(raw);
}

function isFood(name, banlist) {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  for (const exact of banlist.non_food_strict) if (lower === exact) return false;
  for (const sub of banlist.non_food_substrings) {
    const re = new RegExp(`(^|[^a-z])${sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(lower)) return false;
  }
  return true;
}

// True if the venue is a food/restaurant venue. Primary signal is Wolt's
// `product_line`: the only food vertical we scan is "restaurant"; everything else
// (grocery/supermarkets, health_and_beauty, pharmacy, pet_supply, florist,
// general_merchandise, alcohol) is dropped. We allowlist via banlist.food_product_lines so a new
// non-food vertical fails closed. Tag/name banlists below are defense-in-depth
// (e.g. a "restaurant"-tagged hookah lounge). product_line caught a beauty
// store that a stray "korean" tag had let through.
function isFoodVenue(venue, banlist) {
  const pl = String(venue?.product_line || "").toLowerCase();
  const allow = banlist.food_product_lines || [];
  if (pl && allow.length && !allow.includes(pl)) return false;
  const tags = (venue?.tags || []).map((t) => String(t).toLowerCase());
  for (const bad of banlist.non_food_venue_tags || []) {
    const needle = bad.toLowerCase();
    if (tags.some((t) => t === needle || t.includes(needle))) return false;
  }
  const name = String(venue?.name || "").toLowerCase();
  for (const bad of banlist.non_food_venue_name_substrings || []) {
    if (name.includes(bad.toLowerCase())) return false;
  }
  return true;
}

// --- promotions-near-you extraction ---------------------------------------
//
// Wolt's promotions page response shape is undocumented and varies by city/date.
// We walk the JSON tree finding any object that looks like a deal: has a name,
// has either an explicit discount badge / discount_percentage / both price + original_price.

function extractFromPromotionsTree(raw, banlist) {
  const deals = [];
  const seen = new Set();

  const visit = (n, ctx) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, ctx));

    const childCtx = { ...ctx };
    if (n.venue_id || n.venue?.id) childCtx.venue_id = n.venue_id || n.venue?.id;
    if (n.venue_name || n.venue?.name) childCtx.venue_name = n.venue_name || n.venue?.name;
    const slug = n.slug || n.venue_slug || n.venue?.slug;
    if (slug) childCtx.venue_slug = slug;
    const productLine = n.venue?.product_line || n.product_line;
    if (productLine) childCtx.product_line = productLine;
    if (typeof n.rating?.score === "number") childCtx.rating = n.rating.score;
    if (n.estimate || n.estimate_range) childCtx.eta = n.estimate_range || `${n.estimate} min`;
    // Inherit venue's non-food verdict down to nested preview items.
    if (n.venue?.tags || n.tags) {
      const tagSrc = n.venue?.tags ? n.venue : n;
      childCtx.venue_is_food = banlist ? isFoodVenue(tagSrc, banlist) : true;
    }
    if (ctx.venue_is_food === false) return;  // skip entire subtree once flagged non-food

    const price = numericMinor(n.price);
    const original = numericMinor(n.original_price) ?? numericMinor(n.base_price);
    const explicit = typeof n.discount_percentage === "number" ? n.discount_percentage : null;
    const computed = original && price !== null && price < original ? Math.round(((original - price) / original) * 100) : null;
    const pct = explicit ?? computed;

    const badges = collectBadges(n);
    const isWoltPlus = sniffWoltPlus(n, badges);

    const name = n.name || n.title || n.heading;
    if (pct && pct > 0 && name) {
      const key = `${childCtx.venue_id || ""}::${name}::${pct}::${price ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        deals.push({
          name: String(name),
          // n.id on a priced node is the item id (venue nodes carry their id in
          // venue_id/venue.id, tracked separately in ctx) — used for deep links.
          item_id: price !== null && n.id && n.id !== childCtx.venue_id ? String(n.id) : null,
          item_name: price !== null ? String(name) : null,
          venue_name: childCtx.venue_name || null,
          venue_slug: childCtx.venue_slug || null,
          venue_id: childCtx.venue_id || null,
          product_line: childCtx.product_line || null,
          eta: childCtx.eta || null,
          rating: childCtx.rating ?? null,
          price_minor: price,
          original_minor: original,
          currency: n.price?.currency || n.currency || ctx?.currency || "EUR",
          discount_percentage: pct,
          is_wolt_plus: !!isWoltPlus,
          badges,
        });
      }
    }
    for (const v of Object.values(n)) visit(v, childCtx);
  };
  visit(raw, {});
  return deals;
}

function numericMinor(p) {
  if (p === undefined || p === null) return null;
  if (typeof p === "number") return Math.round(p);
  if (typeof p === "object") return typeof p.amount === "number" ? Math.round(p.amount) : null;
  return null;
}

function collectBadges(n) {
  const out = [];
  if (Array.isArray(n.badges)) for (const b of n.badges) {
    const t = b?.text || b?.title || b?.label || (typeof b === "string" ? b : null);
    if (t) out.push(String(t));
  }
  if (Array.isArray(n.badges_v2)) for (const b of n.badges_v2) {
    const t = b?.text || b?.title || (typeof b === "string" ? b : null);
    if (t) out.push(String(t));
  }
  if (n.badge?.text) out.push(String(n.badge.text));
  return out;
}

function sniffWoltPlus(n, badges) {
  if (n.is_wolt_plus_member_only === true) return true;
  if (n.is_wolt_plus_only === true) return true;
  if (n.loyalty_program === "wolt_plus") return true;
  if (n.show_wolt_plus === true) return true;
  return badges.some((b) => /wolt\+|wolt plus/i.test(b));
}

// --- venue-scan strategy --------------------------------------------------
//
// The promotions-near-you response lists every nearby venue with a `venue.promotions`
// badge array (text like "Save 50% with W+", "30% off selected items", "-30% on your
// total order"). We use it for two things:
//   (a) Surface venue-level deals directly without drilling into the menu.
//   (b) Filter scan candidates to venues actually advertising a discount ≥ min,
//       so the scanner does not blindly fetch unrelated assortments.

const SELECTED_ITEMS_RE = /selected\s+items?\b|on\s+(?:the\s+)?(?:[\w' -]+)\s+(?:serum|set|item|capsules|coffee|sandwich)\b/i;

// Parse a promo badge text into an effective discount percentage.
//
// Handles:
//   - "X% off" / "Save X% with W+" / "-X%"
//   - BOGO: "Buy N, Pay for M" / "Buy N Maki Pay 1" / "Add N ... Pay 1" → (N-M)/N
//   - Min-spend cashback: "X € off (spend Y €)" → X/Y floor
// Skips opaque badges (delivery-fee deals, "Friends offer", "FREE drink", "X € off"
// without min spend) → returns null and the caller filters them out.
function parsePromoPct(txt) {
  if (!txt) return null;

  // "0 € delivery fee" etc. — not an item discount.
  if (/delivery\s+fee/i.test(txt)) return null;

  // 1) Plain pct: "30% off", "Save 50% with W+", "-30% on selected items".
  let m = txt.match(/(?:save\s+)?(\d{1,2})\s*%(?:\s*off)?/i);
  if (m) return parseInt(m[1], 10);
  m = txt.match(/-(\d{1,2})\s*%/);
  if (m) return parseInt(m[1], 10);

  // 2) BOGO: "Buy N[,]? Pay for M", with optional item words between.
  m = txt.match(/\bbuy\s+(\d+)\b[^]{0,40}?\bpay\s*(?:for\s+)?(\d+)\b/i);
  if (m) {
    const bought = +m[1], paid = +m[2];
    if (bought > paid && bought > 0) return Math.round(((bought - paid) / bought) * 100);
  }
  // "Add 2 coffees and Pay 1" / "Add 2 Nicaragu Capsules Pay 1"
  m = txt.match(/\badd\s+(\d+)\b[^]{0,60}?\bpay\s*(?:for\s+)?(\d+)\b/i);
  if (m) {
    const bought = +m[1], paid = +m[2];
    if (bought > paid && bought > 0) return Math.round(((bought - paid) / bought) * 100);
  }
  // "Buy N and get M free"
  m = txt.match(/\bbuy\s+(\d+)\s+(?:and\s+)?get\s+(\d+)\s+free\b/i);
  if (m) {
    const bought = +m[1], free = +m[2];
    const total = bought + free;
    if (free > 0 && total > 0) return Math.round((free / total) * 100);
  }

  // 3) Cashback with min spend: "3 € off (spend 30 €)" → 10% floor.
  m = txt.match(/(\d+(?:[.,]\d+)?)\s*€\s*off\s*\(\s*spend\s+(\d+(?:[.,]\d+)?)\s*€/i);
  if (m) {
    const off = parseFloat(m[1].replace(",", "."));
    const spend = parseFloat(m[2].replace(",", "."));
    if (spend > 0) return Math.round((off / spend) * 100);
  }

  return null;
}

// Classify badges that parsePromoPct can't turn into a percentage. Used to (a)
// decide whether to log a badge for later review, and (b) skip well-known no-op
// labels ("New", "ONLY ON WOLT", schedule strings) silently.
//
// Categories:
//   - empty / no_text
//   - delivery_fee       → "0 € delivery fee", "Free delivery", "X & €0 Del. Fees"
//   - schedule_label     → "EVERY DAY | 07:00 - 24:00"
//   - marketing_label    → "New", "ONLY ON WOLT", "Friends offer"
//   - free_item          → "FREE drink", "FREE side dish"
//   - fixed_price        → "Lunch offer €8.90", "My Box only €12.99", "2 FOR €9"
//   - fixed_amount_off   → "2 € off", "-€1.50 Poe's Chicken Strips" (no min spend → can't compute %)
//   - named_offer        → "Coffee Combo", "Party Offer", "Large & X-Large pizzas offer"
//   - unknown            → none of the above; worth manual review
function classifyUnparsedBadge(text) {
  if (!text) return "no_text";
  const t = String(text).trim();
  if (!t.length) return "no_text";
  if (/delivery\s+fees?|free\s+delivery|del\.?\s*fees?/i.test(t)) return "delivery_fee";
  if (/^\s*every\s+day\b|\b\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}\b/i.test(t)) return "schedule_label";
  if (/^new\s*$|\bonly\s+on\s+wolt\b|^friends\s+offer\s*$/i.test(t)) return "marketing_label";
  if (/\bfree\b/i.test(t)) return "free_item";
  // Anything with a €amount but no %: likely a fixed-price or fixed-€-off badge.
  if (/€\s*\d|(\d+(?:[.,]\d+)?)\s*€/.test(t) && !/%/.test(t)) {
    if (/\boff\b/i.test(t) || /^-/.test(t)) return "fixed_amount_off";
    return "fixed_price";
  }
  if (/\b(offer|deal|combo|bundle|lunch|party|box|platter|special)\b/i.test(t)) return "named_offer";
  return "unknown";
}

// Append an unparsed badge sample to the JSONL log. Best-effort; failures don't
// stop the run. Read with `--show-unparsed` to summarize.
async function recordUnparsedBadges(samples) {
  if (!samples.length) return;
  try {
    await mkdir(dirname(UNPARSED_LOG_PATH), { recursive: true });
    const ts = new Date().toISOString();
    const lines = samples.map((s) => JSON.stringify({ ts, ...s }));
    await appendFile(UNPARSED_LOG_PATH, lines.join("\n") + "\n");
  } catch (e) {
    process.stderr.write(`(unparsed-log write failed: ${e.message})\n`);
  }
}

async function showUnparsedSummary() {
  let raw;
  try {
    raw = await readFile(UNPARSED_LOG_PATH, "utf8");
  } catch {
    console.log("No unparsed promos logged yet.");
    return;
  }
  const lines = raw.split("\n").filter(Boolean);
  const groups = new Map();
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const key = `${r.kind}\t${r.text}`;
    const g = groups.get(key) || { kind: r.kind, text: r.text, count: 0, venues: new Set(), lastSeen: r.ts };
    g.count++;
    if (r.venue_name) g.venues.add(r.venue_name);
    if (r.ts > g.lastSeen) g.lastSeen = r.ts;
    groups.set(key, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  console.log(`Unparsed badge log (${lines.length} samples across ${groups.size} distinct texts):\n`);
  for (const g of sorted) {
    const sample = [...g.venues].slice(0, 3).join(", ") + (g.venues.size > 3 ? `, +${g.venues.size - 3}` : "");
    console.log(`  ${String(g.count).padStart(4)}  [${g.kind.padEnd(18)}]  ${JSON.stringify(g.text)}`);
    if (sample) console.log(`        venues: ${sample}`);
  }
  console.log(
    "\nReview categories:\n" +
    "  fixed_price / fixed_amount_off / named_offer — consider adding parser rules.\n" +
    "  unknown — likely needs a new parse pattern or banlist entry.\n" +
    "  delivery_fee / schedule_label / marketing_label / free_item — safely ignored.\n",
  );
}

function venueScopeFromText(txt) {
  if (!txt) return "venue-wide";
  if (SELECTED_ITEMS_RE.test(txt)) return "selected";
  return "venue-wide";
}

// Collect venue-level deals from the promotions tree. Each badge with a parseable
// % becomes a deal whose "name" is the badge text itself (e.g. "-30% on your total order").
// Returns { deals, unparsed } — unparsed list is fed to recordUnparsedBadges so the
// script learns over time which badge shapes need new rules.
function extractVenueLevelDeals(promo, banlist) {
  const sec = (promo.sections || []).find((s) => s.template === "venue-vertical-list");
  const out = [];
  const unparsed = [];
  for (const it of sec?.items || []) {
    const v = it.venue;
    if (!v || !v.online || !v.delivers) continue;
    if (!isFoodVenue(v, banlist)) continue;
    for (const p of v.promotions || []) {
      const text = p?.text || "";
      const pct = parsePromoPct(text);
      if (!pct) {
        const kind = classifyUnparsedBadge(text);
        // Skip well-known no-discount labels silently.
        if (kind !== "no_text" && kind !== "delivery_fee" && kind !== "schedule_label" && kind !== "marketing_label" && kind !== "free_item") {
          unparsed.push({
            kind,
            text,
            venue_name: v.name,
            venue_slug: v.slug,
            venue_tags: v.tags || [],
            icon: p?.icon || null,
            variant: p?.variant || null,
          });
        }
        continue;
      }
      const woltPlusBadge = /with\s+w\+/i.test(text);  // strict: "Save X% with W+"
      out.push({
        name: text,
        venue_name: v.name,
        venue_slug: v.slug,
        venue_id: v.id,
        product_line: v.product_line || null,
        eta: v.estimate_range || (v.estimate ? `${v.estimate} min` : null),
        rating: v.rating?.score ?? null,
        price_minor: null,
        original_minor: null,
        currency: v.currency || "EUR",
        discount_percentage: pct,
        is_wolt_plus: woltPlusBadge,
        badges: [text],
        venue_level: true,
        scope: venueScopeFromText(text),
      });
    }
  }
  return { deals: out, unparsed };
}

// True if a venue carries a real offer badge we couldn't turn into a % from text
// (fixed-price "€8.90 Lunch offer", "€X off selected items", named combos, etc.).
// These venues won't clear the maxPct gate, but the deeper scan can still derive a
// precise per-item % from their assortment/campaigns — so they're worth scanning.
function hasUnparsedOfferBadge(v) {
  for (const p of v.promotions || []) {
    const t = p?.text || "";
    if (!t || parsePromoPct(t) != null) continue;
    const k = classifyUnparsedBadge(t);
    if (k !== "no_text" && k !== "delivery_fee" && k !== "schedule_label" && k !== "marketing_label" && k !== "free_item") {
      return true;
    }
  }
  return false;
}

// Filter the promotions response to a scan-worthy venue list: those advertising
// pct >= minDiscount, a "with W+" offer, OR an unparseable real offer badge whose
// % the scan can derive from the assortment. Avoids blind 80-venue scan.
function pickScanCandidatesFromPromotions(promo, minDiscount, banlist) {
  const sec = (promo.sections || []).find((s) => s.template === "venue-vertical-list");
  const out = [];
  for (const it of sec?.items || []) {
    const v = it.venue;
    if (!v || !v.online || !v.delivers) continue;
    if (!isFoodVenue(v, banlist)) continue;
    const texts = (v.promotions || []).map((p) => p?.text || "");
    const maxPct = texts.reduce((m, t) => Math.max(m, parsePromoPct(t) || 0), 0);
    const woltPlusBadge = texts.some((t) => /with\s+w\+/i.test(t));
    const unparsedOffer = hasUnparsedOfferBadge(v);
    if (maxPct < minDiscount && !woltPlusBadge && !unparsedOffer) continue;
    out.push({
      id: v.id,
      slug: v.slug,
      name: v.name,
      product_line: v.product_line || null,
      rating: v.rating?.score,
      estimate: v.estimate_range || (v.estimate ? `${v.estimate} min` : null),
      show_wolt_plus: !!v.show_wolt_plus,
      promotions: v.promotions || [],
      currency: v.currency || "EUR",
      _promo_max_pct: maxPct,
      _has_wolt_plus_offer: woltPlusBadge,
      _unparsed_offer: unparsedOffer,
    });
  }
  // Best-advertised first; parseable-% and W+ venues rank above unparsed-only ones.
  out.sort((a, b) => {
    if (a._has_wolt_plus_offer !== b._has_wolt_plus_offer) return a._has_wolt_plus_offer ? -1 : 1;
    return b._promo_max_pct - a._promo_max_pct;
  });
  return out;
}

// Legacy fallback (used if promotions response is empty for these coords).
async function nearbyVenuesByDistance(addr, banlist, limit = 100) {
  const data = await woltFetch("promotions", {}, {
    url: `https://restaurant-api.wolt.com/v1/pages/restaurants?lat=${addr.lat}&lon=${addr.lon}`,
  });
  const list = (data.sections || []).find((s) => s.template === "venue-vertical-list");
  const venues = (list?.items || [])
    .map((it) => it.venue)
    .filter((v) => v && v.online && v.delivers)
    .filter((v) => !banlist || isFoodVenue(v, banlist))
    .slice(0, limit)
    .map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
      product_line: v.product_line || null,
      rating: v.rating?.score,
      estimate: v.estimate_range || (v.estimate ? `${v.estimate} min` : null),
      show_wolt_plus: !!v.show_wolt_plus,
      promotions: v.promotions || [],
      currency: v.currency || "EUR",
    }));
  return venues;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unofficial Wolt consumer API rate limit, measured empirically (see
// docs note in SKILL.md): throughput plateaus at ~6.6 req/s across every
// concurrency setting, and anything faster gets 429'd regardless of how the
// concurrency is arranged. So the real governor is requests/second, not the
// worker count. We pace request *starts* to scanMaxRps (the measured ceiling
// minus a ~2% safety margin) via a shared monotonic "next slot" cursor; the
// worker pool just needs enough workers to keep this rate saturated.
let scanMaxRps = 6.4;  // ceiling ≈ 6.6 req/s − 2%; overridable via --scan-rps
let rateNextSlotMs = 0;
async function rateGate(rps = scanMaxRps) {
  const minIntervalMs = 1000 / rps;
  const now = performance.now();
  const startAt = Math.max(now, rateNextSlotMs);
  rateNextSlotMs = startAt + minIntervalMs;
  const wait = startAt - now;
  if (wait > 0) await sleep(wait);
}

async function fetchWithRetry(name, params, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await rateGate();  // pace to the measured API ceiling before every request
      return await woltFetch(name, params);
    } catch (e) {
      lastErr = e;
      if (!/→ 429/.test(e.message || "")) throw e;
      await sleep(500 * (i + 1));  // 500, 1000, 1500 backoff on the rare 429 that slips through
    }
  }
  throw lastErr;
}

// Walk an item's option groups to compute the cheapest mandatory add-on
// total. Wolt items frequently require size / dough / etc. and the assortment
// `item.price` is the BASE without those required selections — so a "€6.45
// pizza" can checkout at €10–17 once a mandatory size is picked. We return
// the cheapest legal add-on sum + a human-readable breakdown so the scanner
// can flag misleading "headline" prices.
//
// Logic:
//   1. A group is mandatory when total_range.min >= 1 AND free_selections < min.
//   2. Root mandatory groups (no prerequisite_values) are always required.
//   3. Dependent groups (with prerequisite_values) only kick in once you pick
//      the parent value referenced by their prerequisites. To stay cheapest,
//      we evaluate every root permutation and pick the configuration with the
//      lowest total cost (which itself includes any chained dependents that
//      activate from that choice).
// Minute-of-week for "now" in the venue's local timezone. Wolt's
// weekly_time_restrictions appear to be in the venue's timezone — the
// server returns the same restriction regardless of the request's
// timezone, so we use the user's local clock as a best-effort proxy
// (consistent with the assumption that the user is querying nearby
// venues and is therefore in the same TZ). 0 = Monday 00:00.
function weekMinuteNow(date) {
  const d = date || new Date();
  // JS getDay(): Sunday=0..Saturday=6. Convert to Mon=0..Sun=6.
  const dow = (d.getDay() + 6) % 7;
  return dow * 1440 + d.getHours() * 60 + d.getMinutes();
}

function computeMandatoryAddons(item, optionsById) {
  const groups = item.options || [];
  if (!groups.length) return { addon_minor: 0, breakdown: [] };
  const isMandatory = (g) => {
    const r = g.multi_choice_config?.total_range;
    if (!r || !r.min || r.min < 1) return false;
    const free = g.multi_choice_config?.free_selections || 0;
    return free < r.min;
  };
  const rootMandatory = groups.filter((g) => isMandatory(g) && (!g.prerequisite_values || !g.prerequisite_values.length));
  if (!rootMandatory.length) return { addon_minor: 0, breakdown: [] };

  // For each root mandatory group, try every value; recursively compute the
  // chained dependent groups that activate; keep the cheapest combo per group.
  function pickGroup(group, valuePath, visitedGroupIds) {
    if (visitedGroupIds.has(group.id)) return { addon_minor: 0, breakdown: [] };
    const def = optionsById.get(group.option_id);
    const min = group.multi_choice_config.total_range.min || 1;
    const free = group.multi_choice_config.free_selections || 0;
    const billable = Math.max(0, min - free);
    const values = (def?.values || []).slice().sort((a, b) => (a.price || 0) - (b.price || 0));
    let best = null;
    const nextVisited = new Set([...visitedGroupIds, group.id]);
    for (const v of values) {
      const nextPath = [...valuePath, v.id];
      const deps = groups.filter((g) =>
        isMandatory(g) &&
        !nextVisited.has(g.id) &&
        (g.prerequisite_values || []).some((id) => nextPath.includes(id)),
      );
      const depResults = deps.map((d) => pickGroup(d, nextPath, new Set([...nextVisited, ...deps.map((x) => x.id)])));
      const depCost = depResults.reduce((s, r) => s + r.addon_minor, 0);
      const total = billable * (v.price || 0) + depCost;
      if (best === null || total < best.addon_minor) {
        best = {
          addon_minor: total,
          breakdown: [{ group: def?.name || group.option_id, value: v.name, price: v.price || 0, count: billable }]
            .concat(depResults.flatMap((r) => r.breakdown)),
        };
      }
    }
    return best || { addon_minor: 0, breakdown: [] };
  }

  let total = 0;
  const breakdown = [];
  for (const root of rootMandatory) {
    const picked = pickGroup(root, [], new Set());
    total += picked.addon_minor;
    breakdown.push(...picked.breakdown);
  }
  return { addon_minor: total, breakdown };
}

// Decide whether to append a campaign title to the item name. The % and the W+
// tag are already shown as badges, so a generic "Save 40% on selected items with
// W+" / "40% Discount on Bao Buns" title is pure noise — drop it. Keep ONLY
// titles that carry concrete info the card can't show otherwise: an explicit €
// price or multi-buy/BOGO terms ("Buy 1 … get 2nd for €1").
// Word-set (Jaccard) similarity, for catching near-duplicate titles that aren't
// an exact substring ("…second for €1" vs "…Second on €1").
function tokenSim(a, b) {
  const tok = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
function campTitleAddsInfo(campTitle, itemName) {
  if (!campTitle) return false;
  const t = campTitle.toLowerCase();
  const norm = String(itemName || "").toLowerCase().replace(/^\d+\.?\s*/, "").trim();
  if (norm && t.includes(norm)) return false;                      // repeats the item name
  if (tokenSim(campTitle, itemName) >= 0.6) return false;          // near-duplicate of the item name
  if (/€\s*\d|\d+(?:[.,]\d+)?\s*€/.test(t)) return true;            // concrete € price
  if (/\b(buy|get|free)\b|δωρε|2nd|second|1\s*\+\s*1/i.test(t)) return true;  // multi-buy / BOGO terms
  return false;  // generic "Save X% … with W+" / "X% off selected items" → drop
}

// How many units a campaign requires before its item_discount applies. A flat
// "amount_per_item" off is only the headline single-item discount when q == 1;
// for a "buy N, the Nth is cheap" deal (e.g. BK "Buy 1 Big King Chicken & Get
// the second for €1") the €-off lands on a basket of N, so pricing one unit at
// price - amount overstates it (the €1.00 / 82% artifact). The reliable signal
// is the structural conditions.basket_contains[].min_quantity — NOT the title,
// because the same "...get the second..." campaign is sometimes bound to the
// single item (price = one unit, needs ×N) and sometimes to a pre-made N-pack
// item (price already = N units, needs ×1); only the qty gate disambiguates.
//   NB: Wolt's "min_quantity" doubles as a spend-gate sentinel (5000, 10000 …) on
//   tiered "up to X%" promos — only values in a sane item-count range count here.
export function campaignRequiredQty(camp) {
  let q = 1;
  for (const b of camp.conditions?.basket_contains || []) {
    const mq = b.min_quantity;
    if (typeof mq === "number" && mq >= 2 && mq <= 50) q = Math.max(q, mq);
  }
  return q;
}

// Pure pricing for one item under an item_discount campaign. Returns the
// {price, original, pct, bundleQty} to surface, or null to skip. Splits the two
// real shapes seen in the wild:
//   - fraction: a genuine per-unit X%-off → price one unit, % is qty-independent.
//   - amount  : a flat €-off. With reqQty ≥ 2 it lands once on the whole bundle,
//     so price the bundle (price×qty − amount), never a single unit (that's the
//     €1.00 / 82% artifact). With reqQty 1 a >70%-of-one-unit flat cut is treated
//     as a misbound "second unit" deal and skipped rather than overstated.
// Extracted as a pure function so every branch is unit-testable without network.
export function computeItemDiscountDeal(priceMinor, { fraction = 0, amount = 0, maxPerItem = null, reqQty = 1 }) {
  if (!priceMinor || priceMinor <= 0) return null;
  if (fraction) {
    let perUnit = Math.round(priceMinor * fraction);
    if (typeof maxPerItem === "number") perUnit = Math.min(perUnit, maxPerItem);
    if (perUnit <= 0) return null;
    return { price: priceMinor - perUnit, original: priceMinor, pct: Math.round((perUnit / priceMinor) * 100), bundleQty: 1 };
  }
  let amt = amount;
  if (typeof maxPerItem === "number") amt = Math.min(amt, maxPerItem);
  if (amt <= 0) return null;
  if (reqQty < 2 && amt / priceMinor > 0.7) return null;  // misbound second-unit guard
  const wasTotal = priceMinor * reqQty;
  if (amt >= wasTotal) return null;  // nonsensical (would imply free / negative)
  return { price: wasTotal - amt, original: wasTotal, pct: Math.round((amt / wasTotal) * 100), bundleQty: reqQty };
}

// Tiered / placeholder item_discount campaigns we can't price to an exact % from
// the assortment: "up to X%" tiers, sentinel spend-gates (min_quantity in the
// thousands), and the fraction≈0 / amount=1 stubs Wolt ships for those. Skipped
// so they never surface as a bogus "0% off" or a misleading headline.
export function isPlaceholderItemDiscount(camp, id) {
  if ((camp.description?.title || "").toLowerCase().includes("up to")) return true;
  for (const b of camp.conditions?.basket_contains || []) {
    if (typeof b.min_quantity === "number" && b.min_quantity >= 1000) return true;
  }
  if (id.fraction != null && id.fraction > 0 && id.fraction < 0.01) return true;
  if (id.amount_per_item != null && id.amount_per_item > 0 && id.amount_per_item <= 1) return true;
  return false;
}

// Run `fn` over `items` with at most `concurrency` in flight at once. Workers
// pull from a shared cursor, so a slow venue never blocks the others (unlike a
// fixed-size Promise.all batch that stalls on its slowest member).
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return out;
}

// Drinks aren't the food the user wants ranked — the UI hides them behind a
// toggle (each deal carries is_drink). Wolt item NAMES are unreliable ("Mango
// dream", "Green reviver" are smoothies with no drink word), so the assortment
// CATEGORY is the primary signal; the name regex is a fallback for flat menus.
const DRINK_CAT = /coffee|καφέ|espresso|cappucc|\blatte\b|\braf\b|\btea\b|τσάι|matcha|μάτσα|juice|χυμ|lemonade|λεμονάδ|smoothie|σμούθι|\bdrinks?\b|beverage|ποτά|αναψυκτ|soft ?drink|\bsoda\b|\bcola\b|cocktail|κοκτέιλ|\bwine\b|κρασ|\bbeer\b|μπύρα|frappe|φραπ|milkshake|\bshake\b/i;
const DRINK_NAME = /espresso|freddo|frappe|frappé|φραπ|cappucc?ino|\blatte\b|λάτε|macchiato|\bmocha\b|americano|nescafe|\bcoffee\b|καφέ|καφε|granita|γρανίτα|milkshake|\bshake\b|\bsmoothie\b|σμούθι|\bjuice\b|χυμ|soft ?drink|αναψυκτικ|\bsoda\b|\bcola\b|coca|pepsi|sprite|fanta|lemonade|λεμονάδ|\btea\b|τσάι|iced tea|\bboba\b|bubble tea|hot chocolate|iced chocolate|ζεστή σοκολάτα|ρόφημα|matcha|μάτσα|cocktail|κοκτέιλ|margarita|mojito|sangria|spritz|aperol|\bwine\b|κρασ|\bbeer\b|μπύρα|tequila|vodka|βότκα|whisky|ουίσκ|flat white|cortado|cold brew|chai|kombucha|prosecco|champagne|cider|\bgin\b|\brum\b|\bspirits?\b|\bcoke\b/i;
const FOOD_WORD = /pizza|πίτσα|burger|μπεργκ|\bpita\b|wrap|sandwich|σάντουιτς|σουβλ|gyro|γύρο|\bcake\b|κέικ|τούρτ|brownie|waffle|βάφλ|crepe|κρεπ|cookie|μπισκ|donut|pancake|tiramisu|pasta|ζυμαρικ|sushi|σαλάτ|salad|chicken|κοτόπουλ|steak|μπιφτ|nugget/i;
const isDrinkName = (s) => DRINK_NAME.test(s || "") && !FOOD_WORD.test(s || "");
const isDrinkCategory = (c) => !!c && DRINK_CAT.test(c) && !/bean|equipment|machine|grinder|accessor/i.test(c);
function buildItemCategoryMap(ass) {
  const m = new Map();
  for (const c of ass.categories || []) for (const iid of c.item_ids || []) if (!m.has(iid)) m.set(iid, c.name);
  return m;
}

// Derive all deals for ONE venue from its already-fetched assortment + dynamic.
// Pure (no I/O) — the network fetch happens in scanVenuesForDiscounts so this
// stays easy to reason about and reuse.
function extractVenueDeals(v, ass, dyn) {
  const results = [];
  const itemsById = new Map();
  for (const it of ass.items || []) itemsById.set(it.id, it);
  const optionsById = new Map((ass.options || []).map((o) => [o.id, o]));

  // Source 1: assortment-level markdowns (original_price > price)
  // W+ tag here only if the item itself is W+-only. v.show_wolt_plus is a
  // venue-level "shown on the W+ feed" flag that's true for ~95% of venues
  // and would over-tag almost every deal as W+.
  for (const item of ass.items || []) {
    if (!item.original_price || item.price >= item.original_price) continue;
    const pct = Math.round(((item.original_price - item.price) / item.original_price) * 100);
    const addons = computeMandatoryAddons(item, optionsById);
    results.push(makeDeal(v, item.name, item.price, item.original_price, pct,
      !!item.is_wolt_plus_only, [], addons, item));
  }

  // Source 2: campaign-based item_discount in venue dynamic (fixed €-off or
  // fraction-off on specific item IDs — e.g. "The Original €8.90", "2 FOR €9").
  for (const camp of dyn?.venue_raw?.discounts || []) {
    const id = camp.effects?.item_discount;
    if (!id) continue;
    // Skip campaigns that are out-of-window right now. Wolt expresses
    // weekly schedules as [start, end) minute offsets where the week
    // starts at Monday 00:00 (Mon = 0–1439, Tue = 1440–2879, …, Sun =
    // 8640–10079). A campaign with restrictions only counts if "now"
    // falls inside at least one window — otherwise it's a future-day
    // promo we shouldn't surface as currently-available.
    const windows = camp.conditions?.weekly_time_restrictions;
    if (Array.isArray(windows) && windows.length) {
      const nowWeekMin = weekMinuteNow();
      const inWindow = windows.some((w) => nowWeekMin >= (w.start || 0) && nowWeekMin < (w.end || 0));
      if (!inWindow) continue;
    }
    if (isPlaceholderItemDiscount(camp, id)) continue;
    const fraction = id.fraction || 0;
    const amountPerItem = id.amount_per_item || 0;
    const maxPerItem = id.max_amount_per_item;  // per-item € cap, when set
    const reqQty = campaignRequiredQty(camp);
    const includeIds = new Set(id.include?.items || []);
    const excludeIds = new Set(id.exclude?.items || []);
    const isWoltPlus = camp.conditions?.has_wolt_plus === true;
    const campTitle = camp.description?.title || null;
    for (const itemId of includeIds) {
      if (excludeIds.has(itemId)) continue;
      const item = itemsById.get(itemId);
      if (!item) continue;
      const priced = computeItemDiscountDeal(item.price, { fraction, amount: amountPerItem, maxPerItem, reqQty });
      if (!priced) continue;
      const addons = computeMandatoryAddons(item, optionsById);
      const wp = isWoltPlus || !!item.is_wolt_plus_only;
      const baseName = priced.bundleQty >= 2 ? `Buy ${priced.bundleQty} ${item.name}` : item.name;
      const dealName = campTitleAddsInfo(campTitle, item.name) ? `${baseName} — ${campTitle}` : baseName;
      results.push(makeDeal(v, dealName, priced.price, priced.original, priced.pct,
        wp, [campTitle || camp.id].filter(Boolean), addons, item));
    }
  }

  // Source 3: free_items BOGO campaigns ("Add 2 X, Pay for 1").
  // Reports the per-piece effective price (item.price × buy / (buy+get))
  // and surfaces the exact item name + campaign title so the user knows
  // WHICH item is on offer, not just "Buy 2 Pay 1".
  for (const camp of dyn?.venue_raw?.discounts || []) {
    const fi = camp.effects?.free_items;
    if (!fi) continue;
    const buy = fi.buy || 0;
    const get = fi.get || 0;
    const totalUnits = buy + get;
    if (get <= 0 || totalUnits <= 0) continue;
    const includeIds = new Set(fi.include?.items || []);
    const excludeIds = new Set(fi.exclude?.items || []);
    const isWoltPlus = camp.conditions?.has_wolt_plus === true;
    const pct = Math.round((get / totalUnits) * 100);
    const campTitle = camp.description?.title || `Buy ${totalUnits} pay ${buy}`;
    for (const itemId of includeIds) {
      if (excludeIds.has(itemId)) continue;
      const item = itemsById.get(itemId);
      if (!item) continue;
      const effectivePerUnit = Math.round((item.price * buy) / totalUnits);
      const normName = item.name.toLowerCase().replace(/^\d+\.?\s*/, "").trim();
      const dealName = campTitle.toLowerCase().includes(normName)
        ? campTitle
        : `${campTitle} (${item.name})`;
      const fiAddons = computeMandatoryAddons(item, optionsById);
      results.push(makeDeal(v, dealName, effectivePerUnit, item.price, pct,
        isWoltPlus || !!item.is_wolt_plus_only,
        [campTitle], fiAddons, item));
    }
  }
  // Flag beverage deals so the UI can hide them by default — assortment category
  // first (reliable), item/deal name as fallback.
  const id2cat = buildItemCategoryMap(ass);
  for (const d of results) {
    const cat = d.item_id ? id2cat.get(d.item_id) : null;
    d.is_drink = isDrinkCategory(cat) || isDrinkName(d.item_name || d.name);
  }
  return results;
}

// Fetch + extract deals across many venues with bounded concurrency. Each venue
// needs two independent requests (assortment + dynamic) — they run in parallel,
// and up to `concurrency` venues are processed at once, so wall time is roughly
// (venues / concurrency) × round-trip instead of venues × 2 × round-trip. The
// 429 backoff in fetchWithRetry keeps us inside Wolt's rate limit.
async function scanVenuesForDiscounts(venues, limit, addr, concurrency = 8, onBatch = null) {
  const top = venues.slice(0, limit);
  const failed = [];
  let done = 0;
  const perVenue = await mapPool(top, concurrency, async (v) => {
    let dealsForVenue = [];
    try {
      const [ass, dyn] = await Promise.all([
        fetchWithRetry("assortment", { venue_slug: v.slug }),
        fetchWithRetry("venue_dynamic", { venue_slug: v.slug, lat: addr.lat, lon: addr.lon }).catch(() => null),
      ]);
      dealsForVenue = extractVenueDeals(v, ass, dyn);
      return dealsForVenue;
    } catch (e) {
      failed.push({ slug: v.slug, err: (e.message || "").slice(0, 80) });
      return [];
    } finally {
      done++;
      if (onBatch) onBatch(dealsForVenue, { done, total: top.length });
      if (done % 10 === 0) process.stderr.write(`scanned ${done}/${top.length} venues (${failed.length} failed)...\r`);
    }
  });
  process.stderr.write("\n");
  if (failed.length) {
    process.stderr.write(`${failed.length} venues failed (rate limit / 404 / etc).\n`);
  }
  return perVenue.flat();
}

// --- single-venue debug ----------------------------------------------------
//
// Scan ONE venue (by slug) without re-fetching the whole area. Useful when a
// deal in the full run looks wrong and you want to see exactly what the scanner
// derives — and the raw assortment/campaign JSON behind it — for that venue.
//   --venue <slug>            print every parsed deal for the venue (no food/min filter)
//   --venue <slug> --item X   only items/campaigns whose name (or id) contains X
//   --venue <slug> --dump     dump raw assortment items + venue_dynamic campaigns
//   --venue <slug> --json     parsed deal objects as JSON
async function debugVenue(slug, addr, opts) {
  const needle = opts.item ? String(opts.item).toLowerCase() : null;
  const matchItem = (it) =>
    !needle || String(it.name || "").toLowerCase().includes(needle) || String(it.id || "").toLowerCase() === needle;

  // Enrich the synthetic venue from venue_static so deals carry name/rating/currency.
  const v = { slug, name: slug, currency: "EUR", id: null, show_wolt_plus: false };
  try {
    const st = await woltFetch("venue_static", { venue_id_or_slug: slug });
    const venue = st?.venue || st?.results?.[0]?.venue || st?.results?.[0] || null;
    if (venue) {
      v.id = venue.id || v.id;
      v.name = (typeof venue.name === "string" ? venue.name : venue.name?.[0]?.value) || v.name;
      v.rating = venue.rating?.score ?? v.rating;
      v.product_line = venue.product_line || v.product_line;
      v.currency = venue.currency || v.currency;
      v.estimate = venue.estimate_range || (venue.estimate ? `${venue.estimate} min` : undefined);
      v.show_wolt_plus = venue.show_wolt_plus ?? v.show_wolt_plus;
    }
  } catch (e) {
    process.stderr.write(`venue_static failed (${(e.message || "").slice(0, 80)}) — continuing with slug only\n`);
  }

  if (opts.dump) {
    const ass = await woltFetch("assortment", { venue_slug: slug });
    const dyn = await woltFetch("venue_dynamic", { venue_slug: slug, lat: addr.lat, lon: addr.lon }).catch(() => null);
    const items = (ass.items || []).filter(matchItem);
    const matchIds = new Set(items.map((it) => it.id));
    const campaigns = (dyn?.venue_raw?.discounts || []).filter((c) => {
      if (!needle) return true;
      const ids = new Set([
        ...(c.effects?.item_discount?.include?.items || []),
        ...(c.effects?.free_items?.include?.items || []),
      ]);
      return [...ids].some((id) => matchIds.has(id)) || String(c.description?.title || "").toLowerCase().includes(needle);
    });
    const out = {
      venue: v,
      items: items.map((it) => ({ id: it.id, name: it.name, price: it.price, original_price: it.original_price, base_price: it.base_price, is_wolt_plus_only: it.is_wolt_plus_only })),
      campaigns,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  let deals = await scanVenuesForDiscounts([v], 1, addr);
  if (needle) deals = deals.filter((d) => String(d.name || "").toLowerCase().includes(needle) || String(d.item_id || "").toLowerCase() === needle || String(d.item_name || "").toLowerCase().includes(needle));
  if (opts.json) {
    process.stdout.write(JSON.stringify(deals, null, 2) + "\n");
    return;
  }
  console.log(`Debug scan of ${v.name} (${slug})${needle ? `, item~"${opts.item}"` : ""} — ${deals.length} parsed deal(s):\n`);
  deals.sort((a, b) => (b.discount_percentage || 0) - (a.discount_percentage || 0));
  for (const d of deals) {
    const tag = d.is_wolt_plus ? "[W+]" : "[  ]";
    const pct = fmtPercent(d.discount_percentage).padStart(5);
    const price = d.price_minor !== null ? fmtMoney(d.price_minor, d.currency) : "?";
    const orig = d.original_minor ? ` (was ${fmtMoney(d.original_minor, d.currency)})` : "";
    const badges = d.badges?.length ? `  {${d.badges.join(" | ")}}` : "";
    console.log(`${tag} ${pct} off  ${price}${orig}  ${d.name}  [item ${d.item_id || "-"}]${badges}`);
  }
  if (!deals.length) console.log("(no discounted items/campaigns parsed for this venue)");
}

function makeDeal(v, name, priceMinor, originalMinor, pct, isWoltPlus, badges, addons, item) {
  const a = addons || { addon_minor: 0, breakdown: [] };
  // Wolt cascades the per-item discount to the mandatory option add-ons at
  // checkout (verified empirically: Pizza Hut "Loaded Garden Supreme" pizza
  // with size=medium prices to €6.45 + 60% of €6.90 = €10.59, matching the
  // checkout cart). So the realistic minimum total is the already-discounted
  // base plus the add-on discounted by the same fraction.
  const discountedAddon = Math.round(a.addon_minor * (1 - (pct || 0) / 100));
  return {
    name,
    item_id: item?.id ? String(item.id) : null,
    item_name: item?.name || null,
    image: item?.images?.[0]?.url || null,
    venue_name: v.name,
    venue_slug: v.slug,
    venue_id: v.id,
    product_line: v.product_line || null,
    eta: v.estimate,
    rating: v.rating,
    price_minor: priceMinor,
    original_minor: originalMinor,
    currency: v.currency,
    discount_percentage: pct,
    is_wolt_plus: isWoltPlus,
    badges,
    mandatory_addon_minor: a.addon_minor,
    mandatory_addon_discounted_minor: discountedAddon,
    mandatory_addon_breakdown: a.breakdown,
    effective_min_minor: priceMinor + discountedAddon,
  };
}

// --- ranking ---------------------------------------------------------------

// Discount band — the PRIMARY ranking key, in 10-point steps (62%→6, 40%→4,
// 35%→3, 30%→3). A higher band always ranks first, Wolt+ or not; W+ only breaks
// ties WITHIN the same 10-pt band (see rankDeals). Same exact % ⇒ same band ⇒ W+
// wins the tie.
function discountBand(pct) {
  return Math.floor((pct || 0) / 10);
}

// Cross-provider venue join key: first two significant words, normalized. Must
// match bolt.mjs venueKey() so "Burger King Makariou" ≈ "Burger King".
function unifiedVenueKey(name) {
  return String(name || "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").filter(Boolean).slice(0, 2).join(" ");
}

// Left-column tag: just the Wolt+ flag. The exact discount is already in the
// "% off" column, so the tag only carries what that column doesn't — W+ membership.
function dealTag(deal) {
  return deal.is_wolt_plus ? "[W+]" : "[  ]";
}

// Build the canonical Wolt venue URL: https://wolt.com/en/{country}/{city}/{seg}/{slug}.
// The path SEGMENT is vertical-specific (verified by curl): restaurants resolve
// only under /restaurant/, every other (grocery) vertical only under /venue/ —
// the wrong segment 301s to a 404, and the slug-only /en/venue/{slug} form is dead
// too. `cityCtx` (country + city slug) comes from the promotions response's
// page-level `city_data`; all nearby venues share it. Unknown product_line
// defaults to "restaurant" (the dominant vertical).
function venueUrl(deal, cityCtx) {
  if (!deal.venue_slug || !cityCtx?.city || !cityCtx?.country) return null;
  const seg = String(deal.product_line || "").toLowerCase() === "grocery" ? "venue" : "restaurant";
  return `https://wolt.com/en/${cityCtx.country}/${cityCtx.city}/${seg}/${deal.venue_slug}`;
}

// Deep link straight to the discounted item: {venueUrl}/{item-slug}-itemid-{id}.
// Wolt's item slug is the slugified item name (lowercase, non-alphanumeric runs
// collapsed to "-"), e.g. "Halloumi Portion" → halloumi-portion-itemid-60f9....
function itemUrl(deal, cityCtx) {
  const base = venueUrl(deal, cityCtx);
  if (!base || !deal.item_id || !deal.item_name) return null;
  const slug = String(deal.item_name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base}/${slug ? slug + "-" : ""}itemid-${deal.item_id}`;
}

// Country + city slug for canonical URLs, pulled from the promotions page's
// top-level city_data (one city per query — Wolt only returns venues near the
// queried address). Null if absent → URLs are omitted rather than wrong.
function cityCtxFromPromo(promo) {
  const cd = promo?.city_data;
  if (!cd?.slug) return null;
  return { country: String(cd.country_code_alpha3 || "").toLowerCase(), city: cd.slug };
}

// When the same campaign appears at multiple branches of the same chain (e.g.
// 6 Bean Bar locations each running "Add 2 Nicaragu Capsules Pay 1"), collapse
// them to a single representative row with a "(+N more locations)" hint.
// Heuristic: same deal name + same discount % + same per-unit price + shared
// venue-name prefix (first 2 words).
function collapseChainDuplicates(deals) {
  const prefixOf = (s) => String(s || "").split(/\s+/).slice(0, 2).join(" ").toLowerCase();
  const groups = new Map();
  for (const d of deals) {
    const key = `${d.name}\t${d.discount_percentage}\t${d.price_minor ?? ""}`;
    const arr = groups.get(key) || [];
    arr.push(d);
    groups.set(key, arr);
  }
  const out = [];
  for (const grp of groups.values()) {
    if (grp.length === 1) { out.push(grp[0]); continue; }
    const refPrefix = prefixOf(grp[0].venue_name);
    const sameChain = refPrefix && grp.every((d) => prefixOf(d.venue_name) === refPrefix);
    if (!sameChain) { out.push(...grp); continue; }
    grp.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const rep = { ...grp[0] };
    rep._chain_count = grp.length;
    rep._chain_other_venues = grp.slice(1).map((d) => d.venue_name);
    out.push(rep);
  }
  return out;
}

function rankDeals(deals, banlist, minDiscount) {
  const seen = new Set();
  const food = deals
    .filter((d) => isFood(d.name, banlist))
    .filter((d) => d.discount_percentage >= minDiscount)
    .filter((d) => {
      const k = `${d.venue_id || d.venue_slug}::${d.name}::${d.discount_percentage}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  food.sort((a, b) => {
    // Discount band is primary: a better discount always ranks higher, W+ or not.
    const ba = discountBand(a.discount_percentage);
    const bb = discountBand(b.discount_percentage);
    if (ba !== bb) return bb - ba;
    // Within a band, prefer Wolt+...
    if (a.is_wolt_plus !== b.is_wolt_plus) return a.is_wolt_plus ? -1 : 1;
    // ...then larger exact discount, larger saving, higher rating.
    if (b.discount_percentage !== a.discount_percentage) return b.discount_percentage - a.discount_percentage;
    const sa = (a.original_minor || 0) - (a.price_minor || 0);
    const sb = (b.original_minor || 0) - (b.price_minor || 0);
    if (sb !== sa) return sb - sa;
    return (b.rating || 0) - (a.rating || 0);
  });
  return food;
}

// --- main ------------------------------------------------------------------

function parseArgs() {
  const a = process.argv.slice(2);
  const flag = (n, dflt = null) => {
    const i = a.indexOf(n);
    return i < 0 ? dflt : a[i + 1];
  };
  return {
    lat: flag("--lat") ? parseFloat(flag("--lat")) : null,
    lon: flag("--lon") ? parseFloat(flag("--lon")) : null,
    address: flag("--address"),                   // e.g. "Home", "Office" — substring match on saved alias
    listAddresses: a.includes("--list-addresses"),
    venue: flag("--venue"),                        // debug: scan a single venue slug instead of the whole area
    item: flag("--item"),                          // debug: with --venue, filter to items/campaigns matching this name substring or id
    minDiscount: parseFloat(flag("--min-discount", "30")),
    floor: parseFloat(flag("--floor", "15")),
    limit: parseInt(flag("--limit", "5000"), 10),  // effectively no cap — show every deal
    json: a.includes("--json"),
    dump: a.includes("--dump"),
    scan: !a.includes("--no-scan"),
    scanLimit: parseInt(flag("--scan-limit", "150"), 10),
    scanConcurrency: parseInt(flag("--scan-concurrency", "12"), 10),  // venue worker pool size — enough to keep the rate cap saturated through slow (large grocery) responses; the rate gate, not this, bounds req/s
    scanRps: parseFloat(flag("--scan-rps", "6.4")),  // request/sec cap — measured API ceiling (~6.6) minus 2%
    stream: a.includes("--stream"),                  // emit NDJSON events live as venues are scanned (consumed by serve.mjs)
    blindTopK: parseInt(flag("--blind-top", "100"), 10),  // closest-N venues to also scan blindly (catches unbadged markdowns)
    showUnparsed: a.includes("--show-unparsed"),
  };
}

async function resolveAddress(opts, auth) {
  if (opts.lat && opts.lon) {
    return { lat: opts.lat, lon: opts.lon, alias: `${(+opts.lat).toFixed(4)}, ${(+opts.lon).toFixed(4)}` };
  }
  if (opts.address || opts.listAddresses) {
    const info = await woltFetch("addresses");
    const list = (info.results || []).map((a) => {
      const c = a.location.user_coordinates.coordinates;
      return { id: a.id, alias: a.alias, city: a.location.city, lat: c[1], lon: c[0] };
    });
    if (opts.listAddresses) {
      for (const a of list) console.log(`  ${(a.alias || "(no alias)").padEnd(30)} ${a.city || ""}  lat=${a.lat.toFixed(4)} lon=${a.lon.toFixed(4)}`);
      process.exit(0);
    }
    const needle = opts.address.toLowerCase();
    const matches = list.filter((a) => (a.alias || "").toLowerCase().includes(needle));
    if (!matches.length) {
      const aliases = list.map((a) => a.alias).filter(Boolean).join(", ");
      throw new Error(`No saved address alias contains "${opts.address}". Known: ${aliases}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple addresses match "${opts.address}": ${matches.map((m) => m.alias).join(", ")}. Be more specific.`,
      );
    }
    return matches[0];
  }
  if (!auth.work_address) {
    throw new Error(
      "No address. Either pass --address <alias> / --lat --lon, or run " +
        "bin/set-address.mjs to persist a default.",
    );
  }
  return auth.work_address;
}

async function main() {
  const opts = parseArgs();
  if (Number.isFinite(opts.scanRps) && opts.scanRps > 0) scanMaxRps = opts.scanRps;
  if (opts.showUnparsed) {
    await showUnparsedSummary();
    return;
  }
  const auth = await loadAuth();
  const addr = await resolveAddress(opts, auth);

  if (opts.venue) {
    await debugVenue(opts.venue, addr, opts);
    return;
  }

  const promo = await woltFetch("promotions", { lat: addr.lat, lon: addr.lon });
  if (opts.dump) {
    process.stdout.write(JSON.stringify(promo, null, 2) + "\n");
    return;
  }
  const banlist = await loadBanlist();
  const cityCtx = cityCtxFromPromo(promo);

  // --stream: emit NDJSON events on stdout as the scan progresses, so serve.mjs
  // can render live cards. Food + ≥ floor filtered, deduped, with image + links.
  // Unified cross-provider fields (provider/rating10/venue_key) are added so the
  // viewer can merge Wolt + Bolt and join by venue. Wolt rating is already /10.
  const unify = (d) => ({
    ...d, provider: "wolt", rating_scale: 10, rating10: d.rating ?? null,
    venue_key: unifiedVenueKey(d.venue_name),
    is_plus: !!d.is_wolt_plus, plus_label: d.is_wolt_plus ? "W+" : null,
    venue_url: venueUrl(d, cityCtx), item_url: itemUrl(d, cityCtx),
  });
  const streamEmit = opts.stream ? (obj) => process.stdout.write(JSON.stringify(obj) + "\n") : null;
  const streamSeen = new Set();
  const onStreamBatch = opts.stream
    ? (venueDeals, prog) => {
        for (const d of venueDeals) {
          if (!isFood(d.name, banlist)) continue;
          if ((d.discount_percentage || 0) < opts.floor) continue;
          const key = `${d.venue_slug}::${d.name}::${d.discount_percentage}`;
          if (streamSeen.has(key)) continue;
          streamSeen.add(key);
          streamEmit({ type: "deal", deal: unify(d) });
        }
        streamEmit({ type: "progress", done: prog.done, total: prog.total });
      }
    : null;
  if (opts.stream) streamEmit({ type: "start", address: addr.alias || "Work", lat: addr.lat, lon: addr.lon, provider: "wolt" });

  let deals = extractFromPromotionsTree(promo, banlist);

  // Venue-level deals parsed from venue.promotions[].text badges. Cheap (no extra
  // HTTP) — these are why the promotions-near-you page exists.
  let { deals: venueLevel, unparsed } = extractVenueLevelDeals(promo, banlist);
  deals = deals.concat(venueLevel);
  // Unparsed-badge logging is deferred until after the optional --scan pass so we
  // can reconcile: a badge whose % we couldn't parse from text is "resolved" when
  // the deeper scan derived a real % from that venue's assortment / campaigns.
  let scanPctBySlug = null;

  if (opts.scan) {
    // Hybrid candidate list:
    //   (a) Venues advertising ≥ minDiscount in promotions-near-you (high-signal).
    //   (b) Top-K closest venues by distance (catches assortment-level markdowns
    //       that Wolt doesn't badge — e.g. Pitta & More-style hidden 50% deals).
    const promoCands = pickScanCandidatesFromPromotions(promo, opts.minDiscount, banlist);
    const distanceCands = await nearbyVenuesByDistance(addr, banlist, opts.scanLimit);
    const blindTopK = Math.min(distanceCands.length, opts.blindTopK);
    const merged = new Map();
    for (const v of promoCands) merged.set(v.slug || v.id, v);
    for (const v of distanceCands.slice(0, blindTopK)) {
      const k = v.slug || v.id;
      if (!merged.has(k)) merged.set(k, v);
    }
    const candidates = [...merged.values()];
    const primary = candidates.slice(0, opts.scanLimit);
    process.stderr.write(
      `Scanning ${primary.length} venues ` +
      `(${promoCands.length} promo-tagged + ${blindTopK} closest by distance, deduped)...\n`,
    );
    let scanned = await scanVenuesForDiscounts(primary, primary.length, addr, opts.scanConcurrency, onStreamBatch);
    // Second pass: venues whose badge would survive as a vague venue-level row
    // ("Add 2 Pay for 1 — ?") because the scan cap cut them off before they were
    // scanned. Scan just those so the output names the concrete discounted items.
    const primarySlugs = new Set(primary.map((v) => v.slug));
    const unresolvedSlugs = new Set(
      venueLevel
        .filter((d) => d.discount_percentage >= opts.minDiscount && d.venue_slug && !primarySlugs.has(d.venue_slug))
        .map((d) => d.venue_slug),
    );
    const secondPass = candidates.filter((v) => unresolvedSlugs.has(v.slug)).slice(0, 30);
    if (secondPass.length) {
      process.stderr.write(`Second pass: ${secondPass.length} badge venues missed by the scan cap...\n`);
      scanned = scanned.concat(await scanVenuesForDiscounts(secondPass, secondPass.length, addr, opts.scanConcurrency, onStreamBatch));
    }
    deals = deals.concat(scanned);
    // Dedupe: if scan surfaced concrete items from a venue, drop the vague
    // venue-level badges ("30% off selected items", "Save X% with W+") — the
    // scanned items name the exact deals and their prices, which is what the
    // user actually wants.
    const venuesWithScannedItems = new Set(
      scanned.map((d) => d.venue_id || d.venue_slug).filter(Boolean),
    );
    deals = deals.filter((d) => {
      if (!d.venue_level) return true;
      const key = d.venue_id || d.venue_slug;
      if (venuesWithScannedItems.has(key)) return false;  // superseded by concrete scanned items
      // Otherwise it's an unresolved badge with no concrete item ("Add 2 Pay 1 on
      // selected items", "X% off selected items") — too vague to show: the offer
      // could be on items you don't care about (e.g. 2 coffees). Only surface
      // deals whose actual items the scan named. Item-level rows (price set) stay.
      return d.price_minor != null;
    });
    // Per-venue best % the scan actually derived (slug-keyed — unparsed badge
    // records carry venue_slug). Used below to resolve text badges we couldn't parse.
    scanPctBySlug = new Map();
    for (const d of scanned) {
      if (!d.venue_slug) continue;
      const cur = scanPctBySlug.get(d.venue_slug) || 0;
      if ((d.discount_percentage || 0) > cur) scanPctBySlug.set(d.venue_slug, d.discount_percentage || 0);
    }
  }

  // Reconcile unparsed badges against scan-derived %s, then log only the
  // genuinely-underivable remainder (whole-order "X € off", fixed-price bundles
  // with no original_price / campaign). A badge for a venue the scan priced has
  // its % derived there — no parser rule needed.
  const resolvedBadges = [];
  if (scanPctBySlug) {
    const still = [];
    for (const u of unparsed) {
      const dp = u.venue_slug && scanPctBySlug.has(u.venue_slug) ? scanPctBySlug.get(u.venue_slug) : null;
      if (dp != null) resolvedBadges.push({ ...u, derived_pct: dp });
      else still.push(u);
    }
    unparsed = still;
  }
  // Only record/announce genuinely-unparsed badges in --scan mode: that's when we
  // actually attempted to derive the % from the assortment and failed. Without
  // --scan, a badge with no % in its text isn't a parser gap — it just needs a
  // scan — so logging it would spam the review log with scan-resolvable venues.
  if (opts.scan) {
    await recordUnparsedBadges(unparsed);
    if (unparsed.length) {
      process.stderr.write(
        `(logged ${unparsed.length} unparsed badge${unparsed.length === 1 ? "" : "s"} — review with --show-unparsed)\n`,
      );
    }
  }
  if (resolvedBadges.length) {
    const ex = resolvedBadges
      .slice(0, 3)
      .map((r) => `${JSON.stringify(r.text)} → ${r.derived_pct}% @ ${r.venue_name}`)
      .join("; ");
    process.stderr.write(
      `(derived % via scan for ${resolvedBadges.length} venue badge${resolvedBadges.length === 1 ? "" : "s"}: ${ex})\n`,
    );
  }

  // Tiered fallback: try --min-discount first; if empty, fall through 25, 20,
  // --floor in steps. Skip a tier if it equals a higher one already tried.
  const tiers = Array.from(new Set([opts.minDiscount, 25, 20, opts.floor]
    .filter((n) => Number.isFinite(n) && n > 0 && n <= opts.minDiscount)
    .sort((a, b) => b - a)));
  let ranked = [];
  let usedFloor = tiers[0];
  for (const t of tiers) {
    ranked = collapseChainDuplicates(rankDeals(deals, banlist, t)).slice(0, opts.limit);
    if (ranked.length) { usedFloor = t; break; }
  }
  // Attach canonical venue URLs (consumed by --json clients like screenshots.mjs
  // and printed below). cityCtx (city_data, page-level) computed once up top.
  for (const d of ranked) {
    d.venue_url = venueUrl(d, cityCtx);
    d.item_url = itemUrl(d, cityCtx);
  }
  if (opts.stream) {
    // Final canonical (ranked + chain-collapsed) set — serve.mjs swaps the live
    // cards for this so the page matches the CLI output exactly.
    streamEmit({ type: "done", deals: ranked.map(unify), provider: "wolt", usedFloor, minDiscount: opts.minDiscount });
    return;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(ranked, null, 2) + "\n");
    return;
  }
  console.log(`Deals near ${addr.alias || "Work"} (lat ${addr.lat.toFixed(4)}, lon ${addr.lon.toFixed(4)}):\n`);
  if (!ranked.length) {
    const promotionsEmpty = (promo.sections || []).every((s) => s.template === "no-content" || !s.items?.length);
    if (promotionsEmpty && !opts.scan) {
      console.log("Wolt's promotions-near-you page shows no current deals here.");
      console.log("Run without --no-scan to scan nearby venue menus for discounted items.");
    } else {
      console.log(`No food deals ≥ ${opts.floor}% found. Try lower --floor or different coords.`);
    }
    return;
  }
  if (usedFloor < opts.minDiscount) {
    console.log(`(No deals ≥ ${opts.minDiscount}% — showing ≥ ${usedFloor}% fallback)\n`);
  }
  for (const d of ranked) {
    const tag = dealTag(d);
    const pct = fmtPercent(d.discount_percentage).padStart(5);
    const price = d.price_minor !== null ? fmtMoney(d.price_minor, d.currency) : "?";
    const orig = d.original_minor ? ` (was ${fmtMoney(d.original_minor, d.currency)})` : "";
    const rating = d.rating ? ` ⭑${d.rating.toFixed(1)}` : "";
    const eta = d.eta ? ` ${d.eta}` : "";
    const chain = d._chain_count ? ` (+${d._chain_count - 1} more locations)` : "";
    const venue = d.venue_name ? ` — ${d.venue_name}${chain}` : "";
    const link = (d.item_url || d.venue_url) ? `\n        ${d.item_url || d.venue_url}` : "";
    const addon = d.mandatory_addon_minor
      ? ` (+${fmtMoney(d.mandatory_addon_minor, d.currency)} required — ${
          (d.mandatory_addon_breakdown || []).map((b) => `${b.group}: ${b.value}`).join("; ")
        }; min total ${fmtMoney(d.effective_min_minor, d.currency)})`
      : "";
    console.log(`${tag} ${pct} off  ${price}${orig}${addon}${rating}${eta}  ${d.name}${venue}${link}`);
  }
}

// Only auto-run when executed directly (`node deals.mjs …`); stay quiet when
// imported (e.g. by deals.test.mjs) so the pure helpers above are testable.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.stack || e.message || e);
    process.exit(1);
  });
}
