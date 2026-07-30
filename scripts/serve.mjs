#!/usr/bin/env node
// Live web report for a deal-radar scan. Spawns `deals.mjs --stream`, relays its
// NDJSON events to the browser over SSE, and renders deal cards (discount %,
// image, price, rating, link) as venues are scanned. Self-terminates shortly
// after the scan completes ("kill on done") — it's an ephemeral viewer, not a
// daemon.
//
//   node serve.mjs --address Home              # scan Home, serve on :8765
//   node serve.mjs --address Home --port 9000
//   node serve.mjs --lat 52.52 --lon 13.40
//
// Any flags other than --port/--open are forwarded to deals.mjs (so --scan-limit,
// --min-discount, --scan-rps, etc. all work).
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { woltFetch } from "../lib/fetch.mjs";
import { loadAuth } from "../lib/auth.mjs";
import { configPath } from "../lib/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const takeFlag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const val = argv[i + 1];
  argv.splice(i, 2);
  return val;
};
const PORT = parseInt(takeFlag("--port") || "8765", 10);
// The viewer stays up after the scan finishes so results remain browsable. It
// shuts down on the Kill button (POST /kill) or after this idle-safety timeout.
const MAX_LIFE_MS = parseInt(takeFlag("--timeout") || "60", 10) * 60 * 1000;
const dropFlag = (n) => { const i = argv.indexOf(n); if (i >= 0) { argv.splice(i, 1); return true; } return false; };
const noWolt = dropFlag("--no-wolt");
const noBolt = dropFlag("--no-bolt");
const noFoody = dropFlag("--no-foody");

// Resolve the launch address to coords ONCE so the very first scan targets it
// across every provider. Without this only Wolt honours --address/work_address;
// Bolt falls back to its own account address (getDeliveryLocation) and Foody to
// its auth coords, so the launch view silently mixes locations. (Rescans already
// pass --lat/--lon to all providers; this gives the initial scan the same.)
const peekFlag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
async function resolveLaunchCoords() {
  const lat = parseFloat(peekFlag("--lat")), lon = parseFloat(peekFlag("--lon"));
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  try {
    const auth = await loadAuth();
    const needle = (peekFlag("--address") || auth.work_address?.alias || "").toLowerCase();
    const info = await woltFetch("addresses", {}, { auth });
    const list = (info.results || []).map((a) => {
      const c = a.location.user_coordinates.coordinates;
      return { alias: a.alias, lat: c[1], lon: c[0] };
    });
    const m = needle ? list.find((a) => (a.alias || "").toLowerCase().includes(needle)) : null;
    if (m) return { lat: m.lat, lon: m.lon };
    if (auth.work_address?.lat != null) return { lat: auth.work_address.lat, lon: auth.work_address.lon };
  } catch (e) {
    console.error(`address resolve failed (${e.message}); providers use their own default coords`);
  }
  return null;
}

// Delivery addresses offered as one-click buttons in the UI. A user-written
// places.json wins; otherwise the Wolt account's own address book is used, so a
// fresh install has working buttons without configuring anything.
async function loadPlaces() {
  try {
    const raw = JSON.parse(readFileSync(configPath("places.json"), "utf8"));
    return raw.map((p, i) => ({ id: p.id || `p${i}`, label: p.label, lat: p.lat, lng: p.lng }));
  } catch {}
  try {
    const info = await woltFetch("addresses", {}, { auth: await loadAuth() });
    return (info.results || []).map((a, i) => {
      const c = a.location.user_coordinates.coordinates;
      return { id: `wolt${i}`, label: a.alias || a.location.street || `Address ${i + 1}`, lat: c[1], lng: c[0] };
    });
  } catch (e) {
    console.error(`address book unavailable (${e.message}); use the map picker`);
    return [];
  }
}

// Each provider is a child process emitting the same NDJSON stream. Remaining
// argv is forwarded to all (each ignores flags it doesn't understand). Add a
// new delivery app here later — it just needs a `<script> --stream` that speaks
// the same events. serve.mjs tags every event with `_provider` before relaying.
const PROVIDERS = [
  !noWolt && { id: "wolt", args: [join(HERE, "deals.mjs"), ...argv, "--stream"] },
  !noBolt && { id: "bolt", args: [join(HERE, "bolt.mjs"), ...argv, "--stream"] },
  !noFoody && { id: "foody", args: [join(HERE, "foody.mjs"), ...argv, "--stream"] },
].filter(Boolean);

