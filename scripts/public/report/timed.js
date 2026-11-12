// Time-limited deals on the card: the hours, a live countdown once the deal closes
// within URGENT_MS, and "Not now" or "Ended" while it is closed. The open/closed rules
// are the deal-window block that report.html copies from lib/deal-window.mjs.
import { esc, ic } from "./util.js";

const { venueClock, dealClosesAt, isUrgent, URGENT_MS } = window.dealWindow;

// One venue clock per render, not one Intl call per deal.
export let clockNow = venueClock(Date.now());
export const tickClock = () => { clockNow = venueClock(Date.now()); };
export const isOpenNow = (d) => dealClosesAt(d, clockNow) != null;
// Urgency adds less than half a 10-point discount band: it reorders neighbours, never a
// much steeper deal.
export const URGENT_W = 4;
export const dealScore = (d) => (d.discount_percentage||0) + (isUrgent(d, clockNow) ? URGENT_W : 0);

const DOW3 = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function windowLabel(w) {
  const ds = w.days, run = ds.length > 2 && ds[ds.length - 1] - ds[0] === ds.length - 1;
  return (w.start >= "10:00" && w.end <= "16:00" ? "Lunch " : "") + w.start + "–" + w.end
    + (ds.length === 7 ? "" : " " + (run ? DOW3[ds[0]] + "–" + DOW3[ds[ds.length - 1]] : ds.map((n) => DOW3[n]).join(",")));
}
const windowTip = (w) => "Orderable only " + windowLabel(w);

// The card's one time tag, top-left on the photo. The days sit in the tooltip; a closed
// deal's hours move to the meta line (windowHours).
export function timePill(d) {
  if (!d.window && !d.ends_at) return "";
  const closes = dealClosesAt(d, clockNow);
  const tip = d.window ? windowTip(d.window) : "The campaign ends " + new Date(Date.parse(d.ends_at)).toLocaleString();
  if (closes == null) return `<span class="tag twpill off" title="${esc(d.window ? tip : "The campaign has ended")}">${ic("clock", "sm")}<span>${d.window ? "Not now" : "Ended"}</span></span>`;
  if (closes - clockNow.ms <= URGENT_MS) return `<span class="tag twpill urgent" title="${esc(tip)}">${ic("clock", "sm")}<span class="cdown" data-cd="${new Date(closes).toISOString()}"></span></span>`;
  return d.window ? `<span class="tag twpill" title="${esc(tip)}">${ic("clock", "sm")}<span>${d.window.start}–${d.window.end}</span></span>` : "";
}
// A closed windowed deal says when it opens again on the meta line.
export const windowHours = (d) => (d.window && !isOpenNow(d) ? `<span class="dc-hours" title="${esc(windowTip(d.window))}">${d.window.start}–${d.window.end}</span>` : "");

const spanText = (m) => (m < 60 ? m + " min" : m % 60 === 0 ? m / 60 + " h" : Math.floor(m / 60) + "h " + (m % 60) + "m");
// Fill every [data-cd] countdown. Under a minute "in 0 min" reads as broken, so it says
// "any moment"; the last ten minutes take the warning colour.
export function countdowns() {
  for (const el of document.querySelectorAll("[data-cd]")) {
    const diff = Date.parse(el.dataset.cd) - Date.now();
    el.classList.toggle("cd-soon", diff <= 10 * 60000);
    el.textContent = diff < 60000 ? "Ends any moment" : "Ends in " + spanText(Math.round(diff / 60000));
  }
}
// A signature of which time-limited deals are open, closed or urgent: the page
// re-renders only when it changes, and otherwise just ticks the countdowns.
export function availability(deals) {
  let sig = "";
  for (const d of deals) if (d.window || d.ends_at) sig += dealClosesAt(d, clockNow) == null ? 0 : isUrgent(d, clockNow) ? 2 : 1;
  return sig;
}
