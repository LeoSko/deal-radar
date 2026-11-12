// Time-limited deals. A noodle bar sells its "Tempura Roll" only 11:00–15:00 (Wolt
// available_times); after 15:00 Wolt's menu drops it, but a morning scan kept showing
// it all day. The scanner now carries the window, and lib/deal-window.mjs says whether
// the deal is open at a given moment. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

// The venue clock is the machine's local clock: pin it, so wall times below are UTC.
process.env.TZ = "UTC";
const { extractVenueDeals } = await import("./wolt/venue-deals.mjs");
const { campaignEndsAt, campaignWindow } = await import("./wolt/campaigns.mjs");
const { venueClock, dealClosesAt, isUrgent } = await import("../lib/deal-window.mjs");

const H = 3600e3;
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7];
const times = (from, to, days = ALL_WEEK) => [{ days, start_time: from * H, end_time: to * H }];
const item = (id, name, at, o = {}) => ({ id, name, price: 1240, original_price: null, available_times: at, ...o });
// The shape of a raw assortment: most items at the kitchen's hours (11:00–22:30),
// some all day, and the lunch roll at 11:00–15:00, marked down 12.20 → 8.00.
const ass = {
  categories: [{ name: "LUNCH OFFERS", item_ids: ["roll"] }],
  items: [
    item("a1", "Chicken Ramen", times(11, 22.5), { price: 900, original_price: 1200 }),
    item("a2", "Yaki Soba", times(11, 22.5)),
    item("a3", "Katsu Curry", times(11, 22.5)),
    item("a4", "Edamame", times(0, 24), { price: 300, original_price: 450 }),
    item("roll", "Tempura Roll", times(11, 15), { price: 800, original_price: 1220 }),
  ],
};
const v = { slug: "noodle-bar", name: "Noodle Bar", id: "v1", currency: "EUR" };
const camp = (end_date, items) => ({ id: `venue_campaign:${end_date}`, end_date, fire_deal_expires_at: null,
  description: { title: "50% discount on selected items" }, conditions: {},
  effects: { item_discount: { fraction: 0.5, include: { items }, exclude_options: false } } });
const byName = (deals) => Object.fromEntries(deals.map((d) => [d.item_name, d]));

test("a deal narrower than the venue's usual item hours carries its window", () => {
  const d = byName(extractVenueDeals(v, ass, null));
  assert.deepEqual(d["Tempura Roll"].window, { days: ALL_WEEK, start: "11:00", end: "15:00" });
  assert.equal(d["Chicken Ramen"].window, undefined, "the kitchen's own hours are no restriction");
  assert.equal(d["Edamame"].window, undefined, "wider than usual is no restriction either");
});

test("a campaign deal carries its end only when the campaign has one", () => {
  const dyn = { venue_raw: { discounts: [camp("2026-11-30T21:59:59.999000+00:00", ["roll"]), camp("2050-01-01T00:00:00+00:00", ["a2"])] } };
  const d = byName(extractVenueDeals(v, ass, dyn));
  assert.equal(d["Tempura Roll"].ends_at, "2026-11-30T21:59:59.999Z");
  assert.equal(d["Tempura Roll"].window.end, "15:00", "the campaign deal keeps the item's window");
  assert.equal(d["Yaki Soba"].ends_at, undefined, "2050-01-01 means open-ended");
  assert.equal(campaignEndsAt({ end_date: "2050-01-01T00:00:00+00:00", fire_deal_expires_at: "2026-11-07T10:00:00Z" }), "2026-11-07T10:00:00.000Z");
});

// 2026-11-06 is a Friday (ISO weekday 5).
const wall = (s) => Date.parse(s + "Z");
const at = (s) => venueClock(wall(s));
const LUNCH = { window: { days: ALL_WEEK, start: "11:00", end: "15:00" } };

test("a window is open from its start minute up to, not including, its end", () => {
  assert.equal(dealClosesAt(LUNCH, at("2026-11-06T10:59")), null);
  assert.equal(dealClosesAt(LUNCH, at("2026-11-06T11:00")), wall("2026-11-06T15:00"));
  assert.equal(dealClosesAt(LUNCH, at("2026-11-06T14:59")), wall("2026-11-06T15:00"));
  assert.equal(dealClosesAt(LUNCH, at("2026-11-06T15:00")), null);
});

test("a window is closed on a day it does not list", () => {
  const weekdays = { window: { days: [1, 2, 3, 4, 5], start: "11:00", end: "15:00" } };
  assert.notEqual(dealClosesAt(weekdays, at("2026-11-06T12:00")), null, "Friday");
  assert.equal(dealClosesAt(weekdays, at("2026-11-07T12:00")), null, "Saturday");
  assert.notEqual(dealClosesAt(weekdays, at("2026-11-09T12:00")), null, "Monday");
});