// --- event bus -------------------------------------------------------------
let buffer = [];        // every event of the CURRENT scan, replayed to late joiners
const clients = new Set();
let scanDone = false;

function broadcast(evt) {
  buffer.push(evt);
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(line);
}

// --- the streaming scan (restartable via the Rescan button) ----------------
let children = [];
let gen = 0;            // bumped each (re)start; stale children's handlers no-op
let doneProviders = new Set();
let lastCoords = null;  // chosen delivery address (lat/lon) from the UI, reused across rescans
function startScan(coords) {
  if (coords) lastCoords = coords; else coords = lastCoords;
  const myGen = ++gen;
  for (const c of children) { try { c.kill(); } catch {} }
  children = [];
  doneProviders = new Set();
  buffer = [];
  scanDone = false;
  broadcast({ type: "reset", providers: PROVIDERS.map((p) => p.id), coords });  // clients clear the grid + sync the address picker
  for (const prov of PROVIDERS) {
    // Append --lat/--lon so every provider scans the chosen address (overrides
    // the launch --address / provider auth coords).
    const args = coords ? [...prov.args, "--lat", String(coords.lat), "--lon", String(coords.lon)] : prov.args;
    const c = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    children.push(c);
    let stdoutBuf = "";
    c.stdout.on("data", (chunk) => {
      if (myGen !== gen) return;  // superseded by a newer scan
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          evt._provider = prov.id;  // tag source so the client can merge/filter
          if (evt.type === "done") doneProviders.add(prov.id);
          broadcast(evt);
        } catch { /* ignore non-JSON */ }
      }
    });
    c.stderr.on("data", (chunk) => process.stderr.write(`[${prov.id}] ` + chunk));
    c.on("exit", (code) => {
      if (myGen !== gen) return;  // a child we replaced — ignore its exit
      if (!doneProviders.has(prov.id)) {  // died without its own done — synthesize one
        broadcast({ type: "done", deals: lastDeals(prov.id), provider: prov.id, _provider: prov.id, code });
        doneProviders.add(prov.id);
      }
      if (doneProviders.size >= PROVIDERS.length) {
        scanDone = true;
        broadcast({ type: "server", state: "scan-finished" });
      }
    });
  }
}

// --- order history export --------------------------------------------------
// wolt-history.mjs speaks the same NDJSON-over-stdout convention as the
// scanners, so the export gets its own SSE channel and its own progress bar.
// One export at a time; its last state is replayed to whoever opens the page.
const HISTORY_DIR = configPath("order-history");
const historyClients = new Set();
let historyChild = null;
let historyState = { phase: "idle" };

function historyBroadcast(evt) {
  historyState = { ...historyState, ...evt };
  const line = `data: ${JSON.stringify(historyState)}\n\n`;
  for (const res of historyClients) res.write(line);
}

function startHistoryExport({ refetch } = {}) {
  if (historyChild) return false;
  const args = [join(HERE, "wolt-history.mjs"), "--stream", "--out", HISTORY_DIR];
  if (refetch) args.push("--refetch");
  historyState = { phase: "listing", done: 0, total: 0, failed: 0, started_at: Date.now() };
  historyBroadcast({});
  historyChild = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  historyChild.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === "listed") historyBroadcast({ phase: "details", total: evt.total });
        else if (evt.type === "done") historyBroadcast({ phase: "done", ...evt });
        else historyBroadcast(evt);
      } catch { /* ignore non-JSON */ }
    }
  });
  historyChild.stderr.on("data", (chunk) => process.stderr.write("[history] " + chunk));
  historyChild.on("exit", (code) => {
    historyChild = null;
    if (historyState.phase !== "done") historyBroadcast({ phase: "failed", code });
  });
  return true;
}

function shutdown() {
  for (const c of children) { try { c.kill(); } catch {} }
  try { historyChild?.kill(); } catch {}
  for (const r of clients) { try { r.end(); } catch {} }
  for (const r of historyClients) { try { r.end(); } catch {} }
  server.close();
  process.exit(0);
}

