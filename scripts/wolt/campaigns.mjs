// Wolt venue campaigns (venue-dynamic `discounts`): how one prices an item, when it
// runs, and whether its title says anything the deal card does not.
import { venueClock } from "../../lib/deal-window.mjs";
import { hhmm } from "./item-windows.mjs";

// Word-set (Jaccard) similarity, for catching near-duplicate titles that aren't
// an exact substring ("…second for €1" vs "…Second on €1").
function tokenSim(a, b) {
  const tok = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
// Decide whether to append a campaign title to the item name. The % and the W+
// tag are already shown as badges, so a generic "Save 40% on selected items with
// W+" / "40% Discount on Bao Buns" title is pure noise — drop it. Keep ONLY
// titles that carry concrete info the card can't show otherwise: an explicit €
// price or multi-buy/BOGO terms ("Buy 1 … get 2nd for €1").
export function campTitleAddsInfo(campTitle, itemName) {
  if (!campTitle) return false;
  const t = campTitle.toLowerCase();
  const norm = String(itemName || "").toLowerCase().replace(/^\d+\.?\s*/, "").trim();
  if (norm && t.includes(norm)) return false;                      // repeats the item name
  if (tokenSim(campTitle, itemName) >= 0.6) return false;          // near-duplicate of the item name
  if (/€\s*\d|\d+(?:[.,]\d+)?\s*€/.test(t)) return true;            // concrete € price
  if (/\b(buy|get|free)\b|δωρε|2nd|second|1\s*\+\s*1/i.test(t)) return true;  // multi-buy / BOGO terms
  return false;  // generic "Save X% … with W+" / "X% off selected items" → drop
}

// How many units a campaign requires before its item_discount applies. A flat
// "amount_per_item" off is only the headline single-item discount when q == 1;
// for a "buy N, the Nth is cheap" deal (e.g. BK "Buy 1 Big King Chicken & Get
// the second for €1") the €-off lands on a basket of N, so pricing one unit at
// price - amount overstates it (the €1.00 / 82% artifact). The reliable signal
// is the structural conditions.basket_contains[].min_quantity — NOT the title,
// because the same "...get the second..." campaign is sometimes bound to the
// single item (price = one unit, needs ×N) and sometimes to a pre-made N-pack
// item (price already = N units, needs ×1); only the qty gate disambiguates.
//   NB: Wolt's "min_quantity" doubles as a spend-gate sentinel (5000, 10000 …) on
//   tiered "up to X%" promos — only values in a sane item-count range count here.
export function campaignRequiredQty(camp) {
  let q = 1;
  for (const b of camp.conditions?.basket_contains || []) {
    const mq = b.min_quantity;
    if (typeof mq === "number" && mq >= 2 && mq <= 50) q = Math.max(q, mq);
  }
  return q;
}

// Pure pricing for one item under an item_discount campaign. Returns the
// {price, original, pct, bundleQty} to surface, or null to skip. Splits the two
// real shapes seen in the wild:
//   - fraction: a genuine per-unit X%-off → price one unit, % is qty-independent.
//   - amount  : a flat €-off. With reqQty ≥ 2 it lands once on the whole bundle,
//     so price the bundle (price×qty − amount), never a single unit (that's the
//     €1.00 / 82% artifact). With reqQty 1 a >70%-of-one-unit flat cut is treated
//     as a misbound "second unit" deal and skipped rather than overstated.
// wasMinor is the item's own struck-through price when the venue already marked it
// down: the campaign stacks on the marked-down price, so the deal counts from wasMinor.
// Extracted as a pure function so every branch is unit-testable without network.
export function computeItemDiscountDeal(priceMinor, { fraction = 0, amount = 0, maxPerItem = null, reqQty = 1, wasMinor = null }) {
  if (!priceMinor || priceMinor <= 0) return null;
  const was = Math.max(priceMinor, wasMinor || 0);
  if (fraction) {
    let perUnit = Math.round(priceMinor * fraction);
    if (typeof maxPerItem === "number") perUnit = Math.min(perUnit, maxPerItem);
    if (perUnit <= 0) return null;
    const price = priceMinor - perUnit;
    return { price, original: was, pct: Math.round(((was - price) / was) * 100), bundleQty: 1 };
  }
  let amt = amount;
  if (typeof maxPerItem === "number") amt = Math.min(amt, maxPerItem);
  if (amt <= 0) return null;
  if (reqQty < 2 && amt / priceMinor > 0.7) return null;  // misbound second-unit guard
  const wasTotal = priceMinor * reqQty;
  if (amt >= wasTotal) return null;  // nonsensical (would imply free / negative)
  const price = wasTotal - amt, original = was * reqQty;
  return { price, original, pct: Math.round(((original - price) / original) * 100), bundleQty: reqQty };
}

// Tiered / placeholder item_discount campaigns we can't price to an exact % from
// the assortment: "up to X%" tiers, sentinel spend-gates (min_quantity in the
// thousands), and the fraction≈0 / amount=1 stubs Wolt ships for those. Skipped
// so they never surface as a bogus "0% off" or a misleading headline.
export function isPlaceholderItemDiscount(camp, id) {
  if ((camp.description?.title || "").toLowerCase().includes("up to")) return true;
  for (const b of camp.conditions?.basket_contains || []) {
    if (typeof b.min_quantity === "number" && b.min_quantity >= 1000) return true;
  }
  if (id.fraction != null && id.fraction > 0 && id.fraction < 0.01) return true;
  if (id.amount_per_item != null && id.amount_per_item > 0 && id.amount_per_item <= 1) return true;
  return false;
}

// When a campaign stops, as ISO, or null for an open-ended one. Wolt marks "no end" as
// 2050-01-01. fire_deal_expires_at has only ever come back null; read it as ISO like
// end_date and ignore any other shape, since a wrong reading would hide a live deal.
export function campaignEndsAt(camp) {
  const ends = [camp.end_date, camp.fire_deal_expires_at]
    .filter((x) => typeof x === "string").map(Date.parse)
    .filter((t) => Number.isFinite(t) && new Date(t).getUTCFullYear() < 2049);
  return ends.length ? new Date(Math.min(...ends)).toISOString() : null;
}
// Wolt campaign hours: conditions.weekly_time_restrictions, [{start, end}) in minutes
// after Monday 00:00, venue local time (Mon = 0–1439 … Sun = 8640–10079). Read as a
// deal.window when every range has the same hours (a lunch campaign: one range a day),
// so a morning scan keeps a campaign that opens at noon and the page hides it once it
// closes. null: no restriction, or one that spans the whole week. undefined: hours
// that do not fit one window (lunch Mon, dinner Tue) — not seen in the data yet.
export function campaignWindow(camp) {
  const r = camp.conditions?.weekly_time_restrictions;
  if (!Array.isArray(r) || !r.length) return null;
  const start = (r[0].start || 0) % 1440, len = (r[0].end || 0) - (r[0].start || 0);
  if (len <= 0 || len > 1440 || r.some((x) => (x.start || 0) % 1440 !== start || (x.end || 0) - (x.start || 0) !== len)) return undefined;
  const days = [...new Set(r.map((x) => Math.floor((x.start || 0) / 1440) + 1))].sort((a, b) => a - b);
  if (days.length === 7 && len === 1440) return null;
  return { days, start: hhmm(start * 60000), end: hhmm(((start + len) % 1440) * 60000) };
}
// A campaign whose hours fit no window is checked once, against the local clock at scan
// time (the venues sit near the scanned address, so they share its clock).
export function campaignOpenAtScan(camp) {
  if (campaignWindow(camp) !== undefined) return true;
  const c = venueClock(Date.now()), now = (c.day - 1) * 1440 + c.min;
  return camp.conditions.weekly_time_restrictions.some((w) => now >= (w.start || 0) && now < (w.end || 0));
}
export const withEnd = (deal, camp) => {
  const e = campaignEndsAt(camp), w = campaignWindow(camp);
  if (e) deal.ends_at = e;
  if (w) deal.window = w;
  return deal;
};
