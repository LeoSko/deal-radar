// The shared scanner helpers: worker pool, venue join key, JWT decoding. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPool } from "./pool.mjs";
import { venueKey } from "./venue-key.mjs";
import { jwtPayload, jwtExp } from "./jwt.mjs";
import { venueKey as boltVenueKey } from "../scripts/bolt.mjs";
import { venueKey as foodyVenueKey } from "../scripts/foody.mjs";

test("mapPool keeps input order and caps in-flight calls", async () => {
  let inFlight = 0, peak = 0;
  const out = await mapPool([30, 5, 20, 1, 10], 2, async (ms, i) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ["0:30", "1:5", "2:20", "3:1", "4:10"]);
  assert.equal(peak, 2);
});

test("mapPool runs one worker when concurrency is below 1, and handles no items", async () => {
  assert.deepEqual(await mapPool([1, 2], 0, async (x) => x * 2), [2, 4]);
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});

test("branch noise drops off the venue key, so one chain joins across providers", () => {
  assert.equal(venueKey("Burger King Makariou"), "burger king");
  assert.equal(venueKey("Burger-King  Central!"), "burger king");
  assert.equal(venueKey(null), "");
});

test("the Bolt and Foody scanners use the shared venue key", () => {
  assert.equal(boltVenueKey, venueKey);
  assert.equal(foodyVenueKey, venueKey);
});

const jwt = (payload) => "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".sig";

test("jwtExp reads the exp claim in seconds", () => {
  assert.equal(jwtExp(jwt({ exp: 1900000000, data: { user_id: 7 } })), 1900000000);
  assert.equal(jwtPayload(jwt({ data: { user_id: 7 } })).data.user_id, 7);
});

test("jwtExp is 0 and jwtPayload null for a non-JWT", () => {
  for (const t of ["", "opaque-token", null, undefined, "a.!!!.c"]) {
    assert.equal(jwtExp(t), 0);
  }
  assert.equal(jwtPayload("opaque-token"), null);
  assert.equal(jwtExp(jwt({ iat: 1 })), 0);
  assert.equal(jwtExp(jwt(null)), 0);
});
