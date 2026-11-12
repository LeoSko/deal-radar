#!/usr/bin/env node
// Foody (foody.com.cy = efood/Delivery Hero) deal scanner — sibling of
// deals.mjs (Wolt) / bolt.mjs. Emits the unified deal shape + NDJSON stream so
// serve.mjs can merge all three. ITEM-LEVEL: the venue badge ("1+1", "30%+")
// is too coarse (often a coffee BOGO), so we pull each offer-venue's catalog
// (public GET /v3/shops/catalog) and extract the real `category.offers[]` — the
// actual discounted item + its price.
//
//   node foody.mjs                 # ranked table
//   node foody.mjs --json
//   node foody.mjs --stream        # NDJSON: start / deal / progress / done
//   node foody.mjs --scan-limit 40 # cap venues scanned (default 150)
//   node foody.mjs --all-items     # also emit the plain (non-offer) menu items
import { readFile } from "node:fs/promises";
import { configPath } from "../lib/config.mjs";
import { venueKey } from "../lib/venue-key.mjs";
import { mapPool } from "../lib/pool.mjs";
import { eur } from "../lib/format.mjs";
import { cliArgs, feedScanArgs, runIfMain } from "../lib/cli.mjs";
import { offerPriceEur } from "../lib/foody-offer.mjs";

const AUTH_PATH = configPath("foody_auth.json");
const ALL_ITEMS_PER_VENUE_CAP = 200;   // bound payload on large (grocery-ish) menus

function parseArgs() {
  const args = cliArgs();
  return {
    ...feedScanArgs(args),
    scanLimit: parseInt(args.flag("--scan-limit", "150"), 10),   // cover all offer venues (~130)
    concurrency: parseInt(args.flag("--scan-concurrency", "6"), 10),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Discount % for a catalog offer. The authoritative source is `offer.discount`
// (a 0..1 fraction): 0.5 → 50, 0.25 → 25, 0 → no % discount (fixed-price combo,
// e.g. "Jacket Potato €7.95") → null/skip. We do NOT parse the title — its
// wording ("1+1", "buy 1 get 2nd…") overstates vs the real fraction (that bug
// listed a 25%-off pizza as 50%). Title is a last-resort fallback only when the
// field is absent.
function offerPct(offer) {
  const d = offer.discount;
  if (typeof d === "number") return d > 0 ? Math.round(d * 100) : null;
  const t = `${offer.title || ""} ${offer.tag || ""}`.toLowerCase();
  const m = t.match(/(\d{1,2})\s*%/);
  if (m) return parseInt(m[1], 10);
  if (/δώρο|δωρε|1\s*\+\s*1|buy\s*1[^]*free|get\s*1\s*free|one plus one|ακόμη\s*1/.test(t)) return 50;
  return null;
}

// Unix-second stamp of this scan; Foody venue URLs carry it as ?t= to pin the
// page to the menu snapshot we scanned (matches the app's link format).
const scanT = Math.floor(Date.now() / 1000);
function offerItem(offer) {
  const fromTiers = (offer.tiers || []).flatMap((t) => t.items || []);
  return fromTiers[0] || (offer.items || [])[0] || null;
}

// Beverage-only offers (coffee / frappe / granita / milkshake / cocktail BOGOs)
// aren't food deals — drop them (Wolt does this via its banlist). Matched on the
// offer's subject item so café FOOD (e.g. garlic bread, sandwiches) still shows.
const DRINK = /espresso|freddo|frappe|frappé|φραπ|cappucc?ino|καπουτσ|\blatte\b|λάτε|macchiato|\bmocha\b|μόκα|americano|nescafe|νεσκαφ|\bcoffee\b|καφέ|καφε|\bγρανίτα|granita|γρανιτ|milkshake|μιλκσέ|\bshake\b|\bsmoothie\b|σμούθι|\bjuice\b|χυμ|soft ?drink|αναψυκτικ|\bsoda\b|\bcola\b|coca|pepsi|sprite|fanta|\bwater\b|νερό|\bbeer\b|μπύρα|μπυρα|\bwine\b|κρασ|cocktail|κοκτέιλ|margarita|mojito|μοχίτο|sangria|spritz|aperol|lemonade|λεμονάδ|\btea\b|τσάι|τσαι|iced tea|\bboba\b|bubble tea|hot chocolate|ζεστή σοκολάτα|ρόφημα|beverage|σφηνάκ|tequila|tequila|vodka|βότκα|whisky|ουίσκ/i;
// Guard against food items that merely contain a drink word ("Margarita Pizza",
// "Mojito Cake") — if a clear food word is present it's not a drink.
const NOT_DRINK = /pizza|πίτσα|πιτσα|pinsa|burger|μπεργκ|\bpita|σκεπαστ|\bwrap\b|sandwich|σάντουιτς|σουβλ|gyro|γύρο|cake|κέικ|τούρτ|brownie|waffle|βάφλ|crepe|κρεπ|cookie|μπισκ|donut|pancake|tiramisu|μπακλαβ|παγωτ|pasta|ζυμαρικ|\bbao\b|sushi|σαλάτ|salad|chicken|κοτόπουλ/i;
const isDrink = (s) => DRINK.test(s || "") && !NOT_DRINK.test(s || "");

function parseEta(s) { const m = String(s || "").match(/(\d+).*?(\d+)/); return m ? `${m[1]}-${m[2]}` : null; }
// slug is "/<city>/<name>-<id>" → https://www.foody.com.cy/delivery/<city>/<name>-<id>?t=<scan epoch>
function slugToUrl(slug) { return slug ? `https://www.foody.com.cy/delivery${slug}?t=${scanT}` : null; }

function collectShopCards(data) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "card:1.0:shop") out.push(n);
    if (n.components) walk(n.components);
  };
  walk(data?.components || []);
  return out;
}
function cardToVenue(card) {
  const a = card.attributes || {};
  return {
    shop_id: a.shop_id, name: a.title, slug: a.slug, category: a.category,
    rating: a.ratings?.average ?? null, cover: a.cover || a.logo || null,
    eta: parseEta(a.messages?.delivery_eta),
    is_open: a.is_open !== false,  // availability — only scan venues open right now
  };
}

