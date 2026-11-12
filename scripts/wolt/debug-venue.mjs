// Scan ONE venue (by slug) without re-fetching the whole area. Useful when a
// deal in the full run looks wrong and you want to see exactly what the scanner
// derives — and the raw assortment/campaign JSON behind it — for that venue.
//   --venue <slug>            print every parsed deal for the venue (no food/min filter)
//   --venue <slug> --item X   only items/campaigns whose name (or id) contains X
//   --venue <slug> --dump     dump raw assortment items + venue_dynamic campaigns
//   --venue <slug> --json     parsed deal objects as JSON
import { woltFetch } from "../../lib/fetch.mjs";
import { scanVenuesForDiscounts } from "./venue-scan.mjs";
import { dealHead } from "./output.mjs";

// Enrich the synthetic venue from venue_static so deals carry name/rating/currency.
async function staticVenue(slug) {
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
  return v;
}

async function dumpVenue(v, addr, needle) {
  const matchItem = (it) =>
    !needle || String(it.name || "").toLowerCase().includes(needle) || String(it.id || "").toLowerCase() === needle;
  const ass = await woltFetch("assortment", { venue_slug: v.slug });
  const dyn = await woltFetch("venue_dynamic", { venue_slug: v.slug, lat: addr.lat, lon: addr.lon }).catch(() => null);
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
}

export async function debugVenue(slug, addr, opts) {
  const needle = opts.item ? String(opts.item).toLowerCase() : null;
  const v = await staticVenue(slug);
  if (opts.dump) return dumpVenue(v, addr, needle);

  let deals = await scanVenuesForDiscounts([v], 1, addr);
  if (needle) deals = deals.filter((d) => String(d.name || "").toLowerCase().includes(needle) || String(d.item_id || "").toLowerCase() === needle || String(d.item_name || "").toLowerCase().includes(needle));
  if (opts.json) {
    process.stdout.write(JSON.stringify(deals, null, 2) + "\n");
    return;
  }
  console.log(`Debug scan of ${v.name} (${slug})${needle ? `, item~"${opts.item}"` : ""} — ${deals.length} parsed deal(s):\n`);
  deals.sort((a, b) => (b.discount_percentage || 0) - (a.discount_percentage || 0));
  for (const d of deals) {
    const badges = d.badges?.length ? `  {${d.badges.join(" | ")}}` : "";
    console.log(`${dealHead(d)}  ${d.name}  [item ${d.item_id || "-"}]${badges}`);
  }
  if (!deals.length) console.log("(no discounted items/campaigns parsed for this venue)");
}
