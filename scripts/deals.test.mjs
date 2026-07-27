#!/usr/bin/env node
// Unit tests for the item_discount pricing logic — the % math the live scan
// can't fully exercise (notably the min_quantity ≥ 2 "buy N" bundle branch,
// which Wolt only intermittently ships). Run: node deals.test.mjs
import assert from "node:assert/strict";
import { computeItemDiscountDeal, campaignRequiredQty, isPlaceholderItemDiscount } from "./deals.mjs";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

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

console.log(`\n${pass} passed`);
