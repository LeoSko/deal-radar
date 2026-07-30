#!/usr/bin/env node
// Capture screenshots of the top N Wolt venue deal pages.
// Reuses deals.mjs (--json) for the deal list, then opens each venue page in a
// headless Chrome via puppeteer with the user's wtoken cookie injected so the
// page renders in the logged-in / address-resolved state. Without the cookie +
// city-routed URL, wolt.com redirects to home.
//
// Needs puppeteer (the one optional dependency) and, for the tiled grid,
// ImageMagick's `montage`.
//
// Usage:
//   node screenshots.mjs                         # top 10 for the account default
//   node screenshots.mjs --address Home --top 10
//   node screenshots.mjs --out /tmp/wolt_shots   # output dir
//
// Output: one PNG per venue at <outdir>/01_<slug>.png plus index.json listing.

import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import { configPath } from "../lib/config.mjs";

const AUTH_PATH = configPath("wolt_auth.json");

function parseArgs() {
  const a = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = a.indexOf(n);
    return i < 0 ? d : a[i + 1];
  };
  return {
    address: flag("--address"),          // saved-alias substring; unset → account default
    top: parseInt(flag("--top", "10"), 10),
    out: flag("--out", "/tmp/wolt_shots"),
    city: flag("--city"),                // only used to rebuild a venue URL deals.mjs didn't emit
    country: flag("--country"),
    tiled: !a.includes("--no-tile"),
    tilePath: flag("--tile-path", null),
    keepTiles: a.includes("--keep-tiles"),
    sendToTg: !a.includes("--no-send"),
    token: flag("--token", null),
    chatId: flag("--chat-id", null),
  };
}

// Telegram delivery is optional. Credentials come from, in order: --token /
// --chat-id, TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in the environment, or
// {"token": …, "chat_id": …} in ~/.config/deal-radar/telegram.json. With none
// of them present the PNGs are just left on disk.
function resolveTg(opts) {
  let token = opts.token || process.env.TELEGRAM_BOT_TOKEN || null;
  let chatId = opts.chatId || process.env.TELEGRAM_CHAT_ID || null;
  if (!token || !chatId) {
    try {
      const cfg = JSON.parse(readFileSync(configPath("telegram.json"), "utf8"));
      token = token || cfg.token;
      chatId = chatId || cfg.chat_id;
    } catch (_) {}
  }
  return token && chatId ? { token, chatId } : null;
}

