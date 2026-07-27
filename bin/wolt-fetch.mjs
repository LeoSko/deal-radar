#!/usr/bin/env node
// Replay any endpoint in wolt_auth.json with substitutions. Useful for debugging.
//
// Usage:
//   node wolt-fetch.mjs <endpoint-name> [key=value ...]
//   node wolt-fetch.mjs --url <full-url>
//
// Examples:
//   node wolt-fetch.mjs addresses
//   node wolt-fetch.mjs promotions lat=52.52 lon=13.40
//   node wolt-fetch.mjs me

import { woltFetch } from "../lib/fetch.mjs";

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: wolt-fetch.mjs <endpoint-name> [k=v ...]  |  --url <full-url>");
    process.exit(2);
  }
  if (args[0] === "--url") {
    const out = await woltFetch(null, {}, { url: args[1] });
    process.stdout.write(typeof out === "string" ? out : JSON.stringify(out, null, 2) + "\n");
    return;
  }
  const [name, ...rest] = args;
  const params = { limit: 10 };
  for (const kv of rest) {
    const i = kv.indexOf("=");
    if (i < 1) throw new Error(`Bad k=v: ${kv}`);
    params[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const out = await woltFetch(name, params);
  process.stdout.write(typeof out === "string" ? out : JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
