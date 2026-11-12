// Foody offer deals: a tiered bundle takes Foody's own calculated_price, and every offer
// deal keeps its offer id. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { offersToDeals } from "./foody.mjs";
import { offerPriceEur } from "../lib/foody-offer.mjs";

const venue = { shop_id: 7, name: "Pasta Place", slug: "/city/pasta-place-7", rating: 4.5 };
const catalog = (offer) => ({ data: { menu: { categories: [{ offers: [offer] }] } } });

test("a bundle offer is priced from calculated_price, its original backed out of the %", () => {
  const [d] = offersToDeals(catalog({ id: 42, title: "Any 2 Pasta For €10", discount: 0.2, calculated_price: "From 10.00€",
    tiers: [{ items: [{ name: "Carbonara", price: 7.5 }] }] }), venue);
  assert.equal(d.offer_id, "42");
  assert.equal(d.price_minor, 1000);
  assert.equal(d.original_minor, 1250);
  assert.equal(d.discount_percentage, 20);
  assert.equal(d.headline, "Carbonara · €7.50", "a reference item, not an invented price");
});

test("an explicit % offer prices its subject item", () => {
  const [d] = offersToDeals(catalog({ id: 5, title: "30% off Lasagna", discount: 0.3, items: [{ name: "Lasagna", price: 10 }] }), venue);
  assert.equal(d.name, "Lasagna");
  assert.equal(d.price_minor, 700);
  assert.equal(d.original_minor, 1000);
});

test("calculated_price parses either decimal mark, and nothing without a number", () => {
  assert.equal(offerPriceEur("5,90€"), 5.9);
  assert.equal(offerPriceEur("From 8.45€"), 8.45);
  assert.equal(offerPriceEur(null), null);
});
