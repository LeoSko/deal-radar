// What deals.mjs writes to stdout: the NDJSON stream for serve.mjs, and the
// human-readable table.
import { fmtMoney, fmtPercent } from "../../lib/format.mjs";
import { isFood } from "./food-filter.mjs";
import { unifyDeal } from "./links.mjs";

// Left-column tag: just the Wolt+ flag. The exact discount is already in the
// "% off" column, so the tag only carries what that column doesn't — W+ membership.
// Then the % and the price, with the struck-through price when there is one.
export function dealHead(d) {
  const tag = d.is_wolt_plus ? "[W+]" : "[  ]";
  const pct = fmtPercent(d.discount_percentage).padStart(5);
  const price = d.price_minor !== null ? fmtMoney(d.price_minor, d.currency) : "?";
  const orig = d.original_minor ? ` (was ${fmtMoney(d.original_minor, d.currency)})` : "";
  return `${tag} ${pct} off  ${price}${orig}`;
}

// --stream: emit NDJSON events on stdout as the scan progresses, so serve.mjs
// can render live cards. Food + ≥ floor filtered, deduped, with image + links.
// Returns { emit, onBatch }, or null without --stream.
export function dealStream({ opts, banlist, cityCtx, addr }) {
  if (!opts.stream) return null;
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const seen = new Set();
  const onBatch = (venueDeals, prog) => {
    for (const d of venueDeals) {
      if (!isFood(d.name, banlist)) continue;
      if ((d.discount_percentage || 0) < opts.floor) continue;
      const key = `${d.venue_slug}::${d.name}::${d.discount_percentage}`;
      if (seen.has(key)) continue;
      seen.add(key);
      emit({ type: "deal", deal: unifyDeal(d, cityCtx) });
    }
    emit({ type: "progress", done: prog.done, total: prog.total });
  };
  emit({ type: "start", address: addr.alias || "Work", lat: addr.lat, lon: addr.lon, provider: "wolt" });
  return { emit, onBatch };
}

function dealLine(d) {
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
  return `${dealHead(d)}${addon}${rating}${eta}  ${d.name}${venue}${link}`;
}

export function printDeals(ranked, { addr, promo, opts, usedFloor }) {
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
  for (const d of ranked) console.log(dealLine(d));
}
