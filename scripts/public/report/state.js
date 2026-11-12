// The report's one state object, shared by every module, and its persistence.
import { $, etaMin } from "./util.js";

export const S = {
  deals: new Map(),          // dealKey -> deal (merged across providers)
  providers: [],             // provider ids in this scan
  groupBy: "none",
  activeCats: new Set(),     // empty = all categories; the Meal chips bulk-toggle these
  activeProvs: new Set(),    // empty = all providers
  activePlus: new Set(),     // providers whose "+" (subscription) deals to show
  query: "",                 // fulltext search
  showDrinks: false,         // drink deals hidden until toggled on
  showAlcohol: false,        // alcohol hidden until toggled on
  // Time-limited deals closed right now stay out of the grid until the Not now chip
  // shows them. Dimming them in place would leave a lunch special the top card all
  // afternoon. Not saved: the next visit starts with what can be ordered.
  showClosed: false,
};
export const PLUS_LABELS = { wolt: "W+", bolt: "B+", foody: "F+" };
export const GROUP_OPTS = [["none", "None"], ["category", "Cuisine"], ["venuekey", "Venue · cross-app"], ["venue", "Venue (exact)"], ["band", "Discount band"]];

// What the dish really costs at checkout. A required option group (size, base) adds to
// the base price, and Wolt applies the item discount to it too, so the scanner's
// effective_min_minor is the honest price; the bare base is not.
export const realMinor = (d) => d.effective_min_minor ?? d.price_minor;
export const realWasMinor = (d) => (d.original_minor != null ? d.original_minor + (d.mandatory_addon_minor || 0) : null);

// Dual-range filters: price (€), delivery (min), rating (/10).
export const RKEYS = ["price", "eta", "rating"];
export const rcfg = {
  price: { step: 0.5, val: (d) => (realMinor(d) != null ? realMinor(d) / 100 : null), dropNull: true },
  eta: { step: 1, val: (d) => etaMin(d.eta) },
  rating: { step: 0.1, val: (d) => d.rating10 },
};
export const rng = {};
for (const k of RKEYS) rng[k] = { min: 0, max: 0, lo: 0, hi: 0, touched: false };

// Include name+% so several offers at one venue (Foody lists many per shop, all sharing
// the venue URL) stay distinct instead of collapsing to one card.
export const dealKey = (d) => d.provider + "::" + (d.item_url || d.venue_key || "") + "::" + d.name + "::" + d.discount_percentage;
// Auto-scan (--json) Wolt deals carry is_wolt_plus but not the unified is_plus, which
// the "+" chips key off. Normalize on ingest.
export function normalizeDeal(d) {
  if (d && d.is_wolt_plus && !d.is_plus) { d.is_plus = true; if (!d.plus_label) d.plus_label = PLUS_LABELS[d.provider] || "+"; }
  return d;
}

// --- filter persistence (localStorage, per browser) --------------------------
const FKEY = "deal_radar_filters";
let lastSaved = "";
export function saveFilters() {
  const s = JSON.stringify({
    provs: [...S.activeProvs], plus: [...S.activePlus], cats: [...S.activeCats],
    q: S.query, drinks: S.showDrinks, alcohol: S.showAlcohol, groupBy: S.groupBy,
    rng: Object.fromEntries(RKEYS.map((k) => [k, [rng[k].lo, rng[k].hi, rng[k].touched]])),
  });
  if (s === lastSaved) return;   // only write when something changed
  lastSaved = s;
  try { localStorage.setItem(FKEY, s); } catch { lastSaved = ""; }   // storage unavailable: retry next render
}
function readSaved() {
  try { return JSON.parse(localStorage.getItem(FKEY) || "null"); } catch { return null; }
}
export function restoreFilters() {
  const s = readSaved();
  if (!s) return;
  (s.provs || []).forEach((x) => S.activeProvs.add(x));
  (s.plus || []).forEach((x) => S.activePlus.add(x));
  (s.cats || []).forEach((x) => S.activeCats.add(x));
  if (typeof s.q === "string") { S.query = s.q; $("search").value = s.q; }
  if (typeof s.drinks === "boolean") S.showDrinks = s.drinks;
  if (typeof s.alcohol === "boolean") S.showAlcohol = s.alcohol;
  if (s.groupBy) S.groupBy = s.groupBy;
  for (const k of RKEYS) {
    const r = s.rng?.[k];
    if (r) { rng[k].lo = r[0]; rng[k].hi = r[1]; rng[k].touched = !!r[2]; }
  }
}