function lastDeals(provider) {
  // Best-effort reconstruction from buffered live cards if a provider died
  // without a proper "done" — keeps the page non-empty.
  const map = new Map();
  for (const e of buffer) if (e.type === "deal" && e._provider === provider) map.set(e.deal.item_url || e.deal.name, e.deal);
  return [...map.values()].sort((a, b) => (b.discount_percentage || 0) - (a.discount_percentage || 0));
}

// --- http ------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/kill" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("bye");
    broadcast({ type: "server", state: "killed" });
    console.log("kill requested via UI — shutting down");
    setTimeout(shutdown, 150);  // let the response + SSE event flush
    return;
  }
  if (req.url.startsWith("/rescan") && req.method === "POST") {
    const q = new URL(req.url, "http://x").searchParams;
    const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
    const coords = (Number.isFinite(lat) && Number.isFinite(lon)) ? { lat, lon } : null;
    console.log("rescan requested via UI" + (coords ? ` @ ${lat},${lon}` : ""));
    startScan(coords);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("rescanning");
    return;
  }
  if (req.url.startsWith("/history/export") && req.method === "POST") {
    const refetch = new URL(req.url, "http://x").searchParams.get("refetch") === "1";
    const started = startHistoryExport({ refetch });
    console.log(started ? "order-history export started via UI" : "export already running");
    res.writeHead(started ? 200 : 409, { "Content-Type": "text/plain" });
    res.end(started ? "exporting" : "already running");
    return;
  }
  if (req.url === "/history/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`retry: 2000\n\n`);
    res.write(`data: ${JSON.stringify(historyState)}\n\n`);  // late joiner gets current state
    historyClients.add(res);
    req.on("close", () => historyClients.delete(res));
    return;
  }
  if (req.url === "/history/data") {
    // The saved export, byte for byte — every field Wolt returned for every
    // order. The page derives its table from this; nothing is filtered here.
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(readFileSync(join(HISTORY_DIR, "wolt_history.json")));
    } catch (e) {
      // No export yet (or a half-written file) — the page offers the button.
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === "/history") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    try { res.end(readFileSync(join(PUBLIC_DIR, "history.html"))); }
    catch (e) { res.end(`<h1>public/history.html missing</h1><pre>${e.message}</pre>`); }
    return;
  }
  if (req.url === "/places") {
    loadPlaces().then((places) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(places));
    });
    return;
  }
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`retry: 2000\n\n`);
    for (const evt of buffer) res.write(`data: ${JSON.stringify(evt)}\n\n`);  // replay history
    if (scanDone) res.write(`data: ${JSON.stringify({ type: "server", state: "scan-finished" })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.url.startsWith("/logos/")) {  // provider brand logos + the app's own SVG
    serveStatic(res, join(HERE, "logos"), req.url.slice(7));
    return;
  }
  if (req.url.startsWith("/public/")) {  // stylesheet + vendored slider
    serveStatic(res, PUBLIC_DIR, req.url.slice(8).split("?")[0]);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  // Served from a static file (public/report.html) — re-read each
  // request so the page can be iterated on without restarting the server.
  try { res.end(readFileSync(PAGE_PATH)); }
  catch (e) { res.end(`<h1>public/report.html missing</h1><pre>${e.message}</pre>`); }
});
const PUBLIC_DIR = join(HERE, "public");
const PAGE_PATH = join(PUBLIC_DIR, "report.html");
const MIME = { ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
// Static files under a fixed root. The name is flattened to a single path segment
// so "../" can never walk out of `root`.
function serveStatic(res, root, name) {
  const safe = name.replace(/[^a-z0-9./-]/gi, "").split("/").filter((p) => p && p !== "..").join("/");
  const type = MIME[safe.slice(safe.lastIndexOf("."))] || "application/octet-stream";
  try { res.writeHead(200, { "Content-Type": type, "Cache-Control": "max-age=3600" }); res.end(readFileSync(join(root, safe))); }
  catch { res.writeHead(404); res.end(); }
}
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Deal Radar live report → http://localhost:${PORT}`);
  console.log(`providers: ${PROVIDERS.map((p) => p.id).join(" + ")}`);
  console.log(`(stays up after the scan; close via the Kill button or auto-stops in ${MAX_LIFE_MS / 60000} min)`);
  resolveLaunchCoords().then((coords) => {
    if (coords) console.log(`launch address → ${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)} (all providers)`);
    startScan(coords);
  });
});
setTimeout(shutdown, MAX_LIFE_MS);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
