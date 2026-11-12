// What the grid shows: the Filters sheet (chips, sliders), the search box, and the
// filtered + sorted deal list they produce.
import { $, esc, provLogo, provName, setHtml } from "./util.js";
import { S, GROUP_OPTS, RKEYS, rcfg, rng, realMinor } from "./state.js";
import { categoryOf, foodGroupOf, groupCats, isAlcohol, CAT_EMOJI, FOOD_GROUPS } from "./categories.js";
import { isOpenNow, dealScore } from "./timed.js";

let render, scheduleRender;   // set by setupFilters

const sortDeals = (a, b) =>
  (dealScore(b) - dealScore(a)) ||
  ((b.is_plus ? 1 : 0) - (a.is_plus ? 1 : 0)) ||
  ((b.rating10 || 0) - (a.rating10 || 0)) ||
  ((realMinor(a) ?? 1e9) - (realMinor(b) ?? 1e9));

function passesRanges(d) {
  for (const k of RKEYS) {
    const r = rng[k];
    if (!r.touched) continue;
    const v = rcfg[k].val(d);
    // Unknown: drop if this dimension needs a value (price), else keep. A venue-level
    // deal (every Bolt one: a whole-menu discount) has no single price by design.
    if (v == null) { if (rcfg[k].dropNull && !d.venue_level) return false; continue; }
    if (v < r.lo - 1e-9 || v > r.hi + 1e-9) return false;
  }
  return true;
}
const haystack = (d) => ((d.name || "") + " " + (d.venue_name || "") + " " + (d.headline || "") + " " + categoryOf(d)).toLowerCase();
// Provider and "+" chips partition each app into regular vs subscription buckets, and
// the selection is a union: "Wolt" = Wolt non-plus, "W+" = Wolt plus. Empty = all.
const passesApps = (d) => (!S.activeProvs.size && !S.activePlus.size)
  || (!d.is_plus && S.activeProvs.has(d.provider)) || (d.is_plus && S.activePlus.has(d.provider));
export function visibleList() {
  let list = [...S.deals.values()];
  if (!S.showDrinks) list = list.filter((d) => !d.is_drink);
  if (!S.showAlcohol) list = list.filter((d) => !isAlcohol(d));
  if (!S.showClosed) list = list.filter(isOpenNow);
  list = list.filter(passesApps);
  if (S.activeCats.size) list = list.filter((d) => S.activeCats.has(categoryOf(d)));
  if (S.query) list = list.filter((d) => haystack(d).includes(S.query));
  return list.filter(passesRanges).sort(sortDeals);
}
export const anyFilter = () => S.activeCats.size || S.activeProvs.size || S.activePlus.size || S.query
  || S.showDrinks || S.showAlcohol || S.showClosed || RKEYS.some((k) => rng[k].touched);

