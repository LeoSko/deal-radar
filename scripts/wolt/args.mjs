// deals.mjs command-line flags, and the delivery address they pick.
import { woltFetch } from "../../lib/fetch.mjs";
import { cliArgs } from "../../lib/cli.mjs";

export function parseArgs() {
  const { flag, has } = cliArgs();
  return {
    lat: flag("--lat") ? parseFloat(flag("--lat")) : null,
    lon: flag("--lon") ? parseFloat(flag("--lon")) : null,
    address: flag("--address"),                   // e.g. "Home", "Office" — substring match on saved alias
    listAddresses: has("--list-addresses"),
    venue: flag("--venue"),                        // debug: scan a single venue slug instead of the whole area
    item: flag("--item"),                          // debug: with --venue, filter to items/campaigns matching this name substring or id
    minDiscount: parseFloat(flag("--min-discount", "30")),
    floor: parseFloat(flag("--floor", "15")),
    limit: parseInt(flag("--limit", "5000"), 10),  // effectively no cap — show every deal
    json: has("--json"),
    dump: has("--dump"),
    scan: !has("--no-scan"),
    scanLimit: parseInt(flag("--scan-limit", "150"), 10),
    scanConcurrency: parseInt(flag("--scan-concurrency", "12"), 10),  // venue worker pool size — enough to keep the rate cap saturated through slow (large grocery) responses; the rate gate, not this, bounds req/s
    scanRps: parseFloat(flag("--scan-rps", "6.4")),  // request/sec cap — measured API ceiling (~6.6) minus 2%
    dynRps: parseFloat(flag("--dyn-rps", "0.65")),   // venue-dynamic has its own, far lower per-account cap
    stream: has("--stream"),                         // emit NDJSON events live as venues are scanned (consumed by serve.mjs)
    blindTopK: parseInt(flag("--blind-top", "100"), 10),  // closest-N venues to also scan blindly (catches unbadged markdowns)
    showUnparsed: has("--show-unparsed"),
    allItems: has("--all-items"),                 // also emit non-discounted items (full menus)
  };
}

// The one saved address whose alias contains --address; --list-addresses prints them all and exits.
async function savedAddress(opts) {
  const info = await woltFetch("addresses");
  const list = (info.results || []).map((a) => {
    const c = a.location.user_coordinates.coordinates;
    return { id: a.id, alias: a.alias, city: a.location.city, lat: c[1], lon: c[0] };
  });
  if (opts.listAddresses) {
    for (const a of list) console.log(`  ${(a.alias || "(no alias)").padEnd(30)} ${a.city || ""}  lat=${a.lat.toFixed(4)} lon=${a.lon.toFixed(4)}`);
    process.exit(0);
  }
  const needle = opts.address.toLowerCase();
  const matches = list.filter((a) => (a.alias || "").toLowerCase().includes(needle));
  if (!matches.length) {
    const aliases = list.map((a) => a.alias).filter(Boolean).join(", ");
    throw new Error(`No saved address alias contains "${opts.address}". Known: ${aliases}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple addresses match "${opts.address}": ${matches.map((m) => m.alias).join(", ")}. Be more specific.`,
    );
  }
  return matches[0];
}

export async function resolveAddress(opts, auth) {
  if (opts.lat && opts.lon) {
    return { lat: opts.lat, lon: opts.lon, alias: `${(+opts.lat).toFixed(4)}, ${(+opts.lon).toFixed(4)}` };
  }
  if (opts.address || opts.listAddresses) return savedAddress(opts);
  if (!auth.work_address) {
    throw new Error(
      "No address. Either pass --address <alias> / --lat --lon, or run " +
        "bin/set-address.mjs to persist a default.",
    );
  }
  return auth.work_address;
}
