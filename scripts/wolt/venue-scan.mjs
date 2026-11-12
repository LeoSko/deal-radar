// Fetch + extract deals across many venues with bounded concurrency. Each venue
// needs two independent requests (assortment + dynamic) — they run in parallel,
// and up to `concurrency` venues are processed at once, so wall time is roughly
// (venues / concurrency) × round-trip instead of venues × 2 × round-trip. The
// 429 backoff in fetchWithRetry keeps us inside Wolt's rate limit.
import { mapPool } from "../../lib/pool.mjs";
import { fetchWithRetry, failReason, sleep } from "./rate-limit.mjs";
import { extractVenueDeals } from "./venue-deals.mjs";

const RETRY_PAUSE_MS = 15000;
// An account that is already being throttled 429s every campaign call, and each one
// then costs its retries plus 30 s of backoff — enough to stretch a scan past half an
// hour. After this many in a row, stop asking: the answer will not change
// inside this run, and the hole is reported either way.
const GIVE_UP_AFTER = 25;

// The venue-dynamic fetcher of one scan: it records each venue it lost, and stops
// asking once the account is throttled.
function dynamicFetcher(addr) {
  const state = { failed: [], streak: 0 };
  state.fetch = async (slug) => {
    if (state.streak >= GIVE_UP_AFTER) { state.failed.push({ slug, err: "skipped, account throttled" }); return null; }
    try {
      const dyn = await fetchWithRetry("venue_dynamic", { venue_slug: slug, lat: addr.lat, lon: addr.lon }, 5);
      state.streak = 0;
      return dyn;
    } catch (e) {
      state.streak++;
      state.failed.push({ slug, err: failReason(e) });
    }
    return null;
  };
  return state;
}

// Even at its own pace the campaign endpoint 429s a few venues per scan. Those venues
// keep their menu and lose every campaign deal. The throttle lifts within seconds, so
// after a pause ask once more, one venue at a time.
async function retryMenuOnly(scan, menuOnly, perVenue) {
  const { top, addr, dynamic, onBatch, progress } = scan;
  await sleep(RETRY_PAUSE_MS);
  const retried = new Set();
  for (const [i, ass] of menuOnly) {
    const v = top[i];
    let dyn = null;
    try {
      dyn = await fetchWithRetry("venue_dynamic", { venue_slug: v.slug, lat: addr.lat, lon: addr.lon }, 3);
    } catch {
      continue;   // still throttled: the venue stays in the SCAN-HOLE report
    }
    perVenue[i] = extractVenueDeals(v, ass, dyn);
    retried.add(v.slug);
    if (onBatch) onBatch(perVenue[i], progress());
  }
  for (let k = dynamic.failed.length - 1; k >= 0; k--) if (retried.has(dynamic.failed[k].slug)) dynamic.failed.splice(k, 1);
  process.stderr.write(`campaign retry: ${retried.size}/${menuOnly.size} venues recovered\n`);
}

function reportFailures(failed, dynFailed, total) {
  if (failed.length) {
    process.stderr.write(`${failed.length} venues failed (rate limit / 404 / etc).\n`);
  }
  if (dynFailed.length) {
    const why = new Map();
    for (const f of dynFailed) why.set(f.err, (why.get(f.err) || 0) + 1);
    const tally = [...why].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(", ");
    process.stderr.write(`SCAN-HOLE ${dynFailed.length}/${total} venues answered their menu but not their campaigns — their deals are missing: ${tally}\n`);
  }
}

export async function scanVenuesForDiscounts(venues, limit, addr, concurrency = 8, onBatch = null) {
  const top = venues.slice(0, limit);
  const failed = [];
  const dynamic = dynamicFetcher(addr);
  let done = 0;
  const scan = { top, addr, dynamic, onBatch, progress: () => ({ done, total: top.length }) };
  const menuOnly = new Map();   // venue index -> its assortment, for venues whose campaigns failed
  const perVenue = await mapPool(top, concurrency, async (v, i) => {
    let dealsForVenue = [];
    try {
      const [ass, dyn] = await Promise.all([
        fetchWithRetry("assortment", { venue_slug: v.slug }),
        // Every campaign deal of this venue lives in `dynamic`. Losing it means the
        // venue reads as having no offers at all: an "Add 2 Pastas & Pay 1" venue shows
        // the plain menu price. So retry it harder than the assortment, and when it
        // still fails, say so instead of silently reporting no deals.
        dynamic.fetch(v.slug),
      ]);
      if (!dyn) menuOnly.set(i, ass);
      dealsForVenue = extractVenueDeals(v, ass, dyn);
      return dealsForVenue;
    } catch (e) {
      failed.push({ slug: v.slug, err: (e.message || "").slice(0, 80) });
      return [];
    } finally {
      done++;
      if (onBatch) onBatch(dealsForVenue, scan.progress());
      if (done % 10 === 0) process.stderr.write(`scanned ${done}/${top.length} venues (${failed.length} failed)...\r`);
    }
  });
  process.stderr.write("\n");
  if (menuOnly.size && dynamic.streak < GIVE_UP_AFTER) await retryMenuOnly(scan, menuOnly, perVenue);
  reportFailures(failed, dynamic.failed, top.length);
  return perVenue.flat();
}