// The venue half of a Foody deal, the same on an offer and on a plain menu item.
function venueFields(venue) {
  return {
    venue_name: venue.name,
    venue_key: venueKey(venue.name),
    venue_id: String(venue.shop_id),
    cuisine: venue.category || null,   // Foody's own taxonomy (Greek) — drives classification
    eta: venue.eta,
    rating: venue.rating,
    rating_scale: 5,
    rating10: venue.rating != null ? +(venue.rating * 2).toFixed(1) : null,
    item_url: slugToUrl(venue.slug),
    venue_url: slugToUrl(venue.slug),
  };
}

// How a Foody offer is priced. Only EXPLICIT "X% off <item>" offers (title states a %)
// get a computed price — there the representative item IS the subject. Named meal deals
// ("Deal on Fire King") and bundles cover several items / sizes, so item.price ×
// discount is NOT a real menu price (that fabricated a €1.70 burger). Those carry
// Foody's own computed "from" price (offer.calculated_price, already discounted), with
// the pre-discount original backed out of the offer %, and a real reference item.
function offerPricing(offer, item, pct) {
  const title = (offer.title || "").replace(/\s+/g, " ").trim();
  const origMinor = eur(item?.price ?? item?.original_price ?? null);
  const isBundle = /bundle|for \d|feast|cup|combo|platter|sharing|party|\bbox\b|meal deal|μερίδ/i.test(title);
  if (!isBundle && /\d{1,2}\s*%|έκπτωσ/i.test(title) && origMinor != null) {
    return { name: item?.name || title, price_minor: Math.round(origMinor * (1 - pct / 100)), original_minor: origMinor, headline: title };
  }
  const itemRef = item ? item.name + (item.price != null ? ` · €${item.price.toFixed(2)}` : "") : null;
  const price = eur(offerPriceEur(offer.calculated_price));
  return {
    name: title || item?.name,
    price_minor: price,
    original_minor: price != null ? Math.round(price / (1 - pct / 100)) : null,
    headline: isBundle && itemRef ? "incl. " + itemRef : itemRef,
  };
}

