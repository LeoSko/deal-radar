// The delivery address: saved places as chips (served by /places: config places.json,
// else the Wolt account's own address book) and a draggable map pin for anywhere else.
import { $ } from "./util.js";

const PRESETS = {};
let chosen = { preset: null, lat: null, lng: null };
let rescan;   // set by setupAddress
export const chosenAddr = () => chosen;

const presetButtons = () => document.querySelectorAll("#presets [data-preset]");
function markPreset(id) {
  presetButtons().forEach((x) => x.classList.toggle("on", x.dataset.preset === id));
  $("abtn-custom").classList.toggle("on", id === "custom" && !$("mapwrap").hidden);
}
const coordText = (lat, lng, n) => lat.toFixed(n) + ", " + lng.toFixed(n);
// The server's launch or rescan address (the reset event) → highlight the matching
// place, so the picker and later rescans track what was actually scanned.
export function syncAddress(c) {
  const la = c.lat, lo = c.lon ?? c.lng;
  if (la == null || lo == null) return;
  const near = (a, b) => Math.abs(a - b) < 0.002;
  let preset = "custom";
  for (const p in PRESETS) if (near(PRESETS[p].lat, la) && near(PRESETS[p].lng, lo)) preset = p;
  chosen = { preset, lat: la, lng: lo };
  markPreset(preset);
  $("addr-coords").textContent = preset === "custom" ? coordText(la, lo, 4) : "";
}
export const presetLabel = () => document.querySelector("#presets .on")?.textContent || "";

function renderPresets(places) {
  const host = $("presets");
  host.replaceChildren();
  for (const p of places) {
    PRESETS[p.id] = { lat: p.lat, lng: p.lng };
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.dataset.preset = p.id; b.textContent = p.label;
    b.onclick = () => {
      chosen = { preset: p.id, ...PRESETS[p.id] };
      $("mapwrap").hidden = true; markPreset(p.id); $("addr-coords").textContent = "";
      rescan(chosen.lat, chosen.lng);
    };
    host.appendChild(b);
  }
  if (chosen.lat != null) syncAddress(chosen);   // re-highlight once the buttons exist
  else if (places.length) chosen = { preset: places[0].id, ...PRESETS[places[0].id] };
}

// Map tiles follow the page theme.
const isDark = () => {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
const tileUrl = () => `https://{s}.basemaps.cartocdn.com/${isDark() ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`;
let map = null, marker = null, tiles = null;
function initMap() {
  const L = window.L;
  if (map) { setTimeout(() => map.invalidateSize(), 30); return; }
  const c = chosen.lat != null ? [chosen.lat, chosen.lng] : [0, 0];
  map = L.map("map", { zoomControl: true }).setView(c, chosen.lat != null ? 15 : 2);
  tiles = L.tileLayer(tileUrl(), { maxZoom: 19, attribution: "© OpenStreetMap, © CARTO" }).addTo(map);
  marker = L.marker(c, { draggable: true }).addTo(map);
  const upd = () => { const p = marker.getLatLng(); $("map-coords").textContent = coordText(p.lat, p.lng, 5); };
  marker.on("move", upd); map.on("click", (e) => marker.setLatLng(e.latlng)); upd();
  setTimeout(() => map.invalidateSize(), 60);
}

export function setupAddress(onRescan) {
  rescan = onRescan;
  fetch("/places").then((r) => r.json()).then(renderPresets).catch(() => renderPresets([]));
  $("abtn-custom").onclick = () => {
    const w = $("mapwrap");
    w.hidden = !w.hidden;
    markPreset(w.hidden ? chosen.preset : "custom");
    if (!w.hidden) initMap();
  };
  $("map-scan").onclick = () => {
    const p = marker.getLatLng();
    chosen = { preset: "custom", lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) };
    $("addr-coords").textContent = coordText(chosen.lat, chosen.lng, 4);
    rescan(chosen.lat, chosen.lng);
  };
  document.addEventListener("themechange", () => tiles?.setUrl(tileUrl()));
}
