// Request pacing and retries for the per-venue Wolt endpoints (assortment and
// venue-dynamic), each held to its own measured rate ceiling.
import { woltFetch } from "../../lib/fetch.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unofficial Wolt consumer API rate limit, measured empirically (see
// docs note in SKILL.md): throughput plateaus at ~6.6 req/s across every
// concurrency setting, and anything faster gets 429'd regardless of how the
// concurrency is arranged. So the real governor is requests/second, not the
// worker count. We pace request *starts* to scanMaxRps (the measured ceiling
// minus a ~2% safety margin) via a shared monotonic "next slot" cursor; the
// worker pool just needs enough workers to keep this rate saturated.
let scanMaxRps = 6.4;  // ceiling ≈ 6.6 req/s − 2%; overridable via --scan-rps
// The venue-dynamic endpoint (order-xp) does NOT share the assortment's ceiling: measured
// on a live account, a burst of ~18 requests goes through and then EVERY request 429s for
// tens of seconds, while one request per 1.5 s runs indefinitely without a single 429. It
// is counted per account, not per IP. Pacing every request at the assortment rate is why venues came back with a menu
// and no campaigns: the menu call won, the campaign call was thrown away.
let dynMaxRps = 0.65;  // ≈ 1 request / 1.5 s; overridable via --dyn-rps

// --scan-rps / --dyn-rps: a value that is not a positive number keeps the default.
export function setRateLimits({ scanRps, dynRps }) {
  if (Number.isFinite(scanRps) && scanRps > 0) scanMaxRps = scanRps;
  if (Number.isFinite(dynRps) && dynRps > 0) dynMaxRps = dynRps;
}

// rps is a getter: --scan-rps / --dyn-rps reassign the ceilings after the gates exist.
function paceGate(rps) {
  let nextSlotMs = 0;
  return async () => {
    const minIntervalMs = 1000 / rps();
    const now = performance.now();
    const startAt = Math.max(now, nextSlotMs);
    nextSlotMs = startAt + minIntervalMs;
    const wait = startAt - now;
    if (wait > 0) await sleep(wait);
  };
}
const rateGate = paceGate(() => scanMaxRps);
const dynGate = paceGate(() => dynMaxRps);

// What a lost request is worth reporting as: the status the provider answered, else the
// transport error. The URL in the message is noise — every line carries the same one.
export const failReason = (e) => {
  const m = /→ (\d+)/.exec(e.message || "");
  return m ? "HTTP " + m[1] : (e.message || "unknown").replace(/https?:\/\/\S+/, "").slice(0, 60).trim();
};
// Worth another try: the rate cap (429), a server-side blip (5xx) and a dropped
// connection all answer nothing about the venue. Any other 4xx IS an answer (404 =
// venue gone), so it surfaces at once instead of costing three more requests.
const isTransient = (e) => /→ (429|5\d\d)/.test(e.message || "")
  || /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(e.message || "");

export async function fetchWithRetry(name, params, attempts = 3) {
  const dyn = name === "venue_dynamic";
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await (dyn ? dynGate() : rateGate());   // pace to that endpoint's measured ceiling
      return await woltFetch(name, params);
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e;
      // Once venue-dynamic throttles it stays shut for tens of seconds, so the 500 ms
      // step just spent the retries — back off in seconds there, not milliseconds.
      await sleep(dyn ? 2000 * 2 ** i : 500 * (i + 1));
    }
  }
  throw lastErr;
}