function offerDeal(offer, venue, pct) {
  const item = offerItem(offer);
  const isPro = offer.tag === "pro deals";  // Foody Pro (subscription) deal — rank like W+
  return {
    provider: "foody",
    ...offerPricing(offer, item, pct),
    item_name: item?.name || null,
    offer_id: offer.id != null ? String(offer.id) : null,   // the offer's identity: an offer deal has no item id
    image: offer.images?.menu || item?.images?.menu || venue.cover || null,
    ...venueFields(venue),
    currency: "EUR",
    discount_percentage: pct,
    // beverage offer (either the item OR the offer title) → flagged, hidden by default in UI
    is_drink: isDrink(item?.name) || isDrink(offer.title),
    is_wolt_plus: false,
    is_plus: isPro,
    plus_label: isPro ? "F+" : null,
  };
}

// Turn a venue's catalog into item-level deals from its category.offers[].
function offersToDeals(catalog, venue) {
  const out = [];
  const seen = new Set();
  for (const c of catalog?.data?.menu?.categories || []) {
    for (const offer of c.offers || []) {
      const pct = offerPct(offer);
      if (pct == null) continue;                    // fixed-price / unparseable → skip (no % to rank)
      const id = `${venue.shop_id}:${offer.id || offer.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(offerDeal(offer, venue, pct));
    }
  }
  return out;
}

// --all-items: surface every priced catalog item NOT already shown as an offer, as a
// plain non-discounted entry (discount_percentage null). No extra fetches — the
// catalog is already in hand; capped per venue. `taken` = item names already emitted
// as offers for this venue, so we don't double-list them.
function catalogItemsToDeals(catalog, venue, taken) {
  return (catalog?.data?.menu?.categories || []).flatMap((c) => c.items || [])
    .filter((it) => it && it.name && it.price != null && !taken.has(it.name))
    .slice(0, ALL_ITEMS_PER_VENUE_CAP)
    .map((it) => ({
      provider: "foody",
      name: it.name,
      item_name: it.name,
      image: it.images?.menu || it.image_url || venue.cover || null,
      ...venueFields(venue),
      price_minor: eur(it.price),
      original_minor: null,
      currency: "EUR",
      discount_percentage: null,        // not a deal — a plain menu item
      headline: null,
      is_drink: isDrink(it.name),
      is_wolt_plus: false,
      is_plus: false,
      plus_label: null,
    }));
}

async function fetchCatalog(auth, shopId) {
  const cp = `shop_id=${shopId}&version=3&latitude=${auth.lat}&longitude=${auth.lng}&category_slug=`;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${auth.base}/v3/shops/catalog?${cp}`, { headers: auth.headers });
    if (res.ok) return res.json();
    if (res.status === 429) { await sleep(500 * (i + 1)); continue; }
    return null;
  }
  return null;
}

