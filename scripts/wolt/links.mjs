// Canonical wolt.com links of a deal, and the unified cross-provider deal shape
// (provider/rating10/venue_key) that lets the viewer merge Wolt + Bolt and join by venue.
import { venueKey } from "../../lib/venue-key.mjs";

// Build the canonical Wolt venue URL: https://wolt.com/en/{country}/{city}/{seg}/{slug}.
// The path SEGMENT is vertical-specific (verified by curl): restaurants resolve
// only under /restaurant/, every other (grocery) vertical only under /venue/ —
// the wrong segment 301s to a 404, and the slug-only /en/venue/{slug} form is dead
// too. `cityCtx` (country + city slug) comes from the promotions response's
// page-level `city_data`; all nearby venues share it. Unknown product_line
// defaults to "restaurant" (the dominant vertical).
export function venueUrl(deal, cityCtx) {
  if (!deal.venue_slug || !cityCtx?.city || !cityCtx?.country) return null;
  const seg = String(deal.product_line || "").toLowerCase() === "grocery" ? "venue" : "restaurant";
  return `https://wolt.com/en/${cityCtx.country}/${cityCtx.city}/${seg}/${deal.venue_slug}`;
}

// Deep link straight to the discounted item: {venueUrl}/{item-slug}-itemid-{id}.
// Wolt's item slug is the slugified item name (lowercase, non-alphanumeric runs
// collapsed to "-"), e.g. "Halloumi Portion" → halloumi-portion-itemid-60f9....
export function itemUrl(deal, cityCtx) {
  const base = venueUrl(deal, cityCtx);
  if (!base || !deal.item_id || !deal.item_name) return null;
  const slug = String(deal.item_name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base}/${slug ? slug + "-" : ""}itemid-${deal.item_id}`;
}

// Country + city slug for canonical URLs, pulled from the promotions page's
// top-level city_data (one city per query — Wolt only returns venues near the
// queried address). Null if absent → URLs are omitted rather than wrong.
export function cityCtxFromPromo(promo) {
  const cd = promo?.city_data;
  if (!cd?.slug) return null;
  return { country: String(cd.country_code_alpha3 || "").toLowerCase(), city: cd.slug };
}

// Wolt rating is already /10.
export const unifyDeal = (d, cityCtx) => ({
  ...d, provider: "wolt", rating_scale: 10, rating10: d.rating ?? null,
  venue_key: venueKey(d.venue_name),
  is_plus: !!d.is_wolt_plus, plus_label: d.is_wolt_plus ? "W+" : null,
  venue_url: venueUrl(d, cityCtx), item_url: itemUrl(d, cityCtx),
});
