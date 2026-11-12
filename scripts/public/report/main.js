// The live deals report: renders the grid from the scan's event stream (/events), and
// drives Rescan and Stop server.
import { $, ic, frag, setHtml } from "./util.js";
import { S, dealKey, normalizeDeal, saveFilters, restoreFilters } from "./state.js";
import { buildVenueCats } from "./categories.js";
import { card, groupKey, groupHeader } from "./card.js";
import { visibleList, anyFilter, computeBounds, syncRanges, renderChips, setupFilters } from "./filters.js";
import { tickClock, countdowns, availability } from "./timed.js";
import { setupOverlays } from "./overlays.js";
import { setupAddress, syncAddress, presetLabel, chosenAddr } from "./address.js";

const grid = $("grid"), empty = $("empty");
const provProgress = {};   // id -> {done,total}
const provDone = new Set();

// Coalesce rapid changes (slider drag, streaming cards) into one render per frame.
let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

function freshNode(it) { const n = frag(it.html.trim()).firstElementChild; n.dataset.rkey = it.key; n._html = it.html; return n; }
// Keyed reconcile: make the container's children match `items` ({key, html}), reusing
// nodes whose html is unchanged (so their <img>s never reload) and moving only the
// out-of-place ones. The reference node is read live each step, after any replace.
function reconcile(container, items) {
  const byKey = new Map();
  for (const n of container.children) byKey.set(n.dataset.rkey, n);
  const want = new Set(items.map((it) => it.key));
  for (const [k, n] of byKey) if (!want.has(k)) { n.remove(); byKey.delete(k); }
  let prev = null;
  for (const it of items) {
    let node = byKey.get(it.key);
    if (!node) node = freshNode(it);
    else if (node._html !== it.html) { const f = freshNode(it); node.replaceWith(f); node = f; }
    const ref = prev ? prev.nextSibling : container.firstChild;
    if (node !== ref) container.insertBefore(node, ref);
    prev = node;
  }
}

// Grouped: cross-app venue groups first (when grouping by venue), then by best discount.
function groupedItems(list) {
  const groups = new Map();
  for (const d of list) { const g = groupKey(d); (groups.get(g) || groups.set(g, []).get(g)).push(d); }
  const nProv = (ds) => new Set(ds.map((d) => d.provider)).size;
  const ordered = [...groups.entries()].sort((a, b) => {
    if (S.groupBy === "venuekey") { const ca = nProv(a[1]) > 1, cb = nProv(b[1]) > 1; if (ca !== cb) return cb - ca; }
    return (b[1][0].discount_percentage || 0) - (a[1][0].discount_percentage || 0);
  });
  return ordered.flatMap(([g, ds]) => [{ key: "h:" + S.groupBy + ":" + g, html: groupHeader(g, ds) },
    ...ds.map((d) => ({ key: "c:" + dealKey(d), html: card(d) }))]);
}
function renderEmpty(n) {
  empty.hidden = n > 0;
  if (n) return;
  setHtml(empty, S.deals.size === 0
    ? `<span class="eicon">${ic("tag")}</span><h3>Waiting for the first deals…</h3>`
    : `<span class="eicon">${ic("sliders")}</span><h3>No deals match your filters</h3><button type="button" class="linkbtn" id="empty-clear">Clear filters</button>`);
  $("empty-clear")?.addEventListener("click", () => $("clearfilters").click());
}
function render() {
  saveFilters();
  tickClock();
  computeBounds(); syncRanges();
  buildVenueCats(S.deals.values());
  const list = visibleList();
  renderEmpty(list.length);
  $("count").textContent = list.length + " deal" + (list.length === 1 ? "" : "s") + (anyFilter() ? " (filtered)" : "");
  renderChips();
  // Reconciled, so a streaming scan only touches the cards that changed.
  reconcile(grid, S.groupBy === "none" ? list.map((d) => ({ key: "c:" + dealKey(d), html: card(d) })) : groupedItems(list));
  countdowns();
}

