// The report page carries its own copy of lib/deal-window.mjs (the page has no module
// loader for lib/), and ranks and hides time-limited deals with it. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("./public/report.html");
const mod = read("../lib/deal-window.mjs");
const timed = read("./public/report/timed.js");
const filters = read("./public/report/filters.js");
const block = (s) => s.slice(s.indexOf("// ── deal-window: shared"), s.indexOf("// ── end deal-window ──"));

test("the report page runs the same open/closed rules as the scanner", () => {
  assert.ok(block(mod).length > 200);
  assert.equal(block(html), block(mod).replace(/^export /gm, ""));
});

test("urgency nudges the sort score by less than half a discount band", () => {
  const w = +timed.match(/URGENT_W = (\d+)/)[1];
  assert.ok(w > 0 && w < 5);
  assert.match(timed, /const dealScore = \(d\) => \(d\.discount_percentage\|\|0\) \+ \(isUrgent\(d, clockNow\) \? URGENT_W : 0\)/);
  assert.match(filters, /\(dealScore\(b\) - dealScore\(a\)\)/, "the grid sorts by the score");
});

test("a closed deal is out of the default grid until Not now shows it", () => {
  assert.match(filters, /if \(!S\.showClosed\) list = list\.filter\(isOpenNow\)/);
  assert.match(filters, /data-show="closed"', "Not now"/);
});
