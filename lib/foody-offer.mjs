// Foody offer bundles and per-item options, read live with the saved Foody auth. A
// catalog offer ("Any 2 Pasta For €10") is a set of tiers: each tier lists candidate
// items and is picked `quantity` times; offer_line ties a picked item to the offer price.
import { readFile } from "node:fs/promises";
import { configPath } from "./config.mjs";
import { eur } from "./format.mjs";

// Foody's own "from" price of a tiered offer, as text on the offer ("5.90€",
// "From 8.45€"). Authoritative: the tier items do not discount uniformly, so summing
// them misprices the combo. Returns euros, or null when absent.
export function offerPriceEur(calculatedPrice) {
  const m = String(calculatedPrice || "").match(/(\d+[.,]\d+)/);
  return m ? parseFloat(m[1].replace(",", ".")) : null;
}

async function foodyGet(path) {
  const auth = JSON.parse(await readFile(configPath("foody_auth.json"), "utf8"));
  const res = await fetch(`${auth.base}${path}`, { headers: auth.headers });
  if (!res.ok) throw new Error(`Foody ${path.split("?")[0]} HTTP ${res.status}`);
  return (await res.json())?.data || {};
}

const tierItem = (i) => ({
  code: i.code, name: i.name, description: i.description || null,
  price_minor: eur(i.price), image: i.images?.menu || null,
  has_options: !!(i.has_variations || i.need_server_calculation),
});

// One offer's bundle shape: { id, title, price_minor, tiers: [{ title, quantity,
// offer_line, items: [{ code, name, description, price_minor, image, has_options }] }] }.
// Sold-out items and empty tiers are left out.
export async function foodyOfferDetail({ venueId, offerId }) {
  const q = `shop_id=${encodeURIComponent(venueId)}&offer_id=${encodeURIComponent(offerId)}`;
  const d = await foodyGet(`/v3/shops/catalog/offer?${q}`);
  return {
    id: String(offerId),
    title: d.title || d.description || "Offer",
    price_minor: eur(offerPriceEur(d.calculated_price)),
    tiers: (d.tiers || []).map((t) => ({
      title: t.title || "Choose",
      quantity: t.quantity || 1,
      offer_line: t.offer_line ?? null,
      items: (t.items || []).filter((i) => i && i.code && i.is_available !== false).map(tierItem),
    })).filter((t) => t.items.length),
  };
}

// Option groups of one product (an item code from a tier or the menu). `offerLine`
// scopes the options and prices to that offer tier. Returns { option_groups: [{ id,
// name, required, min, max, options: [{ id, name, price_minor }] }], preselect: [option
// ids the venue ticks by default], price_minor }.
export async function foodyItemOptions({ venueId, itemCode, offerLine }) {
  const line = offerLine ? `&offer_line=${encodeURIComponent(offerLine)}` : "";
  const d = await foodyGet(`/v4/shops/catalog/product?shop_id=${encodeURIComponent(venueId)}&lang=en&item_code=${encodeURIComponent(itemCode)}${line}`);
  const tiers = d.tiers || [];
  const option_groups = tiers.map((t) => ({
    id: String(t.code),
    name: t.name || "Options",
    required: t.type === "radio",
    min: t.type === "radio" ? 1 : 0,
    max: t.type === "radio" ? 1 : (t.maximum_selections || null),   // checkbox maximum_selections 0 = unlimited
    options: (t.options || []).map((o) => ({ id: String(o.code), name: o.name, price_minor: eur(o.price) || 0 })),
  })).filter((g) => g.options.length);
  return {
    option_groups,
    preselect: tiers.flatMap((t) => (t.options || []).filter((o) => o.selected).map((o) => String(o.code))),
    price_minor: eur(d.price),
  };
}
