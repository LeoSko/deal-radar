// Ranking of the Wolt deal list: food filter, discount floor, dedupe, band order,
// chain collapse, and the fallback to lower floors when nothing clears the first.
import { isFood } from "./food-filter.mjs";

const ALL_ITEMS_TOTAL_CAP = 50000;      // all-items mode: high safety bound only (per-venue cap does the real bounding)

// Discount band — the PRIMARY ranking key, in 10-point steps (62%→6, 40%→4,
// 35%→3, 30%→3). A higher band always ranks first, Wolt+ or not; W+ only breaks
// ties WITHIN the same 10-pt band (see rankDeals). Same exact % ⇒ same band ⇒ W+
// wins the tie.
function discountBand(pct) {
  return Math.floor((pct || 0) / 10);
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

function rankDeals(deals, { banlist, minDiscount, allItems }) {
  const seen = new Set();
  const food = deals
    // Food filter applies to deals; in all-items mode ALSO keep every non-discounted priced
    // menu item even if "non-food" — a bubble-tea / coffee shop's menu is mostly drinks, which
    // the client's is_drink toggle hides by default. (Discounted non-food still drops, so the
    // default deals view stays food-only and realDeals isn't polluted.)
    .filter((d) => isFood(d.name, banlist) || (allItems && d.price_minor != null && !(d.discount_percentage > 0)))
    // Always keep deals ≥ the floor; all-items mode ALSO keeps any other priced item
    // (union — a replace would drop discounted deals that carry no resolved price).
    .filter((d) => d.discount_percentage >= minDiscount || (allItems && d.price_minor != null))
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

// Tiered fallback: try --min-discount first; if empty, fall through 25, 20,
// --floor in steps. Skip a tier if it equals a higher one already tried.
// Returns { ranked, usedFloor }.
export function rankWithFallback(deals, banlist, opts) {
  const tiers = Array.from(new Set([opts.minDiscount, 25, 20, opts.floor]
    .filter((n) => Number.isFinite(n) && n > 0 && n <= opts.minDiscount)
    .sort((a, b) => b - a)));
  let ranked = [];
  let usedFloor = tiers[0];
  for (const t of tiers) {
    // all-items rows have no discount → they rank last, so the global opts.limit slice would
    // cut the tail (most plain menu items) and a venue's full menu wouldn't be searchable.
    // The per-venue cap already bounds payload, so use a high safety cap in all-items mode.
    ranked = collapseChainDuplicates(rankDeals(deals, { banlist, minDiscount: t, allItems: opts.allItems }))
      .slice(0, opts.allItems ? ALL_ITEMS_TOTAL_CAP : opts.limit);
    if (ranked.length) { usedFloor = t; break; }
  }
  return { ranked, usedFloor };
}
