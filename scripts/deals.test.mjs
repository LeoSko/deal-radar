// Unit tests for the item_discount pricing logic — the % math the live scan
// can't fully exercise (notably the min_quantity ≥ 2 "buy N" bundle branch,
// which Wolt only intermittently ships). Run: npm test
import { test as t } from "node:test";
import assert from "node:assert/strict";
import { computeItemDiscountDeal, campaignRequiredQty, isPlaceholderItemDiscount } from "./wolt/campaigns.mjs";
import { classifyUnparsedBadge } from "./wolt/promo-badges.mjs";
import { extractVenueDeals } from "./wolt/venue-deals.mjs";

// ---- computeItemDiscountDeal -------------------------------------------------

t("fraction: 40% off €8.00 → €4.80 / 40%, single unit", () => {
  const r = computeItemDiscountDeal(800, { fraction: 0.4, reqQty: 1 });
  assert.deepEqual(r, { price: 480, original: 800, pct: 40, bundleQty: 1 });
});

t("fraction is qty-independent: reqQty 2 still prices ONE unit", () => {
  const r = computeItemDiscountDeal(800, { fraction: 0.4, reqQty: 2 });
  assert.equal(r.original, 800);   // not 1600 — fraction is per-unit
  assert.equal(r.pct, 40);
});

t("flat amount, single item (reqQty 1): €5.05 off €12.95 → €7.90 / 39%", () => {
  const r = computeItemDiscountDeal(1295, { amount: 505, reqQty: 1 });
  assert.deepEqual(r, { price: 790, original: 1295, pct: 39, bundleQty: 1 });
});

t("flat amount on a pre-made 2-pack item (reqQty 1): €4.50 off €11.00 → €6.50 / 41%", () => {
  // This is the LIVE BK binding: campaign on the €11.00 two-pack, no qty gate.
  const r = computeItemDiscountDeal(1100, { amount: 450, reqQty: 1 });
  assert.deepEqual(r, { price: 650, original: 1100, pct: 41, bundleQty: 1 });
});

t("THE BUG: flat €4.50 off a single €5.50 burger, no qty gate → SKIP (was €1.00/82%)", () => {
  const r = computeItemDiscountDeal(550, { amount: 450, reqQty: 1 });
  assert.equal(r, null);  // 450/550 = 82% > 70% guard → never surfaced
});

t("buy-N bundle: €4.50 off €5.50 with reqQty 2 → bundle €11.00→€6.50 / 41%", () => {
  // Same campaign correctly gated: discount lands once on the 2-unit basket.
  const r = computeItemDiscountDeal(550, { amount: 450, reqQty: 2 });
  assert.deepEqual(r, { price: 650, original: 1100, pct: 41, bundleQty: 2 });
});

t("max_amount_per_item caps the flat discount", () => {
  const r = computeItemDiscountDeal(1000, { amount: 800, maxPerItem: 300, reqQty: 1 });
  assert.deepEqual(r, { price: 700, original: 1000, pct: 30, bundleQty: 1 });
});

t("max_amount_per_item caps the fraction discount", () => {
  const r = computeItemDiscountDeal(2000, { fraction: 0.5, maxPerItem: 300, reqQty: 1 });
  assert.equal(r.price, 1700);  // capped at 300 off, not 1000
  assert.equal(r.pct, 15);
});

t("zero/garbage price → null", () => {
  assert.equal(computeItemDiscountDeal(0, { fraction: 0.4 }), null);
  assert.equal(computeItemDiscountDeal(null, { amount: 100 }), null);
});

t("amount ≥ bundle total → null (would imply free/negative)", () => {
  // bundle total = 500×2 = 1000; amount must reach it to be nonsensical.
  assert.equal(computeItemDiscountDeal(500, { amount: 1000, reqQty: 2 }), null);
  assert.deepEqual(computeItemDiscountDeal(500, { amount: 500, reqQty: 2 }), // valid: 50% off the €10 pair
    { price: 500, original: 1000, pct: 50, bundleQty: 2 });
});

t("tiny fraction / zero effective discount → null", () => {
  assert.equal(computeItemDiscountDeal(500, { fraction: 0.0001, reqQty: 1 }), null);
});

// ---- campaignRequiredQty -----------------------------------------------------

t("requiredQty: no basket_contains → 1", () => {
  assert.equal(campaignRequiredQty({ conditions: {} }), 1);
});

t("requiredQty: real min_quantity 2 → 2", () => {
  assert.equal(campaignRequiredQty({ conditions: { basket_contains: [{ min_quantity: 2 }] } }), 2);
});

t("requiredQty: sentinel min_quantity 5000 ignored → 1", () => {
  assert.equal(campaignRequiredQty({ conditions: { basket_contains: [{ min_quantity: 5000 }] } }), 1);
});

t("requiredQty: title wording does NOT bump qty (binding-ambiguous)", () => {
  // "Royal Meal for 2" is a product name; "get the second" varies by binding —
  // only the structural min_quantity is trusted.
  const camp = { description: { title: "Buy 1 Big King Chicken & Get the Second on €1" }, conditions: {} };
  assert.equal(campaignRequiredQty(camp), 1);
});

