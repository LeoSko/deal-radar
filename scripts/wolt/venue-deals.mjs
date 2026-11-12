// Derive all deals for ONE venue from its already-fetched assortment + dynamic.
// Pure (no I/O) — the network fetch happens in scanVenuesForDiscounts so this
// stays easy to reason about and reuse.
import { computeMandatoryAddons } from "./addons.mjs";
import { narrowItemWindows, windowMinutes } from "./item-windows.mjs";
import {
  campaignOpenAtScan, campaignRequiredQty, campTitleAddsInfo, computeItemDiscountDeal,
  isPlaceholderItemDiscount, withEnd,
} from "./campaigns.mjs";

let allItems = false;                   // --all-items: also surface non-discounted items
export const setAllItems = (on) => { allItems = on; };
const ALL_ITEMS_PER_VENUE_CAP = 200;    // grocery cap: bound payload on huge (supermarket) menus
const ALL_ITEMS_GROCERY_THRESHOLD = 1500;   // above this many items a venue is treated as grocery → capped; restaurants surface in full

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

// `terms` = { name, price, original, pct, isWoltPlus, badges, addons, excludeOptions, addonPct }.
function makeDeal(v, item, terms) {
  const { name, price, original, pct, isWoltPlus, badges, addons, excludeOptions = true, addonPct = pct } = terms;
  const a = addons || { addon_minor: 0, breakdown: [] };
  // Wolt cascades the per-item discount to the mandatory option add-ons at
  // checkout (verified empirically: Pizza Hut "Loaded Garden Supreme" pizza
  // with size=medium prices to €6.45 + 60% of €6.90 = €10.59, matching the
  // checkout cart). So the realistic minimum total is the already-discounted
  // base plus the add-on discounted by the same fraction.
  const discountedAddon = Math.round(a.addon_minor * (1 - (addonPct || 0) / 100));
  return {
    // Whether the per-item discount also applies to paid options/extras (Wolt's
    // item_discount.exclude_options). Drives discounting the menu's option prices
    // when this deal is overlaid onto the live menu (enrichMenuWithDeals).
    options_discounted: (pct || 0) > 0 && excludeOptions === false,
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
    price_minor: price,
    original_minor: original,
    currency: v.currency,
    discount_percentage: pct,
    is_wolt_plus: isWoltPlus,
    badges,
    mandatory_addon_minor: a.addon_minor,
    mandatory_addon_discounted_minor: discountedAddon,
    mandatory_addon_breakdown: a.breakdown,
    effective_min_minor: price + discountedAddon,
  };
}

// The campaign's included items that the menu has, minus its excluded ones.
function campaignItems(ctx, effect) {
  const excludeIds = new Set(effect.exclude?.items || []);
  return [...new Set(effect.include?.items || [])]
    .filter((itemId) => !excludeIds.has(itemId))
    .map((itemId) => ctx.itemsById.get(itemId))
    .filter(Boolean);
}

// Source 1: assortment-level markdowns (original_price > price)
// W+ tag here only if the item itself is W+-only. v.show_wolt_plus is a
// venue-level "shown on the W+ feed" flag that's true for ~95% of venues
// and would over-tag almost every deal as W+.
function markdownDeals(ctx) {
  const out = [];
  for (const item of ctx.ass.items || []) {
    if (!item.original_price || item.price >= item.original_price) continue;
    const pct = Math.round(((item.original_price - item.price) / item.original_price) * 100);
    out.push(makeDeal(ctx.v, item, { name: item.name, price: item.price, original: item.original_price, pct,
      isWoltPlus: !!item.is_wolt_plus_only, badges: [], addons: computeMandatoryAddons(item, ctx.optionsById) }));
  }
  return out;
}

// Source 2: campaign-based item_discount in venue dynamic (fixed €-off or
// fraction-off on specific item IDs — e.g. "The Original €8.90", "2 FOR €9").
function itemDiscountDeals(ctx, discounts) {
  const out = [];
  for (const camp of discounts) {
    const id = camp.effects?.item_discount;
    if (!id) continue;
    if (!campaignOpenAtScan(camp)) continue;
    if (isPlaceholderItemDiscount(camp, id)) continue;
    const terms = {
      fraction: id.fraction || 0,
      amount: id.amount_per_item || 0,
      maxPerItem: id.max_amount_per_item,  // per-item € cap, when set
      reqQty: campaignRequiredQty(camp),
    };
    for (const item of campaignItems(ctx, id)) {
      const deal = itemDiscountDeal(ctx, camp, item, terms);
      if (deal) out.push(deal);
    }
  }
  return out;
}

function itemDiscountDeal(ctx, camp, item, terms) {
  const wasMinor = item.original_price > item.price ? item.original_price : null;
  const priced = computeItemDiscountDeal(item.price, { ...terms, wasMinor });
  if (!priced) return null;
  const campTitle = camp.description?.title || null;
  const baseName = priced.bundleQty >= 2 ? `Buy ${priced.bundleQty} ${item.name}` : item.name;
  const dealName = campTitleAddsInfo(campTitle, item.name) ? `${baseName} — ${campTitle}` : baseName;
  // Paid options get the campaign cut only, not the venue's own markdown of the base.
  const addonPct = wasMinor ? computeItemDiscountDeal(item.price, terms).pct : priced.pct;
  return withEnd(makeDeal(ctx.v, item, {
    name: dealName, price: priced.price, original: priced.original, pct: priced.pct,
    isWoltPlus: camp.conditions?.has_wolt_plus === true || !!item.is_wolt_plus_only,
    badges: [campTitle || camp.id].filter(Boolean),
    addons: computeMandatoryAddons(item, ctx.optionsById),
    excludeOptions: camp.effects.item_discount.exclude_options === true, addonPct,
  }), camp);
}