async function loadVenues(auth) {
  const body = JSON.stringify({
    view: auth.offers_view,
    data: {
      latitude: auth.lat, longitude: auth.lng, vertical: auth.vertical,
      filters: [
        { key: "custom_filter", selected_values: ["has_offers", "is_open"] },
        { key: "sort", selected_values: ["ranking"] },
      ],
    },
  });
  const res = await fetch(auth.base + auth.components_path, { method: "POST", headers: auth.headers, body });
  if (!res.ok) throw new Error(`Foody offers list → HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== "ok") throw new Error(`Foody offers list status=${j.status} (${(j.message || "").slice(0, 60)})`);
  return collectShopCards(j.data || {}).map(cardToVenue).filter((v) => v.shop_id && v.is_open);
}

function rank(deals, minDiscount, limit, allItems = false) {
  return deals
    // always keep deals ≥ the floor; all-items mode ALSO keeps any other priced item
    .filter((d) => (d.discount_percentage || 0) >= minDiscount || (allItems && d.price_minor != null))
    .sort((a, b) => ((b.discount_percentage || 0) - (a.discount_percentage || 0)) ||
      ((b.rating10 || 0) - (a.rating10 || 0)) || ((a.price_minor ?? 1e9) - (b.price_minor ?? 1e9)))
    .slice(0, limit);
}

function printDeals(ranked, scanned) {
  process.stderr.write("\n");
  console.log(`Foody item-level deals — ${ranked.length} (from ${scanned} offer venues):\n`);
  for (const d of ranked) {
    const r = d.rating != null ? ` ★${d.rating}/5` : "";
    const was = d.original_minor != null ? ` (was €${(d.original_minor / 100).toFixed(2)})` : "";
    const price = d.price_minor != null ? ` €${(d.price_minor / 100).toFixed(2)}${was}` : "";
    console.log(`[foody] ${String(d.discount_percentage ?? "-").padStart(3)}% off${r}  ${d.name}${price} — ${d.venue_name}`);
    if (d.headline) console.log(`          «${d.headline}»`);
  }
}

async function main() {
  const opts = parseArgs();
  const auth = JSON.parse(await readFile(AUTH_PATH, "utf8"));
  if (opts.lat) auth.lat = opts.lat;
  if (opts.lon) auth.lng = opts.lon;  // override coords for the chosen address
  // The capture snippet only picks up coords if the captured request carried
  // them; otherwise the caller (the report's address picker, or --lat/--lon)
  // has to say where to look.
  if (!auth.lat || !auth.lng) throw new Error("Foody: no coordinates — pass --lat/--lon, or add lat/lng to " + AUTH_PATH);
  const venues = await loadVenues(auth);
  const top = venues.slice(0, opts.scanLimit);
  const emit = opts.stream ? (o) => process.stdout.write(JSON.stringify(o) + "\n") : null;
  if (emit) emit({ type: "start", address: "Foody", provider: "foody" });

  const all = [];
  const seenLive = new Set();
  let done = 0;
  await mapPool(top, opts.concurrency, async (v) => {
    const cat = await fetchCatalog(auth, v.shop_id).catch(() => null);
    const deals = cat ? offersToDeals(cat, v) : [];
    all.push(...deals);
    if (opts.allItems && cat) all.push(...catalogItemsToDeals(cat, v, new Set(deals.map((d) => d.item_name).filter(Boolean))));
    done++;
    if (emit) {
      for (const d of deals) {
        if ((d.discount_percentage || 0) < opts.minDiscount) continue;   // the live stream stays deals-only
        const k = `${d.venue_id}:${d.name}:${d.discount_percentage}`;
        if (seenLive.has(k)) continue; seenLive.add(k);
        emit({ type: "deal", deal: d });
      }
      emit({ type: "progress", done, total: top.length });
    } else if (done % 10 === 0) process.stderr.write(`scanned ${done}/${top.length} foody venues...\r`);
  });

  const ranked = rank(all, opts.minDiscount, opts.limit, opts.allItems);
  if (emit) { emit({ type: "done", deals: ranked, provider: "foody" }); return; }
  if (opts.json) return void process.stdout.write(JSON.stringify(ranked, null, 2) + "\n");
  printDeals(ranked, top.length);
}

runIfMain(import.meta.url, main);

export { offersToDeals, offerPct, offerItem, collectShopCards, cardToVenue, venueKey, slugToUrl };
