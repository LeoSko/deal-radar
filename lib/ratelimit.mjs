// Adaptive request pacing for Wolt's consumer API.
//
// The scanner's fixed 6.4 req/s gate works because the venue endpoints really do
// hold that rate. The order_history endpoints don't — they throttle far lower and
// a fixed rate degenerates into hammer-then-stall. This gate starts at `rps` and
// walks the gap AIMD-style: widen on a 429, creep back down while responses are
// clean, so a long run settles on whatever the endpoint currently allows.
//
//   const gate = createRateGate({ rps: 2 });
//   await gate.wait();               // before every request
//   res.ok ? gate.reward() : gate.penalise();

const CEILING_RPS = 6.4; // API-wide ceiling (~6.6 measured) − 2%

export function createRateGate({ rps = 2, maxGapMs = 3000 } = {}) {
  const minGapMs = Math.ceil(1000 / CEILING_RPS);
  let gapMs = Math.max(minGapMs, Math.ceil(1000 / rps));
  let nextSlot = 0;
  let okStreak = 0;
  let hits = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    // Hand out request start times from one shared cursor, so N workers still
    // add up to one paced stream.
    async wait() {
      const now = Date.now();
      const slot = Math.max(now, nextSlot);
      nextSlot = slot + gapMs;
      if (slot > now) await sleep(slot - now);
    },
    penalise() {
      hits++;
      okStreak = 0;
      gapMs = Math.min(maxGapMs, Math.max(minGapMs, Math.ceil(gapMs * 1.5)));
      nextSlot = Math.max(nextSlot, Date.now() + gapMs);
    },
    reward() {
      if (++okStreak >= 5 && gapMs > minGapMs) {
        okStreak = 0;
        gapMs = Math.max(minGapMs, Math.floor(gapMs * 0.8));
      }
    },
    // A 429 on a retry of the same request is the penalty already applied
    // arriving late; counting it again would stack the gap to the cap.
    countOnly() {
      hits++;
    },
    get gapMs() {
      return gapMs;
    },
    get rateLimited() {
      return hits;
    },
  };
}
