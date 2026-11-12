// Venue promo badge texts ("Save 50% with W+", "Buy 2 Pay 1", "Lunch offer €8.90"):
// the discount % they state, or the kind of badge they are when they state none.

const SELECTED_ITEMS_RE = /selected\s+items?\b|on\s+(?:the\s+)?(?:[\w' -]+)\s+(?:serum|set|item|capsules|coffee|sandwich)\b/i;

// "Buy N[,]? Pay for M" and "Add 2 coffees and Pay 1" / "Add 2 Nicaragu Capsules Pay 1",
// with optional item words between.
const BUY_PAY_RES = [
  /\bbuy\s+(\d+)\b[^]{0,40}?\bpay\s*(?:for\s+)?(\d+)\b/i,
  /\badd\s+(\d+)\b[^]{0,60}?\bpay\s*(?:for\s+)?(\d+)\b/i,
];

// Parse a promo badge text into an effective discount percentage.
//
// Handles:
//   - "X% off" / "Save X% with W+" / "-X%"
//   - BOGO: "Buy N, Pay for M" / "Buy N Maki Pay 1" / "Add N ... Pay 1" → (N-M)/N
//   - Min-spend cashback: "X € off (spend Y €)" → X/Y floor
// Skips opaque badges (delivery-fee deals, "Friends offer", "FREE drink", "X € off"
// without min spend) → returns null and the caller filters them out.
export function parsePromoPct(txt) {
  if (!txt) return null;

  // "0 € delivery fee" etc. — not an item discount.
  if (/delivery\s+fee/i.test(txt)) return null;

  // 1) Plain pct: "30% off", "Save 50% with W+", "-30% on selected items".
  let m = txt.match(/(?:save\s+)?(\d{1,2})\s*%(?:\s*off)?/i);
  if (m) return parseInt(m[1], 10);
  m = txt.match(/-(\d{1,2})\s*%/);
  if (m) return parseInt(m[1], 10);

  // 2) BOGO.
  for (const re of BUY_PAY_RES) {
    m = txt.match(re);
    if (!m) continue;
    const bought = +m[1], paid = +m[2];
    if (bought > paid && bought > 0) return Math.round(((bought - paid) / bought) * 100);
  }
  // "Buy N and get M free"
  m = txt.match(/\bbuy\s+(\d+)\s+(?:and\s+)?get\s+(\d+)\s+free\b/i);
  if (m) {
    const bought = +m[1], free = +m[2];
    const total = bought + free;
    if (free > 0 && total > 0) return Math.round((free / total) * 100);
  }

  // 3) Cashback with min spend: "3 € off (spend 30 €)" → 10% floor.
  m = txt.match(/(\d+(?:[.,]\d+)?)\s*€\s*off\s*\(\s*spend\s+(\d+(?:[.,]\d+)?)\s*€/i);
  if (m) {
    const off = parseFloat(m[1].replace(",", "."));
    const spend = parseFloat(m[2].replace(",", "."));
    if (spend > 0) return Math.round((off / spend) * 100);
  }

  return null;
}

// Classify badges that parsePromoPct can't turn into a percentage. Used to (a)
// decide whether to log a badge for later review, and (b) skip well-known no-op
// labels ("New", "ONLY ON WOLT", schedule strings) silently.
//
// Categories:
//   - empty / no_text
//   - delivery_fee       → "0 € delivery fee", "Free delivery", "X & €0 Del. Fees"
//   - schedule_label     → "EVERY DAY | 07:00 - 24:00"
//   - marketing_label    → "New", "ONLY ON WOLT", "Friends offer"
//   - payment_promo      → "Enjoy €5 Cashback with Visa" (card campaign, every venue)
//   - free_item          → "FREE drink", "FREE side dish"
//   - fixed_price        → "Lunch offer €8.90", "My Box only €12.99", "2 FOR €9"
//   - fixed_amount_off   → "2 € off", "-€1.50 Poe's Chicken Strips" (no min spend → can't compute %)
//   - named_offer        → "Coffee Combo", "Party Offer", "Large & X-Large pizzas offer"
//   - unknown            → none of the above; worth manual review
export function classifyUnparsedBadge(text) {
  if (!text) return "no_text";
  const t = String(text).trim();
  if (!t.length) return "no_text";
  if (/delivery\s+fees?|free\s+delivery|del\.?\s*fees?/i.test(t)) return "delivery_fee";
  if (/^\s*every\s+day\b|\b\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}\b/i.test(t)) return "schedule_label";
  if (/^new\s*$|\bonly\s+on\s+wolt\b|^friends\s+offer\s*$/i.test(t)) return "marketing_label";
  // Card-issuer campaigns run Wolt-wide, so they carry a € amount but say nothing
  // about this venue's prices. Left unclassified they read as `fixed_price`, which
  // marks EVERY venue as carrying an offer badge worth deep-scanning.
  if (/\bwith\s+(visa|mastercard|maestro|amex|american\s+express)\b/i.test(t)) return "payment_promo";
  if (/\bfree\b/i.test(t)) return "free_item";
  // Anything with a €amount but no %: likely a fixed-price or fixed-€-off badge.
  if (/€\s*\d|(\d+(?:[.,]\d+)?)\s*€/.test(t) && !/%/.test(t)) {
    if (/\boff\b/i.test(t) || t.startsWith("-")) return "fixed_amount_off";
    return "fixed_price";
  }
  if (/\b(offer|deal|combo|bundle|lunch|party|box|platter|special)\b/i.test(t)) return "named_offer";
  return "unknown";
}

// Badge kinds that say nothing about item prices: never logged for review, never a
// reason to deep-scan a venue. Every other unparsed kind is a real offer whose % the
// text alone does not give.
const NO_OFFER_KINDS = new Set(["no_text", "delivery_fee", "schedule_label", "marketing_label", "payment_promo", "free_item"]);
export const isOfferKind = (kind) => !NO_OFFER_KINDS.has(kind);

export function venueScopeFromText(txt) {
  if (!txt) return "venue-wide";
  if (SELECTED_ITEMS_RE.test(txt)) return "selected";
  return "venue-wide";
}