async function getDeals(opts) {
  return new Promise((resolve, reject) => {
    const args = [
      `${import.meta.dirname || new URL(".", import.meta.url).pathname}/deals.mjs`,
      "--json",
      "--limit", String(opts.top),
    ];
    if (opts.address) args.push("--address", opts.address);
    const child = spawn("node", args);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`deals.mjs failed (${code}): ${err}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error("parse: " + e.message + "\n" + out.slice(0, 200))); }
    });
  });
}

async function fetchUserAddress(address, accessToken) {
  // Resolve the user's saved Wolt address record so the puppeteer session can
  // override the default `activeLocation` (which always points at the account's
  // own default otherwise — screenshots then show prices for the wrong place).
  const r = await fetch("https://restaurant-api.wolt.com/v2/delivery/info", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    },
  });
  if (!r.ok) throw new Error(`addresses fetch ${r.status}`);
  const data = await r.json();
  const list = (data.results || []).map((a) => ({
    id: a.id,
    alias: a.alias,
    raw: a,
    lat: a.location?.user_coordinates?.coordinates?.[1],
    lon: a.location?.user_coordinates?.coordinates?.[0],
  }));
  const needle = (address || "").toLowerCase();
  const hit = list.find((a) => (a.alias || "").toLowerCase().includes(needle));
  return hit || null;
}

async function shootVenueGroup(page, slug, groupDeals, outPath, venueUrl) {
  // One screenshot per venue, with EVERY proposed deal from that venue
  // highlighted (red outline + numbered badge). Avoids sending two near-
  // identical menu shots when the same venue offers multiple discounted
  // items in the user's top-N — and keeps "what you're proposing" visually
  // unambiguous: each deal has a box + arrow + rank tag.
  const url = venueUrl;
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});

  // Dismiss cookie banner if present
  try {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const allow = buttons.find((b) => /allow|accept|agree/i.test(b.textContent || ""));
      if (allow) allow.click();
    });
    await new Promise((r) => setTimeout(r, 800));
  } catch (e) {}

  // Highlight every deal in the group with a red outline + arrow + numbered
  // tag. Scroll the first matched card into view so it's centred in the
  // screenshot. Items not found on the page (Wolt may lazy-load) are
  // silently skipped — we still capture the venue header for context.
  //
  // Wolt's React app renders each menu item as
  //   <div data-test-id="horizontal-item-card">…<h3 data-test-id="horizontal-item-card-header">Item Name</h3>…</div>
  // so we anchor on those test ids — they're a stable contract across the
  // venue layout. We match against the header text because the full card
  // text concatenates name + description + price and is easy to false-match
  // on. Campaign banners at the top of the page (`campaignBanner.container`)
  // are a fallback for items that don't surface as a regular menu card.
  await page.evaluate((deals) => {
    const cards = Array.from(document.querySelectorAll('[data-test-id="horizontal-item-card"]'));
    const banners = Array.from(document.querySelectorAll('[data-test-id="campaignBanner.container"]'));
    const isDiscounted = (card) =>
      card.querySelector('[data-test-id="horizontal-item-card-discounted-price"]') !== null
      || card.querySelector('[data-test-id="horizontal-item-card-original-price"]') !== null
      || card.querySelector('[data-test-id="ItemDiscountBadge"]') !== null;
    function findCard(name) {
      const lower = (name || "").trim().toLowerCase();
      if (!lower) return null;
      // Prefer the card that actually shows the discount UI (struck-out
      // original + reduced price + badge). Wolt duplicates items into
      // "Most ordered" / "Recently bought" lists where the discount isn't
      // rendered, so matching the FIRST header-match leaves them looking
      // un-discounted in the screenshot. Walk discounted cards first.
      const exactDiscounted = cards.find((c) => isDiscounted(c) && c.querySelector('[data-test-id="horizontal-item-card-header"]')?.textContent?.trim()?.toLowerCase() === lower);
      if (exactDiscounted) return exactDiscounted;
      const includesDiscounted = cards.find((c) => isDiscounted(c) && c.querySelector('[data-test-id="horizontal-item-card-header"]')?.textContent?.toLowerCase()?.includes(lower));
      if (includesDiscounted) return includesDiscounted;
      // Fallbacks (no discount UI on card)
      const exactAny = cards.find((c) => c.querySelector('[data-test-id="horizontal-item-card-header"]')?.textContent?.trim()?.toLowerCase() === lower);
      if (exactAny) return exactAny;
      const includesAny = cards.find((c) => c.querySelector('[data-test-id="horizontal-item-card-header"]')?.textContent?.toLowerCase()?.includes(lower));
      if (includesAny) return includesAny;
      const banner = banners.find((b) => (b.textContent || "").toLowerCase().includes(lower));
      return banner || null;
    }
    let firstHit = null;
    for (const d of deals) {
      const card = findCard(d.name);
      if (!card) continue;
      if (!firstHit) firstHit = card;
      card.style.outline = "4px solid #ff3b30";
      card.style.outlineOffset = "2px";
      card.style.position = "relative";
      card.style.zIndex = "5";
      const badge = document.createElement("div");
      const price = (d.price_minor / 100).toFixed(2);
      const orig = d.original_minor ? ` (was €${(d.original_minor / 100).toFixed(2)})` : "";
      const addon = d.mandatory_addon_minor
        ? ` +€${(d.mandatory_addon_discounted_minor / 100).toFixed(2)} req → min €${(d.effective_min_minor / 100).toFixed(2)}`
        : "";
      const wp = d.is_wolt_plus ? " W+" : "";
      badge.textContent = `#${String(d.rank).padStart(2, "0")}  ${d.discount_percentage}% off  €${price}${orig}${addon}${wp}`;
      badge.style.cssText = [
        "position:absolute",
        "top:-14px",
        "left:-4px",
        "background:#ff3b30",
        "color:#fff",
        "padding:4px 10px",
        "border-radius:8px",
        "font-size:13px",
        "font-weight:700",
        "z-index:9999",
        "box-shadow:0 4px 12px rgba(0,0,0,.5)",
        "white-space:nowrap",
        "pointer-events:none",
      ].join(";");
      card.appendChild(badge);
      // Arrow pointing at the card from the left margin
      const arrow = document.createElement("div");
      arrow.textContent = "▶";
      arrow.style.cssText = [
        "position:absolute",
        "top:50%",
        "left:-32px",
        "transform:translateY(-50%)",
        "color:#ff3b30",
        "font-size:28px",
        "font-weight:900",
        "text-shadow:0 0 6px rgba(0,0,0,.6)",
        "z-index:9999",
        "pointer-events:none",
      ].join(";");
      card.appendChild(arrow);
    }
    if (firstHit) firstHit.scrollIntoView({ block: "center", behavior: "instant" });
  }, groupDeals);
  await new Promise((r) => setTimeout(r, 1500));

  await page.screenshot({ path: outPath, fullPage: false });
}

