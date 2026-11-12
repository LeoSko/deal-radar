// Command-line plumbing shared by the scanners (deals.mjs, bolt.mjs, foody.mjs).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `flag(name, default)` reads the value after `name`; `has(name)` tests a bare switch.
export function cliArgs(argv = process.argv.slice(2)) {
  const flag = (n, d = null) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
  return { flag, has: (n) => argv.includes(n) };
}

// The flags of a venue-feed scanner (bolt.mjs, foody.mjs).
export function feedScanArgs({ flag, has }) {
  return {
    json: has("--json"),
    stream: has("--stream"),
    minDiscount: parseFloat(flag("--min-discount", "15")),
    limit: parseInt(flag("--limit", "5000"), 10),           // effectively no cap — show every deal
    allItems: has("--all-items"),                           // also emit non-discounted entries (full menus)
    lat: flag("--lat"), lon: flag("--lon"),                 // override auth coords (chosen address)
  };
}

// Run `main` only when the module is executed directly (`node bolt.mjs …`); stay quiet
// when imported (e.g. by the tests) so the pure helpers stay testable.
export function runIfMain(metaUrl, main) {
  if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(metaUrl))) return;
  main().catch((e) => {
    console.error(e.stack || e.message || e);
    process.exit(1);
  });
}
