// The menu scan of the venues around the address: which venues to scan, the scan
// itself plus a second pass for badge venues the cap cut off, and what the scanned
// items replace among the promotions-page deals.
import { pickScanCandidatesFromPromotions, nearbyVenuesByDistance } from "./promotions.mjs";
import { scanVenuesForDiscounts } from "./venue-scan.mjs";

const byKey = (v) => v.slug || v.id;

// Hybrid candidate list:
//   (a) Venues advertising ≥ minDiscount in promotions-near-you (high-signal).
//   (b) Top-K closest venues by distance (catches assortment-level markdowns
//       that Wolt doesn't badge — e.g. Pitta & More-style hidden 50% deals).
async function pickVenues({ promo, banlist, addr, opts }) {
  const promoCands = pickScanCandidatesFromPromotions(promo, opts.minDiscount, banlist);
  const distanceCands = await nearbyVenuesByDistance(addr, banlist, opts.scanLimit);
  const blindTopK = Math.min(distanceCands.length, opts.blindTopK);
  const merged = new Map();
  for (const v of promoCands) merged.set(byKey(v), v);
  for (const v of distanceCands.slice(0, blindTopK)) {
    if (!merged.has(byKey(v))) merged.set(byKey(v), v);
  }
  const candidates = [...merged.values()];
  const primary = candidates.slice(0, opts.scanLimit);
  process.stderr.write(
    `Scanning ${primary.length} venues ` +
    `(${promoCands.length} promo-tagged + ${blindTopK} closest by distance, deduped)...\n`,
  );
  return { candidates, primary };
}

// Second pass: venues whose badge would survive as a vague venue-level row
// ("Add 2 Pay for 1 — ?") because the scan cap cut them off before they were
// scanned. Scan just those so the output names the concrete discounted items.
function missedBadgeVenues({ candidates, primary }, venueLevel, minDiscount) {
  const primarySlugs = new Set(primary.map((v) => v.slug));
  const unresolvedSlugs = new Set(
    venueLevel
      .filter((d) => d.discount_percentage >= minDiscount && d.venue_slug && !primarySlugs.has(d.venue_slug))
      .map((d) => d.venue_slug),
  );
  return candidates.filter((v) => unresolvedSlugs.has(v.slug)).slice(0, 30);
}

// Dedupe: if scan surfaced concrete items from a venue, drop the vague
// venue-level badges ("30% off selected items", "Save X% with W+") — the
// scanned items name the exact deals and their prices, which is what the
// user actually wants.
function supersedeVenueLevel(deals, scanned) {
  const venuesWithScannedItems = new Set(
    scanned.map((d) => d.venue_id || d.venue_slug).filter(Boolean),
  );
  return deals.filter((d) => {
    if (!d.venue_level) return true;
    const key = d.venue_id || d.venue_slug;
    if (venuesWithScannedItems.has(key)) return false;  // superseded by concrete scanned items
    // Otherwise it's an unresolved badge with no concrete item ("Add 2 Pay 1 on
    // selected items", "X% off selected items") — too vague to show: the offer
    // could be on items you don't care about (e.g. 2 coffees). Only surface
    // deals whose actual items the scan named. Item-level rows (price set) stay.
    return d.price_minor != null;
  });
}

// Per-venue best % the scan actually derived (slug-keyed — unparsed badge
// records carry venue_slug). Used to resolve text badges we couldn't parse.
function bestPctBySlug(scanned) {
  const out = new Map();
  for (const d of scanned) {
    if (!d.venue_slug) continue;
    const cur = out.get(d.venue_slug) || 0;
    if ((d.discount_percentage || 0) > cur) out.set(d.venue_slug, d.discount_percentage || 0);
  }
  return out;
}

// `run` = { promo, banlist, addr, opts, onBatch }. Returns { deals, scanPctBySlug }.
export async function scanArea(run, deals, venueLevel) {
  const { addr, opts, onBatch } = run;
  const picked = await pickVenues(run);
  const { primary } = picked;
  let scanned = await scanVenuesForDiscounts(primary, primary.length, addr, opts.scanConcurrency, onBatch);
  const secondPass = missedBadgeVenues(picked, venueLevel, opts.minDiscount);
  if (secondPass.length) {
    process.stderr.write(`Second pass: ${secondPass.length} badge venues missed by the scan cap...\n`);
    scanned = scanned.concat(await scanVenuesForDiscounts(secondPass, secondPass.length, addr, opts.scanConcurrency, onBatch));
  }
  return { deals: supersedeVenueLevel(deals.concat(scanned), scanned), scanPctBySlug: bestPctBySlug(scanned) };
}