async function sendMessage(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return r.json().catch(() => ({}));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function formatDealsList(index, address) {
  const where = address ? ` near ${escapeHtml(address)}` : "";
  const lines = [`<b>Top ${index.length} Wolt deals${where}</b>`];
  for (const d of index) {
    const price = (d.price_minor / 100).toFixed(2);
    const orig = d.original_minor ? ` (was €${(d.original_minor / 100).toFixed(2)})` : "";
    const addon = d.mandatory_addon_minor
      ? ` <i>+€${(d.mandatory_addon_discounted_minor / 100).toFixed(2)} req → min €${(d.effective_min_minor / 100).toFixed(2)}</i>`
      : "";
    const wp = d.is_wolt_plus ? " <b>W+</b>" : "";
    lines.push(
      `${String(d.rank).padStart(2, "0")}. ${d.discount_percentage}% off €${price}${orig}${addon}${wp}\n` +
      `    ${escapeHtml(d.item_name)} — <a href="${d.url}">${escapeHtml(d.venue_name)}</a>`,
    );
  }
  return lines.join("\n");
}

async function sendDocument(token, chatId, filePath, caption) {
  // POST multipart/form-data via undici's fetch + FormData/Blob. This is the
  // only path that delivers a PNG to Telegram uncompressed — sendPhoto
  // downsamples it.
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([buf]), basename(filePath));
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  return j;
}

