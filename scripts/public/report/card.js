// One deal card, and the header over a group of them.
import { esc, ic, money, provName, provLogo, provBadge, hueOf, initialOf, headlineMinor, etaMax } from "./util.js";
import { S, PLUS_LABELS, realMinor, realWasMinor } from "./state.js";
import { categoryOf, CAT_EMOJI } from "./categories.js";
import { timePill, windowHours, isOpenNow } from "./timed.js";

const BOGO_RE = /pay(?: for)? 1\b|another 1 for free|get (?:another |1 more )?(?:1 )?(?:more )?for free|get 1 free|1\s*\+\s*1/i;
// Named Foody offers that cover several dishes or sizes (the scanner's own test).
const BUNDLE_RE = /bundle|combo|platter|sharing|party|feast|\bbox\b|meal deal|for \d|μερίδ/i;
// The offer in two or three words, for the photo tag. A compound deal says what it
// takes: "2 for 1", "Buy 3", "2 for €10", "Bundle", or "Whole menu" for a venue-wide
// discount. Empty for a plain markdown.
export function dealKind(d) {
  if (d.venue_level) return "Whole menu";
  const n = String(d.name || "");
  if (BOGO_RE.test(n)) return "2 for 1";
  const buy = n.match(/^Buy (\d+) /i);
  if (buy) return "Buy " + buy[1];
  const any = n.match(/any (\d+) .*? for (€\s?[\d.,]+)/i);
  if (any) return any[1] + " for " + any[2].replace(/\s/g, "");
  if (d.offer_id && BUNDLE_RE.test(n)) return "Bundle";
  return "";
}
// What the card calls a dish. Provider names carry menu numbers ("192. Volcano Roll"),
// claim instructions ("(Add this item twice …)") and the offer itself ("Add 2 Salads &
// Pay 1", "Buy 2 Burger"); the kind tag says the offer once, on the photo.
function cleanName(s) {
  s = String(s ?? "").replace(/^\d+\.\s*/, "").replace(/\s*\(Add this item twice[^)]*\)/i, "").replace(/^Buy \d+ /i, "");
  const m = s.match(/^Add 2 (.+?) (?:&|and) Pay(?: for)? 1\b/i);
  if (m && !/selected items/i.test(m[1])) s = m[1];
  return s.trim();
}
// An ALL-CAPS venue reads as shouting: "TYLICHTO AGORA (TYLIChTO AGORA)" → "Tylichto Agora".
function cleanVenue(s) {
  s = String(s ?? "").trim();
  const head = s.replace(/\s*\([^)]*\)\s*$/, "");
  if (head === head.toUpperCase() && /[A-Z]{3}/.test(head)) s = head.toLowerCase().replace(/(^|[\s&(/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  return s;
}

function thumb(d, title, venue) {
  // No photo, or one that fails to load: a tile in the venue's hue with its initial and
  // cuisine, never a blank box.
  const tile = `<span class="noimg" style="--h:${hueOf(venue || title)}"><b>${esc(initialOf(venue || title))}</b><small>${esc(categoryOf(d))}</small></span>`;
  const photo = d.image ? `<img src="${esc(d.image)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : "";
  const attrs = d.image ? ` data-preview="${esc(d.image)}" role="button" tabindex="0" title="Click to enlarge" aria-label="Enlarge photo of ${esc(title)}"` : "";
  const pct = d.discount_percentage || 0;
  const kind = dealKind(d);
  const plus = d.is_plus || d.is_wolt_plus;
  const tags = (pct > 0 ? `<span class="tag pct">−${pct}%</span>` : '<span class="tag pct">Menu</span>')
    + (kind ? `<span class="tag kind">${esc(kind)}</span>` : "")
    + (plus ? `<span class="tag plus" title="${esc(provName(d.provider))}+ subscription deal">${provLogo(d.provider)}${esc(d.plus_label || PLUS_LABELS[d.provider] || "+")}</span>` : "");
  return `<div class="thumb"${attrs}>${tile}${photo}<div class="tags">${tags}</div>${timePill(d)}</div>`;
}

// Price line: the real checkout price, the struck original (derived from the % when the
// feed carried none) and the saving. A whole-menu deal says its cut instead.
function priceRow(d) {
  const pct = d.discount_percentage || 0;
  if (d.venue_level) return `<span class="whole">${pct > 0 ? pct + "% off every dish" : "Browse the menu"}</span>`;
  const now = realMinor(d);
  const shown = now != null ? now : headlineMinor(d.headline);
  const was = d.original_minor != null ? realWasMinor(d) : (pct > 0 && pct < 100 && shown != null ? Math.round(shown / (1 - pct / 100)) : null);
  const wasHtml = was != null ? `<span class="was">${money(was, d.currency)}</span>` : "";
  if (now == null) return `<span class="whole" title="${esc(d.headline || "")}">${esc(d.headline || "Menu deal")}</span>${wasHtml}`;
  const req = d.mandatory_addon_minor
    ? `<span class="save" title="Includes the required ${esc((d.mandatory_addon_breakdown || []).map((b) => b.value).join(", ") || "options")}">incl. options</span>`
    : (was != null && was > now ? `<span class="save">save ${money(was - now, d.currency)}</span>` : "");
  return `<span class="price">${money(now, d.currency)}</span>${wasHtml}${req}`;
}

// Open in the app, plus the read-only look inside when the scan cannot show it: a Bolt
// whole-menu deal's prices, or what a Foody offer bundle holds.
function cardActions(d) {
  const href = d.item_url || d.venue_url || "";
  let look = "";
  if (d.venue_level && d.provider === "bolt" && d.venue_id) look = `<button class="btn sm subtle" type="button" data-menu="${esc(d.venue_id)}" data-menu-name="${esc(d.name)}" title="Prices at this venue, discount applied">${ic("list", "sm")}<span>Prices</span></button>`;
  else if (d.provider === "foody" && d.offer_id && d.venue_id) look = `<button class="btn sm subtle" type="button" data-offer="${esc(d.offer_id)}" data-offer-venue="${esc(d.venue_id)}" data-offer-name="${esc(d.name)}" data-offer-at="${esc(cleanVenue(d.venue_name || ""))}" title="The dishes this offer lets you pick">${ic("bag", "sm")}<span>What's in it</span></button>`;
  // Beside a second button the link names only the app, so neither label is cut.
  const label = (look ? "" : "Open in ") + esc(provName(d.provider));
  const open = href ? `<a class="btn sm" href="${esc(href)}" target="_blank" rel="noopener">${ic("ext", "sm")}<span>${label}</span><span class="sr-only"> (opens in new tab)</span></a>` : "";
  return open || look ? `<div class="cactions">${open}${look}</div>` : "";
}

export function card(d) {
  const venue = cleanVenue(d.venue_name || "");
  // A Foody offer is named by its offer; the rest by the dish, the kind tag says the offer.
  const title = d.venue_level ? venue || cleanVenue(d.name) : cleanName(d.provider === "foody" ? d.name : d.item_name || d.name) || d.name;
  const chain = d._chain_count > 1 ? `<span class="more">+${d._chain_count - 1} more</span>` : "";
  const sub = d.venue_level ? "Whole-menu deal" : venue;
  const eta = d.eta ? `<span class="${(etaMax(d.eta) || 0) > 55 ? "eta-slow" : ""}" title="Delivery time">${ic("clock", "sm")}${esc(/[a-z]/i.test(d.eta) ? d.eta : d.eta + " min")}</span>` : "";
  const rating = d.rating10 != null ? `<span title="Rating out of 10">${ic("star", "sm")}${d.rating10.toFixed(1)}</span>` : "";
  return `<article class="card${isOpenNow(d) ? "" : " closed"}">
    ${thumb(d, title, venue)}
    <div class="cbody">
      <div class="name" title="${esc(d.name)}">${esc(title)}</div>
      <div class="venue">${provLogo(d.provider)}<span>${esc(sub)}</span>${chain}</div>
      <div class="prow">${priceRow(d)}</div>
      <div class="meta">${windowHours(d)}${eta}${rating}</div>
    </div>
    ${cardActions(d)}
  </article>`;
}

const bandLabel = (p) => { const lo = Math.floor(p / 10) * 10; return lo >= 50 ? "50%+" : lo + "-" + (lo + 9) + "%"; };
// Cross-app key: the server's venue_key (normalized 2-word name) when present, else
// the same normalization of the venue name.
const normVenueKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 2).join(" ");
export function groupKey(d) {
  if (S.groupBy === "venuekey") return d.venue_key || normVenueKey(d.venue_name || d.name) || "-";
  if (S.groupBy === "venue") return d.venue_name || d.name || "-";
  if (S.groupBy === "band") return bandLabel(d.discount_percentage);
  return categoryOf(d);
}

// A cross-app venue group compares the providers side by side, the better rating
// marked: the "same venue, which app has the better offer" view.
function crossHeader(ds) {
  const byProv = {};
  for (const d of ds) { const p = d.provider; if (!byProv[p] || d.discount_percentage > byProv[p].discount_percentage) byProv[p] = d; }
  const ps = Object.keys(byProv), cross = ps.length > 1;
  const bestR = Math.max(...ds.map((d) => d.rating10 || 0));
  const title = cleanVenue(byProv.wolt?.venue_name || ds.find((d) => d.venue_name)?.venue_name || ds[0].name);
  const vs = ps.map((p) => {
    const d = byProv[p], win = cross && (d.rating10 || 0) === bestR;
    return `<span class="${win ? "win" : ""}">${provBadge(p)} <b>${d.discount_percentage}%</b>${d.rating10 != null ? " " + ic("star", "sm") + d.rating10.toFixed(1) : ""}</span>`;
  }).join("");
  return `<h2 class="group-h${cross ? " cross" : ""}">${esc(title)}${cross ? '<span class="gtag">cross-app</span>' : ""}<span class="gn">${ds.length}</span><span class="vs">${vs}</span></h2>`;
}
export function groupHeader(g, ds) {
  if (S.groupBy === "venuekey") return crossHeader(ds);
  const label = S.groupBy === "category" ? (CAT_EMOJI[g] || "🍽️") + " " + esc(g) : esc(g);
  return `<h2 class="group-h">${label}<span class="gn">${ds.length}</span></h2>`;
}