test("a window past midnight belongs to the day it opens on", () => {
  const late = { window: { days: [5], start: "22:00", end: "02:00" } };
  assert.equal(dealClosesAt(late, at("2026-11-06T23:00")), wall("2026-11-07T02:00"));
  assert.equal(dealClosesAt(late, at("2026-11-07T01:00")), wall("2026-11-07T02:00"), "Friday night, Saturday clock");
  assert.equal(dealClosesAt(late, at("2026-11-07T23:00")), null, "Saturday is not listed");
  assert.equal(dealClosesAt(late, at("2026-11-06T01:00")), null, "Thursday night is not listed");
});

test("a deal past its campaign end is closed, and the earlier of the two ends wins", () => {
  const ends_at = "2026-11-06T14:30:00.000Z";
  assert.equal(dealClosesAt({ ends_at }, at("2026-11-06T14:30")), null);
  assert.equal(dealClosesAt({ ends_at }, at("2026-11-06T14:00")), Date.parse(ends_at));
  assert.equal(dealClosesAt({ ...LUNCH, ends_at }, at("2026-11-06T12:00")), Date.parse(ends_at));
  assert.equal(dealClosesAt({}, at("2026-11-06T12:00")), Infinity);
});

test("an open deal closing within three hours is urgent, a closed or all-day one is not", () => {
  assert.equal(isUrgent(LUNCH, at("2026-11-06T13:00")), true);
  assert.equal(isUrgent(LUNCH, at("2026-11-06T11:00")), false, "4 h left");
  assert.equal(isUrgent(LUNCH, at("2026-11-06T16:00")), false, "closed");
  assert.equal(isUrgent({}, at("2026-11-06T13:00")), false);
});

test("an item without hours counts as all day, so a lone lunch dish still carries its window", () => {
  const menu = { items: [item("b1", "Pizza", null), item("b2", "Pasta", []), item("b3", "Salad", undefined),
    item("b4", "Lunch Menu", times(11, 15), { price: 800, original_price: 1200 })] };
  assert.deepEqual(byName(extractVenueDeals(v, menu, null))["Lunch Menu"].window, { days: ALL_WEEK, start: "11:00", end: "15:00" });
});

test("an item missing one of the usual days carries its window, however long its hours", () => {
  const menu = { items: [item("c1", "Ramen", times(11, 22.5)), item("c2", "Soba", times(11, 22.5)),
    item("c3", "Weekday Box", times(0, 24, [1, 2, 3, 4, 5]), { price: 800, original_price: 1200 })] };
  assert.deepEqual(byName(extractVenueDeals(v, menu, null))["Weekday Box"].window.days, [1, 2, 3, 4, 5]);
});

// Wolt's own campaign hours: minutes after Monday 00:00, one range a day.
const lunchDays = (days) => days.map((d) => ({ start: (d - 1) * 1440 + 660, end: (d - 1) * 1440 + 900 }));
test("a campaign's weekly_time_restrictions become the deal's window, for item_discount and free_items alike", () => {
  const disc = { ...camp("2050-01-01T00:00:00+00:00", ["a2"]), conditions: { weekly_time_restrictions: lunchDays([1, 2, 3, 4, 5]) } };
  const bogo = { id: "venue_campaign:bogo", end_date: null, description: { title: "Buy 2 pay 1" },
    conditions: { weekly_time_restrictions: lunchDays([1, 2, 3, 4, 5]) }, effects: { free_items: { buy: 1, get: 1, include: { items: ["a3"] } } } };
  const d = byName(extractVenueDeals(v, ass, { venue_raw: { discounts: [disc, bogo] } }));
  const want = { days: [1, 2, 3, 4, 5], start: "11:00", end: "15:00" };
  assert.deepEqual(d["Yaki Soba"].window, want, "kept whatever the scan's clock, hidden once it closes");
  assert.deepEqual(d["Katsu Curry"].window, want);
});

test("campaign hours that span the week are no window, and mixed hours fit none", () => {
  assert.equal(campaignWindow({ conditions: { weekly_time_restrictions: null } }), null);
  assert.equal(campaignWindow({ conditions: { weekly_time_restrictions: ALL_WEEK.map((d) => ({ start: (d - 1) * 1440, end: d * 1440 })) } }), null);
  assert.deepEqual(campaignWindow({ conditions: { weekly_time_restrictions: [{ start: 5 * 1440 + 1320, end: 5 * 1440 + 1560 }] } }),
    { days: [6], start: "22:00", end: "02:00" }, "past midnight stays on the day it opens");
  assert.equal(campaignWindow({ conditions: { weekly_time_restrictions: [{ start: 660, end: 900 }, { start: 1440 + 1080, end: 1440 + 1320 }] } }), undefined);
});