async function main() {
  const opts = parseArgs();
  if (!existsSync(AUTH_PATH)) {
    console.error(`wolt_auth.json missing at ${AUTH_PATH}. Import tokens first (bin/capture.mjs wolt).`);
    process.exit(1);
  }
  let puppeteer;
  try {
    ({ default: puppeteer } = await import("puppeteer"));
  } catch (_) {
    console.error("screenshots.mjs needs puppeteer — install it with: npm i puppeteer");
    process.exit(1);
  }
  let auth = JSON.parse(await readFile(AUTH_PATH, "utf8"));
  await mkdir(opts.out, { recursive: true });

  // Pre-resolve the requested saved address so the puppeteer session can
  // override Wolt's default activeLocation (screenshots otherwise show prices
  // for whichever address the account defaults to).
  let activeAddress = null;
  if (opts.address) {
    try {
      activeAddress = await fetchUserAddress(opts.address, auth.access_token);
      if (activeAddress) {
        process.stderr.write(`active address: ${activeAddress.alias} (${activeAddress.lat}, ${activeAddress.lon})\n`);
      } else {
        process.stderr.write(`warn: address "${opts.address}" not found among saved addresses — Wolt falls back to the account default\n`);
      }
    } catch (e) {
      process.stderr.write(`warn: address lookup failed: ${e.message}\n`);
    }
  }

  process.stderr.write(`fetching top ${opts.top} deals${opts.address ? ` near ${opts.address}` : ""}...\n`);
  const deals = await getDeals(opts);
  if (!deals.length) {
    console.error("No deals returned.");
    process.exit(2);
  }
  // The deals.mjs subprocess may have refreshed Wolt's access/refresh
  // tokens — Wolt rotates the refresh_token on every successful refresh
  // and invalidates the prior one server-side. If we kept the in-memory
  // `auth` from before the subprocess ran, puppeteer would later set the
  // (now-dead) cookies and Wolt would fall back to a delivery-confirmation
  // modal. Re-load from disk so the cookies match whatever's current.
  auth = JSON.parse(await readFile(AUTH_PATH, "utf8"));

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1600 });
    // Force dark scheme — Wolt's frontend reads prefers-color-scheme and
    // swaps to its dark palette. Combined with a `theme=dark` cookie hint
    // it works across both the menu page and modals.
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    const wtoken = encodeURIComponent(JSON.stringify({
      accessToken: auth.access_token,
      expirationTime: auth.access_token_expires_at,
    }));
    const wrtoken = encodeURIComponent(JSON.stringify(auth.refresh_token));
    await page.setCookie(
      { name: "__wtoken", value: wtoken, domain: ".wolt.com", path: "/", secure: true },
      { name: "__wrtoken", value: wrtoken, domain: ".wolt.com", path: "/", secure: true },
      { name: "theme", value: "dark", domain: ".wolt.com", path: "/", secure: true },
    );

    // Override Wolt's "active delivery address". The SPA picks the user's
    // default from GET /v2/delivery/info on every load and overwrites
    // localStorage with it — cookie / localStorage hacks alone get clobbered
    // because the SPA refetches the address list after hydration. The
    // reliable fix is to intercept that endpoint and return ONLY the target
    // address, so the SPA's "pick the first/default" logic lands on it.
    if (activeAddress?.raw) {
      await page.setRequestInterception(true);
      const homeOnly = { results: [activeAddress.raw] };
      page.on("request", (req) => {
        const u = req.url();
        if (u.includes("/v2/delivery/info") && !u.includes("last-order") && req.method() === "GET") {
          req.respond({
            status: 200,
            contentType: "application/json",
            headers: {
              "Access-Control-Allow-Origin": "https://wolt.com",
              "Access-Control-Allow-Credentials": "true",
            },
            body: JSON.stringify(homeOnly),
          }).catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
    }

    // Build the full ranked-deal list first, then group by venue. One
    // screenshot per venue with all that venue's proposed deals outlined,
    // rather than N near-identical menu shots.
    const index = deals.map((d, i) => ({
      rank: i + 1,
      file: null,
      venue_slug: d.venue_slug,
      venue_name: d.venue_name,
      item_name: d.name,
      name: d.name,
      discount_percentage: d.discount_percentage,
      price_minor: d.price_minor,
      original_minor: d.original_minor,
      currency: d.currency,
      is_wolt_plus: d.is_wolt_plus,
      mandatory_addon_minor: d.mandatory_addon_minor || 0,
      mandatory_addon_discounted_minor: d.mandatory_addon_discounted_minor || 0,
      mandatory_addon_breakdown: d.mandatory_addon_breakdown || [],
      effective_min_minor: d.effective_min_minor || d.price_minor,
      // deals.mjs emits the canonical, vertical-correct venue_url. --country /
      // --city rebuild the (restaurant-segment) form only if an older
      // deals.mjs omitted it.
      url: d.venue_url
        || (opts.country && opts.city
          ? `https://wolt.com/en/${opts.country}/${opts.city}/restaurant/${d.venue_slug}`
          : null),
    }));
    const venueGroups = new Map();
    for (const it of index) {
      if (!it.url) continue;
      const k = it.venue_slug || "unknown";
      if (!venueGroups.has(k)) venueGroups.set(k, []);
      venueGroups.get(k).push(it);
    }
    let venueRank = 0;
    for (const [slug, group] of venueGroups) {
      venueRank += 1;
      const num = String(venueRank).padStart(2, "0");
      const file = `${opts.out}/${num}_${slug}.png`;
      const dealLabels = group.map((g) => `#${g.rank} ${g.discount_percentage}% ${g.name}`).join(" | ");
      process.stderr.write(`[venue ${venueRank}/${venueGroups.size}] ${slug} — ${dealLabels}\n`);
      try {
        await shootVenueGroup(page, slug, group, file, group[0].url);
        // Attach the produced file path to every deal in this group so the
        // index.json (and any downstream consumer) can map deals -> screenshot.
        for (const it of group) it.file = file;
      } catch (e) {
        process.stderr.write(`  failed: ${e.message}\n`);
      }
    }
    await writeFile(`${opts.out}/index.json`, JSON.stringify(index, null, 2));
    let tilePath = null;
    if (opts.tiled && index.length) {
      tilePath = opts.tilePath || `${opts.out}/grid.png`;
      buildTile(index, tilePath);
      console.error(`tiled: ${tilePath}`);
      if (!opts.keepTiles) {
        for (const e of index) {
          try { await unlink(e.file); } catch (_) {}
        }
      }
    }
    if (opts.sendToTg && index.length) {
      const tg = resolveTg(opts);
      if (tg) {
        const listMsg = formatDealsList(index, opts.address);
        const msgRes = await sendMessage(tg.token, tg.chatId, listMsg).catch((e) => ({ ok: false, description: e.message }));
        if (msgRes?.ok) {
          console.error(`telegram: sent text list (msg_id ${msgRes.result?.message_id})`);
        } else {
          console.error(`telegram: list send failed — ${msgRes?.description || "unknown error"}`);
        }
        if (tilePath) {
          const docRes = await sendDocument(tg.token, tg.chatId, tilePath, `Tile (dark, uncompressed)`).catch((e) => ({ ok: false, description: e.message }));
          if (docRes?.ok) {
            console.error(`telegram: sent grid as document (msg_id ${docRes.result?.message_id})`);
          } else {
            console.error(`telegram: doc send failed — ${docRes?.description || "unknown error"}`);
          }
        }
      } else {
        console.error("telegram: skipped (no token/chat id — see --token/--chat-id, env, or telegram.json)");
      }
    }
    console.log(JSON.stringify(index, null, 2));
  } finally {
    await browser.close();
  }
}

// Composite the per-deal PNGs into one tall grid image via ImageMagick.
// `montage` lays them out in a fixed grid; we annotate each tile with the
// rank, discount %, item name, venue, and the effective minimum price so a
// single screenshot is self-contained.
function buildTile(index, outPath) {
  // Dedupe by file: when multiple deals share a venue screenshot, render
  // ONE tile per venue with a combined label listing every deal that lives
  // on it. Otherwise the grid is mostly identical screenshots repeated.
  const byFile = new Map();
  for (const e of index) {
    if (!e.file) continue;
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const tiles = [...byFile.entries()];
  const cols = tiles.length >= 4 ? 2 : 1;
  const rows = Math.ceil(tiles.length / cols);
  const args = ["-background", "black", "-fill", "white", "-font", "DejaVu-Sans"];
  for (const [file, deals] of tiles) {
    const lines = [`${deals[0].venue_name || ""}`];
    for (const d of deals) {
      const price = d.price_minor != null ? `€${(d.price_minor / 100).toFixed(2)}` : "?";
      const orig = d.original_minor ? ` (was €${(d.original_minor / 100).toFixed(2)})` : "";
      const addon = d.mandatory_addon_minor ? ` +€${(d.mandatory_addon_discounted_minor / 100).toFixed(2)} req` : "";
      const wp = d.is_wolt_plus ? " W+" : "";
      lines.push(`#${String(d.rank).padStart(2, "0")}  ${d.discount_percentage}%${wp}  ${price}${orig}${addon}  ${d.item_name}`);
    }
    args.push("-label", lines.join("\n"), file);
  }
  args.push(
    "-tile", `${cols}x${rows}`,
    "-geometry", "780x980+8+8",
    "-pointsize", "16",
    "-bordercolor", "#444444",
    "-border", "1",
    outPath,
  );
  const r = spawnSync("montage", args, { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`montage failed (exit ${r.status})`);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
