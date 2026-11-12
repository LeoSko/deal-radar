// Whether a deal can be ordered at a given moment. A scan runs once and its deals stay
// on the page for hours, but a Wolt lunch special (11:00–15:00) vanishes from the
// venue's menu once its hours end, and a campaign stops at its end date. deal.window
// ({days, start, end}: ISO weekdays and "HH:MM" in the venue's local time) and
// deal.ends_at (ISO) come from the scanner.
//
// The block below is meant to be copied verbatim into the report page, minus `export`,
// so the page and the scanner agree on what is open. Self-contained on purpose: the
// page has no module loader.

// ── deal-window: shared with the report page ──
// The venues of a scan sit near the address it scans, so the local clock of the
// machine (or the browser) reading the deals is the venues' clock.
const clockFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const CLOCK_DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
// Local wall clock at epoch `ms`: ISO weekday and minute of the day.
export function venueClock(ms) {
  const p = Object.fromEntries(clockFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { ms, day: CLOCK_DOW[p.weekday], min: +p.hour * 60 + +p.minute };
}
const hhmmMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
// Minutes until window `w` closes, or null when it is closed at clock `c`. A window
// past midnight (22:00–02:00) belongs to the day it opens on.
function windowLeft(w, c) {
  const s = hhmmMin(w.start), e = hhmmMin(w.end), prev = c.day === 1 ? 7 : c.day - 1;
  if (s < e) return w.days.includes(c.day) && c.min >= s && c.min < e ? e - c.min : null;
  if (w.days.includes(c.day) && c.min >= s) return e + 1440 - c.min;
  return w.days.includes(prev) && c.min < e ? e - c.min : null;
}
// Epoch ms when the deal stops being orderable: Infinity when nothing ends it, null when
// it cannot be ordered at clock `c` at all.
export function dealClosesAt(d, c) {
  const end = d.ends_at ? Date.parse(d.ends_at) : Infinity;
  if (end <= c.ms) return null;
  if (!d.window) return end;
  const left = windowLeft(d.window, c);
  return left == null ? null : Math.min(end, c.ms - (c.ms % 60000) + left * 60000);
}
// An open deal that closes within this long is urgent: it ranks a little higher and its
// card counts down.
export const URGENT_MS = 3 * 3600e3;
export function isUrgent(d, c) {
  const t = dealClosesAt(d, c);
  return t != null && t - c.ms <= URGENT_MS;
}
// ── end deal-window ──