// --- scan progress -------------------------------------------------------------
const rescanBtn = $("rescan"), killBtn = $("kill");
const setStatus = (text, live) => { $("statustext").textContent = text; $("dot").className = "sdot" + (live ? " live" : ""); };
function setBusy(busy) { rescanBtn.classList.toggle("spin", busy); rescanBtn.querySelector("span").textContent = busy ? "Rescanning…" : "Rescan"; }
function updateProgress() {
  let acc = 0;
  for (const p of S.providers) acc += provDone.has(p) ? 1 : (provProgress[p]?.total ? provProgress[p].done / provProgress[p].total : 0);
  const allDone = S.providers.length > 0 && provDone.size >= S.providers.length;
  $("barfill").style.width = allDone ? "0" : (S.providers.length ? Math.round(acc / S.providers.length * 100) : 0) + "%";
  const parts = S.providers.map((p) => provDone.has(p) ? `${p} ✓` : provProgress[p] ? `${p} ${provProgress[p].done}/${provProgress[p].total}` : `${p} …`);
  setStatus((allDone ? "Complete · " : "Scanning · ") + parts.join(" · "), !allDone);
  if (allDone) setBusy(false);
}
function resetUI() {
  S.deals.clear(); provDone.clear();
  for (const k in provProgress) delete provProgress[k];
  $("barfill").style.width = "0"; setStatus("Scanning…", true); setBusy(false);
  render();
}
function markStopped(msg) {
  killBtn.disabled = true; killBtn.querySelector("span").textContent = "Stopped";
  rescanBtn.disabled = true;
  setStatus(msg, false);
}
function addDeal(d, prov) { d.provider = d.provider || prov; S.deals.set(dealKey(normalizeDeal(d)), d); }
function onDone(ev, prov) {
  for (const [k, d] of S.deals) if (d.provider === prov) S.deals.delete(k);   // drop the live cards, swap to the canonical list
  for (const d of ev.deals || []) addDeal(d, prov);
  provDone.add(prov); render(); updateProgress();
}
function onEvent(ev) {
  const prov = ev._provider;
  if (ev.type === "reset") { S.providers = ev.providers || []; if (ev.coords) syncAddress(ev.coords); resetUI(); }
  // The header names the address the user picked, else the provider's own label.
  else if (ev.type === "start") { if (prov === "wolt" || S.providers[0] === prov) $("addr").textContent = presetLabel() || ev.address; updateProgress(); }
  else if (ev.type === "deal") { if (!provDone.has(prov)) { addDeal(ev.deal, prov); scheduleRender(); } }
  else if (ev.type === "progress") { provProgress[prov] = { done: ev.done, total: ev.total }; updateProgress(); }
  else if (ev.type === "done") onDone(ev, prov);
  else if (ev.type === "server" && ev.state === "killed") { es.close(); markStopped("Server stopped"); }
}
const es = new EventSource("/events");   // reconnects on its own
es.onmessage = (e) => onEvent(JSON.parse(e.data));

function rescanAt(lat, lng) {
  setBusy(true);
  fetch("/rescan?lat=" + lat + "&lon=" + lng, { method: "POST" }).catch(() => setBusy(false));
}
rescanBtn.onclick = () => rescanAt(chosenAddr().lat, chosenAddr().lng);
killBtn.onclick = async () => {
  killBtn.disabled = true; killBtn.querySelector("span").textContent = "Stopping…";
  await fetch("/kill", { method: "POST" }).catch(() => null);
  markStopped("Server stopped");
};

restoreFilters();
setupFilters({ render, scheduleRender });
setupOverlays();
setupAddress(rescanAt);
render();
// Time-limited deals open, close and turn urgent while the page sits open: re-render
// only when one of them changed state, and keep the countdowns ticking between.
let availSig = "";
setInterval(() => {
  tickClock();
  const sig = availability(S.deals.values());
  if (sig !== availSig) { availSig = sig; render(); } else countdowns();
}, 30000);