// Source 3: free_items BOGO campaigns ("Add 2 X, Pay for 1").
// Reports the per-piece effective price (item.price × buy / (buy+get))
// and surfaces the exact item name + campaign title so the user knows
// WHICH item is on offer, not just "Buy 2 Pay 1".
function freeItemDeals(ctx, discounts) {
  const out = [];
  for (const camp of discounts) {
    const fi = camp.effects?.free_items;
    if (!fi || !campaignOpenAtScan(camp)) continue;
    const buy = fi.buy || 0;
    const get = fi.get || 0;
    const totalUnits = buy + get;
    if (get <= 0 || totalUnits <= 0) continue;
    const isWoltPlus = camp.conditions?.has_wolt_plus === true;
    const pct = Math.round((get / totalUnits) * 100);
    const campTitle = camp.description?.title || `Buy ${totalUnits} pay ${buy}`;
    for (const item of campaignItems(ctx, fi)) {
      // The venue often bakes the BOGO into the item itself: a grill house's
      // "Loukaniko" lists price €6.80 / original €13.60 with a mandatory
      // "Buy item" + "Free item" option pair — €6.80 already buys BOTH pieces.
      // Halving that price again reports €3.40, a discount nobody can order.
      // A markdown at least as deep as the campaign IS the campaign; skip it.
      // A shallower markdown (a combo item priced below the sum of its parts) is
      // a separate discount the BOGO still stacks on, so keep those.
      const markdownPct = item.original_price > item.price
        ? Math.round(((item.original_price - item.price) / item.original_price) * 100) : 0;
      if (markdownPct >= pct) continue;
      const normName = item.name.toLowerCase().replace(/^\d+\.?\s*/, "").trim();
      const dealName = campTitle.toLowerCase().includes(normName)
        ? campTitle
        : `${campTitle} (${item.name})`;
      out.push(withEnd(makeDeal(ctx.v, item, {
        name: dealName, price: Math.round((item.price * buy) / totalUnits), original: item.price, pct,
        isWoltPlus: isWoltPlus || !!item.is_wolt_plus_only,
        badges: [campTitle], addons: computeMandatoryAddons(item, ctx.optionsById),
      }), camp));
    }
  }
  return out;
}

// All-items mode: also surface every priced item not already a deal, as a plain
// non-discounted entry (discount_percentage null), so /deals can search/show full
// menus. No extra fetches — the assortment is already in hand; capped per venue.
function plainItemDeals(ctx, results) {
  const { ass } = ctx;
  // Cap only huge (grocery/supermarket) menus; restaurants surface in full so search finds every dish.
  const cap = (ass.items?.length || 0) > ALL_ITEMS_GROCERY_THRESHOLD ? ALL_ITEMS_PER_VENUE_CAP : Infinity;
  const surfaced = new Set(results.map((d) => d.item_id).filter(Boolean));
  const out = [];
  for (const item of ass.items || []) {
    if (out.length >= cap) break;
    if (!item.name || item.price == null) continue;
    if (item.id != null && surfaced.has(String(item.id))) continue;
    out.push(makeDeal(ctx.v, item, { name: item.name, price: item.price, original: null, pct: null,
      isWoltPlus: !!item.is_wolt_plus_only, badges: [], addons: computeMandatoryAddons(item, ctx.optionsById) }));
  }
  return out;
}

// Flag beverage deals so the UI can hide them by default — assortment category
// first (reliable), item/deal name as fallback.
function tagDrinksAndWindows(ass, results) {
  const id2cat = buildItemCategoryMap(ass);
  const windows = narrowItemWindows(ass.items || []);
  for (const d of results) {
    const cat = d.item_id ? id2cat.get(d.item_id) : null;
    d.is_drink = isDrinkCategory(cat) || isDrinkName(d.item_name || d.name);
    // A campaign window and an item window can both apply; the narrower one is closer.
    const w = d.item_id && windows.get(d.item_id);
    if (w && (!d.window || windowMinutes(w) < windowMinutes(d.window))) d.window = w;
  }
}

export function extractVenueDeals(v, ass, dyn) {
  const itemsById = new Map();
  for (const it of ass.items || []) itemsById.set(it.id, it);
  const ctx = { v, ass, itemsById, optionsById: new Map((ass.options || []).map((o) => [o.id, o])) };
  const discounts = dyn?.venue_raw?.discounts || [];

  const campaignDeals = itemDiscountDeals(ctx, discounts);
  // item ids a Source 2 campaign priced: a campaign deal already includes the item's
  // markdown, so its markdown-only deal goes.
  const campaignPriced = new Set(campaignDeals.map((d) => d.item_id).filter((x) => x != null));
  const results = markdownDeals(ctx).concat(campaignDeals)
    .filter((d) => !(d.badges.length === 0 && campaignPriced.has(d.item_id)))
    .concat(freeItemDeals(ctx, discounts));
  if (allItems) results.push(...plainItemDeals(ctx, results));
  tagDrinksAndWindows(ass, results);
  return results;
}
