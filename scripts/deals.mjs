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
//   node deals.mjs --dyn-rps 0.65         # campaign-endpoint pace (per account, far below --scan-rps)
//   node deals.mjs --all-items            # also emit non-discounted menu items
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
//
// The stages live in ./wolt/: promotions (page deals + scan candidates), area-scan and
// venue-scan (menu fetches), venue-deals (menu + campaign deals), rank, output.

import { woltFetch } from "../lib/fetch.mjs";
import { loadAuth } from "../lib/auth.mjs";
import { runIfMain } from "../lib/cli.mjs";
import { parseArgs, resolveAddress } from "./wolt/args.mjs";
import { setRateLimits } from "./wolt/rate-limit.mjs";
import { setAllItems } from "./wolt/venue-deals.mjs";
import { loadBanlist } from "./wolt/food-filter.mjs";
import { extractFromPromotionsTree, extractVenueLevelDeals } from "./wolt/promotions.mjs";
import { scanArea } from "./wolt/area-scan.mjs";
import { reportUnparsedBadges, showUnparsedSummary } from "./wolt/unparsed-log.mjs";
import { debugVenue } from "./wolt/debug-venue.mjs";
import { rankWithFallback } from "./wolt/rank.mjs";
import { cityCtxFromPromo, itemUrl, unifyDeal, venueUrl } from "./wolt/links.mjs";
import { dealStream, printDeals } from "./wolt/output.mjs";

// Every deal found near the address, unranked. `run` = { promo, banlist, addr, opts, onBatch }.
async function findDeals(run) {
  const { promo, banlist } = run;
  let deals = extractFromPromotionsTree(promo, banlist);

  // Venue-level deals parsed from venue.promotions[].text badges. Cheap (no extra
  // HTTP) — these are why the promotions-near-you page exists.
  const { deals: venueLevel, unparsed } = extractVenueLevelDeals(promo, banlist);
  deals = deals.concat(venueLevel);
  // Unparsed-badge logging is deferred until after the optional --scan pass so we
  // can reconcile: a badge whose % we couldn't parse from text is "resolved" when
  // the deeper scan derived a real % from that venue's assortment / campaigns.
  let scanPctBySlug = null;
  if (run.opts.scan) {
    ({ deals, scanPctBySlug } = await scanArea(run, deals, venueLevel));
  }
  await reportUnparsedBadges(unparsed, scanPctBySlug);
  return deals;
}

function writeResult(ranked, { stream, cityCtx, opts, usedFloor, ...page }) {
  // Attach canonical venue URLs (consumed by --json clients like screenshots.mjs
  // and printed below). cityCtx (city_data, page-level) computed once up top.
  for (const d of ranked) {
    d.venue_url = venueUrl(d, cityCtx);
    d.item_url = itemUrl(d, cityCtx);
  }
  if (stream) {
    // Final canonical (ranked + chain-collapsed) set — serve.mjs swaps the live
    // cards for this so the page matches the CLI output exactly.
    stream.emit({ type: "done", deals: ranked.map((d) => unifyDeal(d, cityCtx)), provider: "wolt", usedFloor, minDiscount: opts.minDiscount });
    return;
  }
  if (opts.json) {
    // Same canonical shape as the --stream `done` set: unifyDeal() adds the cross-provider
    // fields (is_plus/plus_label from W+, venue_key, rating10, urls), so a --json
    // consumer reads the same deal the live report shows.
    process.stdout.write(JSON.stringify(ranked.map((d) => unifyDeal(d, cityCtx)), null, 2) + "\n");
    return;
  }
  printDeals(ranked, { ...page, opts, usedFloor });
}

async function main() {
  const opts = parseArgs();
  setAllItems(opts.allItems);
  setRateLimits(opts);
  if (opts.showUnparsed) return showUnparsedSummary();
  const auth = await loadAuth();
  const addr = await resolveAddress(opts, auth);
  if (opts.venue) return debugVenue(opts.venue, addr, opts);

  const promo = await woltFetch("promotions", { lat: addr.lat, lon: addr.lon });
  if (opts.dump) {
    process.stdout.write(JSON.stringify(promo, null, 2) + "\n");
    return;
  }
  const banlist = await loadBanlist();
  const cityCtx = cityCtxFromPromo(promo);
  const stream = dealStream({ opts, banlist, cityCtx, addr });
  const deals = await findDeals({ promo, banlist, addr, opts, onBatch: stream?.onBatch ?? null });
  const { ranked, usedFloor } = rankWithFallback(deals, banlist, opts);
  writeResult(ranked, { stream, cityCtx, opts, usedFloor, addr, promo });
}

runIfMain(import.meta.url, main);
