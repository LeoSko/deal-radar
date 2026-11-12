// Small HTML helpers shared by the report modules.
export const $ = (id) => document.getElementById(id);
// The one way markup reaches the page. Every template here passes provider text through
// esc(), so the strings are trusted markup with escaped data.
export const frag = (html) => document.createRange().createContextualFragment(html);
export const setHtml = (el, html) => el.replaceChildren(frag(html));
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// One icon from the sprite (public/icons.svg).
export const ic = (name, cls = "") => `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="/public/icons.svg#i-${name}"/></svg>`;
const moneyFormats = new Map();
export const money = (m, c = "EUR") => {
  if (m == null) return "?";
  const cur = c || "EUR";
  if (!moneyFormats.has(cur)) moneyFormats.set(cur, new Intl.NumberFormat("en", { style: "currency", currency: cur }));
  return moneyFormats.get(cur).format(m / 100);
};
const PROV_NAMES = { wolt: "Wolt", bolt: "Bolt", foody: "Foody" };
export const provName = (p) => PROV_NAMES[p] || p;
// The provider's own logo (served from /logos); it drops out if it fails to load.
export const provLogo = (p) => `<img class="provlogo" src="/logos/${esc(p)}.png" alt="" onerror="this.remove()">`;
export const provBadge = (p) => `<span class="prov">${provLogo(p)}${esc(provName(p))}</span>`;
// A stable hue per name, for the photo fallback tile.
export const hueOf = (s) => { let x = 0; for (const ch of String(s || "")) x = (x * 31 + ch.charCodeAt(0)) % 360; return x; };
export const initialOf = (s) => (String(s || "?").trim()[0] || "?").toUpperCase();
// Pull a price (minor units) out of a headline like "Freddo Espresso · €4.00".
export const headlineMinor = (h) => {
  const m = String(h || "").match(/€\s*([\d.,]+)|([\d.,]+)\s*€/);
  if (!m) return null;
  const v = parseFloat((m[1] || m[2]).replace(",", "."));
  return isFinite(v) ? Math.round(v * 100) : null;
};
export const etaMin = (s) => { const m = String(s || "").match(/\d+/); return m ? +m[0] : null; };
export const etaMax = (s) => { const m = String(s || "").match(/\d+/g); return m ? +m[m.length - 1] : null; };
