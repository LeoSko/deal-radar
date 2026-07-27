#!/usr/bin/env node
// Capture Wolt session tokens by pasting cookie values from a logged-in
// browser. Run this whenever the refresh token expires (the scanners say so).
//
// Usage:
//   node import-tokens.mjs '<paste-output>'
//   node import-tokens.mjs -                  # read paste from stdin
//   node import-tokens.mjs --from-cookie '<full document.cookie string>'
//
// How to capture in browser:
//   1. Open https://wolt.com (logged in)
//   2. F12 → Console
//   3. Paste:
//        JSON.stringify({
//          wtoken: document.cookie.match(/__wtoken=([^;]+)/)[1],
//          wrtoken: document.cookie.match(/__wrtoken=([^;]+)/)?.[1]
//        })
//   4. Copy the printed string and pass to this script.

import { loadAuth, saveAuth, AUTH_PATH } from "../lib/auth.mjs";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

async function readSource(arg) {
  if (!arg || arg === "-") {
    return new Promise((resolve, reject) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => resolve(buf));
      process.stdin.on("error", reject);
    });
  }
  if (existsSync(arg)) return readFile(arg, "utf8");
  return arg;
}

function jwtExpMs(token) {
  try {
    const [, b64] = token.split(".");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {}
  return null;
}

function parseInputs(src) {
  // Three accepted forms:
  //   1. {"wtoken": "<url-encoded JSON>", "wrtoken": "<url-encoded refresh>"}
  //   2. full `document.cookie` string (we'll regex out the two cookies)
  //   3. {"access_token": "...", "refresh_token": "..."} pre-extracted
  src = src.trim().replace(/^['"]|['"]$/g, "");
  if (src.startsWith("{")) {
    const obj = JSON.parse(src);
    if (obj.access_token && obj.refresh_token) return obj;
    if (obj.wtoken) {
      const wt = JSON.parse(decodeURIComponent(obj.wtoken));
      let rtok = obj.wrtoken ? decodeURIComponent(obj.wrtoken) : null;
      if (rtok && rtok.startsWith('"') && rtok.endsWith('"')) rtok = JSON.parse(rtok);
      return {
        access_token: wt.accessToken,
        access_token_expires_at: wt.expirationTime || jwtExpMs(wt.accessToken),
        refresh_token: rtok,
      };
    }
  }
  // assume raw document.cookie
  const wm = src.match(/__wtoken=([^;]+)/);
  const rm = src.match(/__wrtoken=([^;]+)/);
  if (!wm) throw new Error("Could not find __wtoken in input");
  const wt = JSON.parse(decodeURIComponent(wm[1]));
  let rtok = rm ? decodeURIComponent(rm[1]) : null;
  if (rtok && rtok.startsWith('"') && rtok.endsWith('"')) rtok = JSON.parse(rtok);
  return {
    access_token: wt.accessToken,
    access_token_expires_at: wt.expirationTime || jwtExpMs(wt.accessToken),
    refresh_token: rtok,
  };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: import-tokens.mjs '<paste>' | <file> | -");
    process.exit(2);
  }
  const src = await readSource(arg);
  const fresh = parseInputs(src);
  if (!fresh.access_token || !fresh.refresh_token) {
    throw new Error("Need both access_token and refresh_token. Did you paste both __wtoken and __wrtoken?");
  }

  let auth;
  try {
    auth = await loadAuth();
  } catch {
    auth = {
      endpoints: {
        order_history: "https://consumer-api.wolt.com/order-tracking-api/v1/order_history/?limit={limit}",
        order_details: "https://consumer-api.wolt.com/order-tracking-api/v1/order_history/purchase/{order_id}?tips_use_percentage=true",
        me: "https://restaurant-api.wolt.com/v1/user/me",
        addresses: "https://restaurant-api.wolt.com/v2/delivery/info",
        promotions: "https://consumer-api.wolt.com/v1/pages/venue-list/promotions-near-you?lon={lon}&lat={lat}",
        venue_static: "https://consumer-api.wolt.com/order-xp/web/v1/pages/venue/slug/{venue_id_or_slug}/static",
        venue_dynamic: "https://consumer-api.wolt.com/order-xp/web/v1/venue/slug/{venue_slug}/dynamic/?lat={lat}&lon={lon}&selected_delivery_method=homedelivery",
        assortment: "https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/{venue_slug}/assortment",
        refresh: "https://authentication.wolt.com/v1/wauth2/access_token",
      },
      work_address: null,
    };
  }
  auth.access_token = fresh.access_token;
  auth.access_token_expires_at = fresh.access_token_expires_at || jwtExpMs(fresh.access_token);
  auth.refresh_token = fresh.refresh_token;
  await saveAuth(auth);

  const expSec = Math.round((auth.access_token_expires_at - Date.now()) / 1000);
  console.log(`Saved tokens to ${AUTH_PATH}`);
  console.log(`access_token expires in ${expSec}s (${new Date(auth.access_token_expires_at).toISOString()})`);
  console.log(`refresh_token length: ${auth.refresh_token.length}`);
  if (!auth.work_address) {
    console.log("\nNo work_address saved yet. Run:");
    console.log("  node bin/set-address.mjs");
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