// Recompute each slider's data bounds; an untouched slider tracks the bounds (inert). A
// touched one is the user's choice: a rescan never moves it, the track only widens.
export function computeBounds() {
  for (const k of RKEYS) {
    const r = rng[k], st = rcfg[k].step;
    let mn = Infinity, mx = -Infinity;
    for (const d of S.deals.values()) { const v = rcfg[k].val(d); if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }
    if (!isFinite(mn)) { mn = 0; mx = k === "rating" ? 10 : k === "eta" ? 60 : 50; }
    mn = Math.floor(mn / st) * st; mx = Math.ceil(mx / st) * st;
    if (mx <= mn) mx = mn + st;
    if (!r.touched) Object.assign(r, { min: mn, max: mx, lo: mn, hi: mx });
    else { r.min = Math.min(mn, r.lo); r.max = Math.max(mx, r.hi); }
  }
}
// A boundary as a plain number for the inputs: one decimal for sub-unit steps.
const fmtNum = (k, v) => (+v).toFixed(rcfg[k].step < 1 ? 1 : 0).replace(/\.0$/, "");
const sliders = {};
const nums = (k) => [$("rng-" + k + "-num-lo"), $("rng-" + k + "-num-hi")];
// The numeric boxes follow the state, except the one being typed in.
function syncNums(k) {
  const [lo, hi] = nums(k);
  if (document.activeElement !== lo) lo.value = fmtNum(k, rng[k].lo);
  if (document.activeElement !== hi) hi.value = fmtNum(k, rng[k].hi);
}
export function syncRanges() {
  for (const k of RKEYS) {
    const r = rng[k], s = sliders[k];
    // noUiSlider rejects min === max: pad a degenerate range by one step.
    s.updateOptions({ range: { min: r.min, max: r.max > r.min ? r.max : r.min + rcfg[k].step }, step: rcfg[k].step }, false);
    s.set([r.lo, r.hi], false);
    for (const n of nums(k)) Object.assign(n, { min: r.min, max: r.max, step: rcfg[k].step });
    syncNums(k);
  }
}
let rngTimer = 0;   // trailing debounce for mid-drag grid re-renders
function setupRange(k) {
  const el = $("rng-" + k + "-slider"), r = rng[k], lbl = el.dataset.lbl || k;
  const s = sliders[k] = window.noUiSlider.create(el, {
    start: [0, 1], connect: true, step: rcfg[k].step, range: { min: 0, max: 1 },
    handleAttributes: [{ "aria-label": "Minimum " + lbl }, { "aria-label": "Maximum " + lbl }],
  });
  // 'slide' covers drag and keyboard: state and boxes follow live, the grid re-renders
  // debounced so the handle never stutters; 'change' (release) paints at once.
  s.on("slide", (vals) => {
    Object.assign(r, { lo: +vals[0], hi: +vals[1], touched: true });
    syncNums(k);
    clearTimeout(rngTimer); rngTimer = setTimeout(render, 150);
  });
  s.on("change", () => { clearTimeout(rngTimer); render(); });
  const [nlo, nhi] = nums(k);
  // Boxes commit on change or Enter, clamped to the track.
  const commit = (e) => {
    const clamp = (v, dflt) => Math.min(Math.max(isFinite(v) ? v : dflt, r.min), r.max);
    let a = clamp(nlo.value === "" ? r.min : +nlo.value, r.min), b = clamp(nhi.value === "" ? r.max : +nhi.value, r.max);
    if (a > b) { if (e.target === nlo) b = a; else a = b; }
    Object.assign(r, { lo: a, hi: b, touched: true });
    syncRanges(); scheduleRender();
  };
  for (const n of [nlo, nhi]) {
    n.addEventListener("change", commit);
    n.addEventListener("keydown", (e) => { if (e.key === "Enter") { commit(e); e.target.blur(); } });
  }
}

const chip = (on, data, label, n, extra = "") =>
  `<button type="button" class="chip${on}" ${data}${extra}>${label}${n ? `<span class="n">${n}</span>` : ""}</button>`;
function appChips() {
  const pc = {}, plusC = {};
  for (const d of S.deals.values()) { const c = d.is_plus ? plusC : pc; c[d.provider] = (c[d.provider] || 0) + 1; }
  const html = S.providers.filter((p) => pc[p] || plusC[p]).map((p) =>
    (pc[p] ? chip(S.activeProvs.has(p) ? " on" : "", `data-prov="${p}"`, provLogo(p) + esc(provName(p)), pc[p]) : "")
    + (plusC[p] ? chip(S.activePlus.has(p) ? " on" : "", `data-plus="${p}"`, provLogo(p) + esc(provName(p)) + "+", plusC[p], ` title="${esc(provName(p))}+ subscription deals"`) : "")).join("");
  return html || '<span class="muted">No providers yet</span>';
}
// Meal chips are compound toggles over their cuisines: on = every present member active,
// partial = some. Hovering one highlights its cuisines.
function mealChips(counts) {
  const gc = {};
  for (const d of S.deals.values()) { const g = foodGroupOf(d); if (g) gc[g] = (gc[g] || 0) + 1; }
  return FOOD_GROUPS.map((g) => {
    const present = g.cats.filter((c) => counts.has(c));
    const on = present.length > 0 && present.every((c) => S.activeCats.has(c));
    const partial = !on && present.some((c) => S.activeCats.has(c));
    return chip(on ? " on" : partial ? " partial" : "", `data-food="${esc(g.id)}"`, esc(g.emoji + " " + g.label), gc[g.id], ` title="Toggle every ${esc(g.label)} cuisine"`);
  }).join("");
}
function showChips() {
  let drinks = 0, alc = 0, closed = 0;
  for (const d of S.deals.values()) { if (d.is_drink) drinks++; if (isAlcohol(d)) alc++; if (!isOpenNow(d)) closed++; }
  return chip(S.showDrinks ? " on" : "", 'data-show="drinks"', "🥤 Drinks", drinks)
    + chip(S.showAlcohol ? " on" : "", 'data-show="alcohol"', "🍷 Alcohol", alc, ' title="Spirits, wine and beer, hidden by default"')
    + (closed ? chip(S.showClosed ? " on" : "", 'data-show="closed"', "Not now", closed, ' title="Lunch-only and ended deals nobody can order right now"') : "");
}
export function renderChips() {
  setHtml($("f-group"), GROUP_OPTS.map(([v, l]) => chip(v === S.groupBy ? " on" : "", `data-group="${v}"`, esc(l))).join(""));
  setHtml($("f-prov"), appChips());
  const counts = new Map();
  for (const d of S.deals.values()) { const c = categoryOf(d); counts.set(c, (counts.get(c) || 0) + 1); }
  setHtml($("f-food"), mealChips(counts));
  const cats = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  setHtml($("f-cat"), cats.length
    ? cats.map((c) => chip(S.activeCats.has(c) ? " on" : "", `data-cat="${esc(c)}"`, esc((CAT_EMOJI[c] || "🍽️") + " " + c), counts.get(c))).join("")
    : '<span class="muted">No cuisines yet</span>');
  setHtml($("f-show"), showChips());
  // The Filters button counts the active selections (grouping and search excluded).
  const n = S.activeProvs.size + S.activePlus.size + S.activeCats.size + (S.showDrinks ? 1 : 0) + (S.showAlcohol ? 1 : 0)
    + (S.showClosed ? 1 : 0) + RKEYS.filter((k) => rng[k].touched).length;
  const sum = $("filterssum");
  sum.querySelector(".count")?.remove();
  if (n) sum.insertAdjacentHTML("beforeend", `<span class="count">${n}</span>`);
}

