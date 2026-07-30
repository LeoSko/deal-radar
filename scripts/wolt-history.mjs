#!/usr/bin/env node
// Export the whole Wolt order history — every order, with its full detail — to
// one JSON file. Wolt's app paginates the list and shows one order at a time;
// there is no export button, so this walks the same endpoints the web client
// uses with the tokens `bin/import-tokens.mjs wolt` already captured.
//
//   node scripts/wolt-history.mjs                  # → ~/.config/deal-radar/order-history
//   node scripts/wolt-history.mjs --out ~/wolt-dump
//   node scripts/wolt-history.mjs --rps 1 --concurrency 2   # gentler
//   node scripts/wolt-history.mjs --refetch        # ignore the cache
//   node scripts/wolt-history.mjs --stream         # NDJSON events (used by serve.mjs)
//
// Output:
//   DIR/wolt_history.json    – { meta, orders: [ …summary, details: { … } ] }
//   DIR/details/<id>.json    – raw detail responses; makes a re-run incremental
//
// Every detail response is cached, so an interrupted run resumes for free and a
// later run only fetches orders it hasn't seen.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadAuth, ensureAccessToken, authHeaders } from "../lib/auth.mjs";
import { fillTemplate } from "../lib/fetch.mjs";
import { configPath } from "../lib/config.mjs";
import { createRateGate } from "../lib/ratelimit.mjs";

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

function parseArgs(argv) {
  const opts = {
    out: configPath("order-history"),
    rps: 2, // starting pace only — the gate adapts from here
    concurrency: 4,
    limit: 50,
    refetch: false,
    stream: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--rps") opts.rps = Number(argv[++i]);
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--refetch") opts.refetch = true;
    else if (a === "--stream") opts.stream = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(
    "Usage: wolt-history.mjs [--out DIR] [--rps 2] [--concurrency 4] [--limit 50] [--refetch] [--stream]",
  );
  process.exit(0);
}

const gate = createRateGate({ rps: opts.rps });
const auth = await loadAuth();

// In --stream mode stdout is the event channel, so progress goes to stderr.
function log(msg) {
  process.stderr.write(`${msg}\n`);
}
function emit(evt) {
  if (opts.stream) process.stdout.write(JSON.stringify(evt) + "\n");
}

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    await gate.wait();
    const token = await ensureAccessToken(auth);
    let res, body;
    try {
      res = await fetch(url, { headers: authHeaders(token) });
      body = await res.text();
    } catch (e) {
      if (attempt >= BACKOFF_MS.length) throw e;
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      continue;
    }

    if (res.ok) {
      gate.reward();
      return JSON.parse(body);
    }

    if (res.status === 429 || res.status >= 500) {
      if (res.status === 429) attempt === 0 ? gate.penalise() : gate.countOnly();
      if (attempt >= BACKOFF_MS.length) {
        throw new Error(`${res.status} after ${attempt + 1} tries: ${body.slice(0, 160)}`);
      }
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : BACKOFF_MS[attempt];
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    // 401 mid-run means the access token died early — ensureAccessToken renews
    // it once expiry is cleared, so one retry is enough.
    if (res.status === 401 && attempt === 0) {
      auth.access_token_expires_at = 0;
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

const orderId = (o) => o.purchase_id ?? o.order_id ?? o.id;

// The list is cursor-paginated: the cursor is the timestamp of the oldest order
// on the page. Newer clients return it outright; fall back to deriving it.
function nextCursor(page, batch) {
  for (const k of ["next_page_token", "page_token", "next_token", "cursor"]) {
    if (page?.[k]) return page[k];
  }
  const last = batch.at(-1);
  const ts = last?.payment_time_ts ?? last?.purchase_date_ts;
  return typeof ts === "number" ? new Date(ts).toISOString() : null;
}

async function fetchSummaries() {
  const orders = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 1; ; page++) {
    const url = new URL(fillTemplate(auth.endpoints.order_history, { limit: opts.limit }));
    if (cursor) url.searchParams.set("page_token", cursor);
    const data = await getJson(url.toString());
    const batch = Array.isArray(data) ? data : data.orders || data.results || [];
    const fresh = batch.filter((o) => orderId(o) && !seen.has(orderId(o)));
    fresh.forEach((o) => seen.add(orderId(o)));
    orders.push(...fresh);
    log(`page ${page}: ${batch.length} orders (${fresh.length} new), total ${orders.length}`);
    emit({ type: "listing", pages: page, orders: orders.length });
    if (!fresh.length) break;
    const next = nextCursor(data, batch);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return orders;
}

async function fetchDetails(id) {
  const path = join(opts.out, "details", `${id}.json`);
  if (!opts.refetch && existsSync(path)) {
    return { data: JSON.parse(await readFile(path, "utf8")), cached: true };
  }
  const data = await getJson(fillTemplate(auth.endpoints.order_details, { order_id: id }));
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
  return { data, cached: false };
}

await mkdir(join(opts.out, "details"), { recursive: true });
log(`exporting order history → ${opts.out}`);
emit({ type: "start", out: opts.out });

const summaries = await fetchSummaries();
log(`${summaries.length} orders; fetching details…`);
emit({ type: "listed", total: summaries.length });

const orders = new Array(summaries.length);
const errors = [];
let cursor = 0;
let done = 0;
let cachedCount = 0;

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= summaries.length) return;
    const summary = summaries[i];
    const id = orderId(summary);
    try {
      const { data, cached } = await fetchDetails(id);
      if (cached) cachedCount++;
      orders[i] = { ...summary, details: data };
    } catch (e) {
      const error = String(e.message || e);
      errors.push({ order_id: id, error });
      orders[i] = { ...summary, details: null, details_error: error };
    }
    done++;
    if (done % 25 === 0 || done === summaries.length) {
      log(
        `  details ${done}/${summaries.length} — ${cachedCount} cached, ${errors.length} failed, ` +
          `gap ${gate.gapMs}ms, ${gate.rateLimited} × 429`,
      );
    }
    emit({
      type: "progress",
      done,
      total: summaries.length,
      cached: cachedCount,
      failed: errors.length,
      gap_ms: gate.gapMs,
      rate_limited: gate.rateLimited,
      venue: summary.venue_name || null,
    });
  }
}
await Promise.all(Array.from({ length: opts.concurrency }, worker));

const out = {
  meta: {
    fetched_at: new Date().toISOString(),
    order_count: orders.length,
    details_ok: orders.filter((o) => o.details).length,
    details_failed: errors.length,
    errors,
  },
  orders,
};
const outPath = join(opts.out, "wolt_history.json");
await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
log(`wrote ${outPath} — ${orders.length} orders, ${errors.length} detail failures`);
emit({ type: "done", out: outPath, total: orders.length, failed: errors.length });
