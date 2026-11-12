// Read-only looks behind a card: the photo lightbox, the prices behind a Bolt whole-menu
// deal (/bolt-menu) and the dishes a Foody offer bundle lets you pick (/foody-offer).
// Both lists relay the provider's own prices; nothing here applies a discount.
import { esc, ic, money, setHtml } from "./util.js";

// One overlay at a time; Esc is caught before the Filters sheet sees it.
function overlay(el, onShut) {
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
  function shut() { el.remove(); document.removeEventListener("keydown", onKey, true); onShut?.(); }
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(el);
  return shut;
}

function preview(url) {
  const ov = document.createElement("div");
  ov.className = "imgview";
  setHtml(ov, `<img src="${esc(url)}" alt=""><button class="iconbtn imgview-x" type="button" aria-label="Close">${ic("x")}</button>`);
  ov.addEventListener("click", overlay(ov));
}

// A modal with a title and a scrolling body that says "Reading…" until `load` fills it.
function modal(title, sub, load) {
  const back = document.createElement("div");
  back.className = "modal-back";
  setHtml(back, `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}${sub ? `<span class="msub">${esc(sub)}</span>` : ""}</h2>
      <button class="iconbtn" type="button" data-mclose aria-label="Close">${ic("x")}</button></header>
    <div class="mbody"><p class="muted">Reading…</p></div></div>`);
  const opener = document.activeElement;
  const shut = overlay(back, () => opener?.focus?.());
  back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-mclose]")) shut(); });
  back.querySelector("[data-mclose]").focus();
  const body = back.querySelector(".mbody");
  load().then((html) => setHtml(body, html)).catch((e) => setHtml(body, `<p class="muted">Unavailable: ${esc(e.message)}</p>`));
}
async function getJson(url) {
  const j = await (await fetch(url)).json();
  if (j.error) throw new Error(j.error);
  return j;
}

const priceHtml = (m, c) => (m != null ? `<span class="price">${money(m, c)}</span>` : '<span class="mi-note">no price</span>');
// A required option group (size, base) is no extra: the dish cannot be ordered without
// it, so its cheapest pick belongs in the real minimum.
function menuRow(it) {
  const was = it.original_minor != null ? `<span class="was">${money(it.original_minor, it.currency)}</span>` : "";
  const pct = it.discount_percentage ? `<span class="mi-note">−${it.discount_percentage}%</span>` : "";
  const req = it.mandatory_addon_minor ? `<span class="mi-note mi-full">min ${money(it.effective_min_minor, it.currency)} with ${money(it.mandatory_addon_minor, it.currency)} required</span>` : "";
  return `<div class="mitem"><span class="mi-name">${esc(it.name || "")}</span>${pct}${was}${priceHtml(it.price_minor, it.currency)}${req}</div>`;
}
function boltMenu(venueId, name) {
  modal(name || "Menu", "Bolt prices, discount applied", async () => {
    const cats = (await getJson("/bolt-menu?venue_id=" + encodeURIComponent(venueId))).categories || [];
    if (!cats.length) return '<p class="muted">Bolt returned no items for this venue.</p>';
    return cats.map((c) => `<div class="mcat">${esc(c.name)}</div>` + c.items.map(menuRow).join("")).join("");
  });
}

// Each tier is picked `quantity` times from its items ("Pick 2 · Any pasta").
function offerTier(t) {
  const items = t.items.map((i) => `<div class="mitem"><span class="mi-name">${esc(i.name)}${i.description ? `<small>${esc(i.description)}</small>` : ""}</span>${priceHtml(i.price_minor, "EUR")}</div>`).join("");
  return `<div class="mcat">${esc(t.title)}<span class="pick">pick ${t.quantity}</span></div>${items}`;
}
function foodyOffer(b) {
  const q = "venue_id=" + encodeURIComponent(b.offerVenue) + "&offer_id=" + encodeURIComponent(b.offer);
  modal(b.offerName || "Offer", b.offerAt, async () => {
    const o = await getJson("/foody-offer?" + q);
    const head = o.price_minor != null ? `<p class="muted">Offer price from ${money(o.price_minor, o.currency)}</p>` : "";
    return o.tiers?.length ? head + o.tiers.map(offerTier).join("") : head + '<p class="muted">Foody lists no dishes to pick for this offer.</p>';
  });
}

// Capture phase, so a click never reaches the card's own controls.
export function setupOverlays() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest?.("[data-menu],[data-offer],[data-preview]");
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    if (t.dataset.menu) boltMenu(t.dataset.menu, t.dataset.menuName);
    else if (t.dataset.offer) foodyOffer(t.dataset);
    else preview(t.dataset.preview);
  }, true);
  document.addEventListener("keydown", (e) => {
    const p = e.target.closest?.("[data-preview]");
    if (!p || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault(); preview(p.dataset.preview);
  });
}
