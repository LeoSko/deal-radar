// What Wolt's promotions-near-you page gives without a per-venue fetch: the deals
// in its JSON tree, the venue-level badge deals, and the venues worth a menu scan.
//
// The page lists every nearby venue with a `venue.promotions` badge array (text like
// "Save 50% with W+", "30% off selected items", "-30% on your total order"). We use it
// for two things:
//   (a) Surface venue-level deals directly without drilling into the menu.
//   (b) Filter scan candidates to venues actually advertising a discount ≥ min,
//       so the scanner does not blindly fetch unrelated assortments.
import { woltFetch } from "../../lib/fetch.mjs";
import { WOLT_RESTAURANT_API } from "../../lib/endpoints.mjs";
import { isFoodVenue } from "./food-filter.mjs";
import { parsePromoPct, classifyUnparsedBadge, isOfferKind, venueScopeFromText } from "./promo-badges.mjs";

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

// The venue context a node passes down to its children (the items nested in it).
function childContext(n, ctx, banlist) {
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
  return childCtx;
}

// Wolt's promotions page response shape is undocumented and varies by city/date.
// We walk the JSON tree finding any object that looks like a deal: has a name,
// has either an explicit discount badge / discount_percentage / both price + original_price.
export function extractFromPromotionsTree(raw, banlist) {
  const deals = [];
  const seen = new Set();

  const visit = (n, ctx) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, ctx));

    const childCtx = childContext(n, ctx, banlist);
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

// The online, delivering food venues of the page's venue list.
function listedFoodVenues(promo, banlist) {
  const sec = (promo.sections || []).find((s) => s.template === "venue-vertical-list");
  return (sec?.items || []).map((it) => it.venue)
    .filter((v) => v && v.online && v.delivers && isFoodVenue(v, banlist));
}

// Collect venue-level deals from the promotions tree. Each badge with a parseable
// % becomes a deal whose "name" is the badge text itself (e.g. "-30% on your total order").
// Returns { deals, unparsed } — unparsed list is fed to reportUnparsedBadges so the
// script learns over time which badge shapes need new rules.
export function extractVenueLevelDeals(promo, banlist) {
  const out = [];
  const unparsed = [];
  for (const v of listedFoodVenues(promo, banlist)) {
    for (const p of v.promotions || []) {
      const text = p?.text || "";
      const pct = parsePromoPct(text);
      if (!pct) {
        const kind = classifyUnparsedBadge(text);
        // Skip well-known no-discount labels silently.
        if (isOfferKind(kind)) {
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
    if (isOfferKind(classifyUnparsedBadge(t))) return true;
  }
  return false;
}

// A venue as the scanner takes it (see scanVenuesForDiscounts).
function scanCandidate(v) {
  return {
    id: v.id,
    slug: v.slug,
    name: v.name,
    product_line: v.product_line || null,
    rating: v.rating?.score,
    estimate: v.estimate_range || (v.estimate ? `${v.estimate} min` : null),
    show_wolt_plus: !!v.show_wolt_plus,
    promotions: v.promotions || [],
    currency: v.currency || "EUR",
  };
}

// Filter the promotions response to a scan-worthy venue list: those advertising
// pct >= minDiscount, a "with W+" offer, OR an unparseable real offer badge whose
// % the scan can derive from the assortment. Avoids blind 80-venue scan.
export function pickScanCandidatesFromPromotions(promo, minDiscount, banlist) {
  const out = [];
  for (const v of listedFoodVenues(promo, banlist)) {
    const texts = (v.promotions || []).map((p) => p?.text || "");
    const maxPct = texts.reduce((m, t) => Math.max(m, parsePromoPct(t) || 0), 0);
    const woltPlusBadge = texts.some((t) => /with\s+w\+/i.test(t));
    const unparsedOffer = hasUnparsedOfferBadge(v);
    if (maxPct < minDiscount && !woltPlusBadge && !unparsedOffer) continue;
    out.push({
      ...scanCandidate(v),
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
export async function nearbyVenuesByDistance(addr, banlist, limit = 100) {
  const data = await woltFetch("promotions", {}, {
    url: `${WOLT_RESTAURANT_API}/v1/pages/restaurants?lat=${addr.lat}&lon=${addr.lon}`,
  });
  const list = (data.sections || []).find((s) => s.template === "venue-vertical-list");
  return (list?.items || [])
    .map((it) => it.venue)
    .filter((v) => v && v.online && v.delivers)
    .filter((v) => !banlist || isFoodVenue(v, banlist))
    .slice(0, limit)
    .map(scanCandidate);
}
