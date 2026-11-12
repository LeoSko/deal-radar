// The review log of venue badges whose discount % neither the text parser nor the
// scan could derive. `--show-unparsed` summarizes it, to decide which parser rules or
// banlist entries to add.
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "../../lib/config.mjs";

const UNPARSED_LOG_PATH = configPath("unparsed_promos.jsonl");

const sampleKey = (s) => `${s.text}\t${s.venue_slug}`;

// The (text, venue) keys already in the log.
async function loggedKeys() {
  const seen = new Set();
  let raw = "";
  try {
    raw = await readFile(UNPARSED_LOG_PATH, "utf8");
  } catch {
    return seen;   // first run — no log yet
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { seen.add(sampleKey(JSON.parse(line))); } catch { /* a torn line: skip it */ }
  }
  return seen;
}

// Append unparsed badge samples to the JSONL log and return how many lines were
// actually written. Best-effort; failures don't stop the run.
//
// One line per (badge text, venue) — a badge that survives many scans is the same
// missing rule each time, and re-logging it buries the rare texts under thousands
// of repeats (one venue's badge had accumulated 70 copies).
async function recordUnparsedBadges(samples) {
  if (!samples.length) return 0;
  try {
    await mkdir(dirname(UNPARSED_LOG_PATH), { recursive: true });
    const seen = await loggedKeys();
    const fresh = samples.filter((s) => {
      if (seen.has(sampleKey(s))) return false;
      seen.add(sampleKey(s));
      return true;
    });
    if (!fresh.length) return 0;
    const ts = new Date().toISOString();
    await appendFile(UNPARSED_LOG_PATH, fresh.map((s) => JSON.stringify({ ts, ...s })).join("\n") + "\n");
    return fresh.length;
  } catch (e) {
    process.stderr.write(`(unparsed-log write failed: ${e.message})\n`);
  }
  return 0;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Reconcile unparsed badges against scan-derived %s, then log only the
// genuinely-underivable remainder (whole-order "X € off", fixed-price bundles
// with no original_price / campaign). A badge for a venue the scan priced has
// its % derived there — no parser rule needed.
// Only record/announce genuinely-unparsed badges in --scan mode (scanPctBySlug set):
// that's when we actually attempted to derive the % from the assortment and failed.
// Without --scan, a badge with no % in its text isn't a parser gap — it just needs a
// scan — so logging it would spam the review log with scan-resolvable venues.
export async function reportUnparsedBadges(unparsed, scanPctBySlug) {
  if (!scanPctBySlug) return;
  const resolvedBadges = [];
  const still = [];
  for (const u of unparsed) {
    const dp = u.venue_slug && scanPctBySlug.has(u.venue_slug) ? scanPctBySlug.get(u.venue_slug) : null;
    if (dp != null) resolvedBadges.push({ ...u, derived_pct: dp });
    else still.push(u);
  }
  const logged = await recordUnparsedBadges(still);
  if (logged) {
    process.stderr.write(`(logged ${plural(logged, "new unparsed badge")} — review with --show-unparsed)\n`);
  }
  if (resolvedBadges.length) {
    const ex = resolvedBadges
      .slice(0, 3)
      .map((r) => `${JSON.stringify(r.text)} → ${r.derived_pct}% @ ${r.venue_name}`)
      .join("; ");
    process.stderr.write(`(derived % via scan for ${plural(resolvedBadges.length, "venue badge")}: ${ex})\n`);
  }
}

// The log lines grouped by (kind, text), most venues first.
function groupSamples(lines) {
  const groups = new Map();
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const key = `${r.kind}\t${r.text}`;
    const g = groups.get(key) || { kind: r.kind, text: r.text, count: 0, venues: new Set(), lastSeen: r.ts };
    g.count++;
    if (r.venue_name) g.venues.add(r.venue_name);
    if (r.ts > g.lastSeen) g.lastSeen = r.ts;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export async function showUnparsedSummary() {
  let raw;
  try {
    raw = await readFile(UNPARSED_LOG_PATH, "utf8");
  } catch {
    console.log("No unparsed promos logged yet.");
    return;
  }
  const lines = raw.split("\n").filter(Boolean);
  const sorted = groupSamples(lines);
  console.log(`Unparsed badge log (${lines.length} samples across ${sorted.length} distinct texts):\n`);
  for (const g of sorted) {
    const sample = [...g.venues].slice(0, 3).join(", ") + (g.venues.size > 3 ? `, +${g.venues.size - 3}` : "");
    console.log(`  ${String(g.count).padStart(4)}  [${g.kind.padEnd(18)}]  ${JSON.stringify(g.text)}`);
    if (sample) console.log(`        venues: ${sample}`);
  }
  console.log(
    "\nCounts are venues carrying the badge, not scans — each (text, venue) is logged once.\n" +
    "Review categories:\n" +
    "  fixed_price / fixed_amount_off / named_offer — consider adding parser rules.\n" +
    "  unknown — likely needs a new parse pattern or banlist entry.\n" +
    "  delivery_fee / schedule_label / marketing_label / payment_promo / free_item — never logged.\n",
  );
}