// ---- isPlaceholderItemDiscount ----------------------------------------------

t("placeholder: 'up to X%' title", () => {
  assert.equal(isPlaceholderItemDiscount({ description: { title: "Up to 35% with W+" }, conditions: {} }, { fraction: 0.0001 }), true);
});

t("placeholder: sentinel min_quantity 10000", () => {
  assert.equal(isPlaceholderItemDiscount({ conditions: { basket_contains: [{ min_quantity: 10000 }] } }, { amount_per_item: 1 }), true);
});

t("placeholder: fraction 0.0001 stub", () => {
  assert.equal(isPlaceholderItemDiscount({ conditions: {} }, { fraction: 0.0001 }), true);
});

t("placeholder: amount_per_item 1 stub", () => {
  assert.equal(isPlaceholderItemDiscount({ conditions: {} }, { amount_per_item: 1 }), true);
});

t("NOT placeholder: real 40% fraction", () => {
  assert.equal(isPlaceholderItemDiscount({ description: { title: "Save 40% with W+" }, conditions: {} }, { fraction: 0.4 }), false);
});

t("NOT placeholder: real €5.05 flat off", () => {
  assert.equal(isPlaceholderItemDiscount({ description: { title: "Big King Deal €7.90" }, conditions: {} }, { amount_per_item: 505 }), false);
});

// ---- classifyUnparsedBadge ---------------------------------------------------

t("payment_promo: card campaign is not a venue offer", () => {
  assert.equal(classifyUnparsedBadge("Enjoy €5 Cashback with Visa"), "payment_promo");
  assert.equal(classifyUnparsedBadge("€10 back with Mastercard"), "payment_promo");
});

t("payment_promo does NOT swallow a venue cashback badge", () => {
  assert.equal(classifyUnparsedBadge("€5 cashback on orders over €30"), "fixed_price");
});

t("delivery_fee: the '& €0 Del. Fees' brand-tie-in form", () => {
  assert.equal(classifyUnparsedBadge("Charalambides & €0 Del. Fees"), "delivery_fee");
});

// ---- stacked campaigns -------------------------------------------------------
// A venue campaign ("50% discount on selected items") on an item the venue already
// marked down (€8.00, was €12.20) costs €4.00: 67% off the struck price, not 50%.

t("a campaign on a marked-down item counts from the struck price", () => {
  assert.deepEqual(computeItemDiscountDeal(800, { fraction: 0.5, wasMinor: 1220 }),
    { price: 400, original: 1220, pct: 67, bundleQty: 1 });
});

t("an item with no markdown keeps its own price as the original", () => {
  assert.deepEqual(computeItemDiscountDeal(1240, { fraction: 0.5 }),
    { price: 620, original: 1240, pct: 50, bundleQty: 1 });
});

t("a flat bundle cut stacks on the struck price per unit", () => {
  assert.deepEqual(computeItemDiscountDeal(500, { amount: 300, reqQty: 2, wasMinor: 600 }),
    { price: 700, original: 1200, pct: 42, bundleQty: 2 });
});

// ---- free_items (BOGO) campaigns ---------------------------------------------

const venue = { slug: "grill", name: "Grill House", id: "v1", currency: "EUR" };
const bogo = (items) => ({ venue_raw: { discounts: [{ id: "c1", description: { title: "Buy 2 pay 1" }, conditions: {},
  effects: { free_items: { buy: 1, get: 1, include: { items } } } }] } });

t("a BOGO on an item that already bakes the BOGO into its markdown is skipped", () => {
  const ass = { items: [{ id: "i1", name: "Loukaniko", price: 680, original_price: 1360 }] };
  const deals = extractVenueDeals(venue, ass, bogo(["i1"]));
  assert.equal(deals.filter((d) => d.badges.length).length, 0);
  assert.equal(deals[0].price_minor, 680, "the markdown deal alone stays");
});

t("a BOGO on a plain item prices one piece at half", () => {
  const ass = { items: [{ id: "i2", name: "Souvlaki", price: 900 }] };
  const [d] = extractVenueDeals(venue, ass, bogo(["i2"]));
  assert.equal(d.price_minor, 450);
  assert.equal(d.discount_percentage, 50);
  assert.equal(d.name, "Buy 2 pay 1 (Souvlaki)");
});

t("a buy-N bundle campaign names the bundle and prices the whole basket", () => {
  const ass = { items: [{ id: "i3", name: "Big Burger", price: 550 }] };
  const dyn = { venue_raw: { discounts: [{ id: "c2", description: { title: "Buy 1 get the second for €1" },
    conditions: { basket_contains: [{ min_quantity: 2 }] }, effects: { item_discount: { amount_per_item: 450, include: { items: ["i3"] } } } }] } };
  const [d] = extractVenueDeals(venue, ass, dyn);
  assert.equal(d.name, "Buy 2 Big Burger — Buy 1 get the second for €1");
  assert.equal(d.price_minor, 650);
  assert.equal(d.original_minor, 1100);
});
