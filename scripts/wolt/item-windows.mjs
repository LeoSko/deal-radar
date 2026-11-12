// Weekly hours of a Wolt menu item, and which items are narrower than the venue's
// usual hours (a lunch-only dish).

// Wolt item hours: available_times [{days, start_time, end_time}], ISO weekdays
// (1 = Monday; only 1..7 seen so far) and ms after the venue's local midnight. Outside
// its hours the assortment drops the item outright, so a lunch special scanned at 11:30
// would otherwise sit in the deals list all afternoon as a dish nobody can order.
export const hhmm = (ms) => { const m = Math.round(ms / 60000); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
function itemWindow(item) {
  const t = item.available_times;
  if (!Array.isArray(t) || !t.length) return null;
  // Several slots with different hours (lunch and dinner) do not fit one window: no chip
  // rather than a wrong one. Not seen in the data yet.
  if (t.some((x) => x.start_time !== t[0].start_time || x.end_time !== t[0].end_time)) return null;
  const days = [...new Set(t.flatMap((x) => x.days || []))].sort((a, b) => a - b);
  return { days, start: hhmm(t[0].start_time), end: hhmm(t[0].end_time) };
}
const dayMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
// Open minutes per week; a window past midnight (22:00–02:00) wraps.
export const windowMinutes = (w) => w.days.length * ((dayMin(w.end) - dayMin(w.start) + 1440) % 1440 || 1440);
const ALL_DAY = { days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "24:00" };
// Whether window `a` is open whenever `b` is: every day of b, over all of b's hours.
// Compared by days and hours, not by minutes a week: a Mon–Fri 24 h item has more
// minutes than a 7-day 11:00–22:30 kitchen and still cannot be ordered on Saturday.
function covers(a, b) {
  if (!b.days.every((d) => a.days.includes(d))) return false;
  const span = (w) => { const s = dayMin(w.start), e = dayMin(w.end); return [s, e > s ? e : e + 1440]; };
  const [as, ae] = span(a), [bs, be] = span(b);
  return ae - as >= 1440 || (as <= bs && ae >= be);
}
// A deal carries its window only when it is narrower than the venue's usual item hours —
// the most common window on its menu, which is the kitchen's opening hours. Most items
// carry those (on one noodle bar, 169 of 240 at 11:00–22:30), and a chip on every card that just
// repeats them would drown the lunch-only one. An item without hours sells whenever the
// venue is open, so it counts as all day: on a menu where only the lunch dish has hours,
// those hours are no venue's usual.
export function narrowItemWindows(items) {
  const tally = new Map();
  for (const it of items) { const k = JSON.stringify(itemWindow(it) || ALL_DAY); tally.set(k, (tally.get(k) || 0) + 1); }
  if (!tally.size) return new Map();
  const usual = JSON.parse([...tally].sort((a, b) => b[1] - a[1])[0][0]);
  const out = new Map();
  for (const it of items) {
    const w = itemWindow(it);
    if (w && !covers(w, usual)) out.set(String(it.id), w);
  }
  return out;
}