const toggle = (set, k) => (set.has(k) ? set.delete(k) : set.add(k));
function toggleMeal(gid) {
  const present = new Set([...S.deals.values()].map(categoryOf));
  const members = groupCats(gid).filter((c) => present.has(c));
  const all = members.length > 0 && members.every((c) => S.activeCats.has(c));
  members.forEach((c) => (all ? S.activeCats.delete(c) : S.activeCats.add(c)));
}
const SHOW_KEYS = { drinks: "showDrinks", alcohol: "showAlcohol", closed: "showClosed" };
function onChip(ds) {
  if (ds.group != null) S.groupBy = ds.group;
  else if (ds.prov != null) toggle(S.activeProvs, ds.prov);
  else if (ds.plus != null) toggle(S.activePlus, ds.plus);
  else if (ds.cat != null) toggle(S.activeCats, ds.cat);
  else if (ds.food != null) toggleMeal(ds.food);
  else if (ds.show != null) S[SHOW_KEYS[ds.show]] = !S[SHOW_KEYS[ds.show]];
  render();
}

const searchX = () => $("search-x");
const updSearchX = () => { searchX().hidden = !$("search").value; };
// One-click escape from any filter combination back to the full list.
export function clearFilters() {
  S.activeCats.clear(); S.activeProvs.clear(); S.activePlus.clear();
  S.query = ""; $("search").value = ""; updSearchX();
  S.showDrinks = S.showAlcohol = S.showClosed = false;
  for (const k of RKEYS) rng[k].touched = false;
  render();
}

export function setupFilters(hooks) {
  ({ render, scheduleRender } = hooks);
  for (const k of RKEYS) setupRange(k);
  const dd = $("filtersdd");
  dd.querySelector(".filterspanel").addEventListener("click", (e) => {
    if (e.target.closest("[data-fclose]")) { dd.open = false; return; }
    const c = e.target.closest(".chip");
    if (c) { e.preventDefault(); onChip(c.dataset); }
  });
  dd.querySelector(".fbackdrop").addEventListener("click", () => { dd.open = false; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") dd.open = false; });
  // Hovering a Meal chip previews which cuisine chips its toggle flips.
  dd.addEventListener("mouseover", (e) => {
    const b = e.target.closest("[data-food]");
    if (!b) return;
    const cats = new Set(groupCats(b.dataset.food));
    document.querySelectorAll("#f-cat .chip").forEach((ch) => ch.classList.toggle("hl", cats.has(ch.dataset.cat)));
  });
  dd.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-food]")) document.querySelectorAll("#f-cat .chip.hl").forEach((ch) => ch.classList.remove("hl"));
  });
  $("clearfilters").onclick = clearFilters;
  $("search").addEventListener("input", (e) => { S.query = e.target.value.trim().toLowerCase(); updSearchX(); scheduleRender(); });
  searchX().onclick = () => { $("search").value = ""; S.query = ""; updSearchX(); $("search").focus(); render(); };
  updSearchX();
}
