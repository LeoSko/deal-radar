#!/usr/bin/env node
// Pick which saved Wolt delivery address deal-radar targets by default.
//
// Usage:
//   node set-address.mjs              # interactive list
//   node set-address.mjs <alias>      # pick by alias substring (e.g. "Office")
//   node set-address.mjs --auto       # pick first alias matching /office|work/i

import { loadAuth, saveAuth } from "../lib/auth.mjs";
import { woltFetch } from "../lib/fetch.mjs";
import { createInterface } from "node:readline";

async function pickInteractive(addrs) {
  console.log("Saved Wolt addresses:");
  addrs.forEach((a, i) => {
    const lon = a.location.user_coordinates.coordinates[0];
    const lat = a.location.user_coordinates.coordinates[1];
    console.log(`  ${String(i).padStart(2)}  ${(a.alias || "(no alias)").padEnd(30)} ${a.location.city || ""}  lat=${lat.toFixed(4)} lon=${lon.toFixed(4)}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const idx = await new Promise((r) => rl.question("Pick number → ", (a) => { rl.close(); r(parseInt(a, 10)); }));
  return addrs[idx];
}

async function main() {
  const arg = process.argv[2];
  const auth = await loadAuth();
  const info = await woltFetch("addresses", {}, { auth });
  const addrs = info.results || [];
  if (!addrs.length) throw new Error("No saved addresses in Wolt account.");

  let picked = null;
  if (arg === "--auto") {
    picked = addrs.find((a) => /office|work/i.test(a.alias || "")) || addrs[0];
  } else if (arg) {
    picked = addrs.find((a) => (a.alias || "").toLowerCase().includes(arg.toLowerCase()));
    if (!picked) throw new Error(`No address whose alias contains "${arg}"`);
  } else {
    picked = await pickInteractive(addrs);
  }
  if (!picked) throw new Error("No address picked.");

  const coords = picked.location.user_coordinates.coordinates;
  auth.work_address = { alias: picked.alias, lat: coords[1], lon: coords[0] };
  await saveAuth(auth);
  console.log(`Saved work_address: ${picked.alias} lat=${coords[1]} lon=${coords[0]}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
