---
name: deal-radar
description: Find truly good food-delivery deals across Wolt, Bolt Food, and Foody, deliverable to the user's saved address. Ranks subscription (W+/Bolt+/Foody+) deals first within each discount band, then descending discounts; filters out non-food and (by default) drinks. Includes a live web report (serve.mjs) with cross-provider join, search, filters, sliders, and a map address picker. Use when the user says "find deals", "food deals", "wolt/bolt/foody deals", "/deal-radar", "what's on sale today", or asks for a lunch deal near the office.
---

# deal-radar

Finds discounted food across **Wolt + Bolt Food + Foody**, deliverable to the user's saved address.

All three providers' credentials live in `~/.config/deal-radar/` (`wolt_auth.json`,
`bolt_auth.json`, `foody_auth.json`). To (re)capture any of them:

```bash
node ~/.claude/skills/deal-radar/bin/capture.mjs <wolt|bolt|foody>   # steps + console snippet
node ~/.claude/skills/deal-radar/bin/import-tokens.mjs <provider> '<paste>'
```

**Tell the user to run the capture snippet in a private / incognito window** —
one session per site means grabbing a token in the normal window can invalidate
the saved one, and later browsing there rotates it.

## When to use

- "/deal-radar" / "find deals" / "what's on sale today" / "deals near the office"
- "any good Wolt+/Bolt+/Foody+ promo for lunch?"

## Primary action — launch the live web report

**This skill's job is to start the web server (`serve.mjs`) and hand the user a URL.**
The browser report is the product — don't dump CLI text unless the user explicitly
asks for it. On `/deal-radar [address]`:

```bash
# Long-lived (scans, then stays up for browsing) → run in the BACKGROUND.
# Pass the user's address as --address; omit it to use the saved work_address.
node ~/.claude/skills/deal-radar/scripts/serve.mjs --address Home > /tmp/deal-radar.log 2>&1 &
```

Then read `/tmp/deal-radar.log` until the boot line appears and give the user the URL:

```
Deal Radar live report → http://localhost:8765
providers: wolt + bolt + foody
```

- It scans **Wolt + Bolt + Foody in parallel**; cards stream in live, then settle to
  the ranked set. Stays up ~60 min (or until the ⏻ Kill button); ↻ re-scans in place.
- If port 8765 is taken, a stale instance is likely already serving — point the user
  there, or relaunch with `--port <n>`. `fuser -k 8765/tcp` frees a wedged one.
- Provider toggles: `--no-wolt` / `--no-bolt` / `--no-foody`. The address picker
  (Home/Office/map pin) is in the UI, so one launch covers re-targeting.

The CLI scanners below are **secondary** — use only for text output, debugging, or
when a server can't bind.

## CLI (text-only, secondary)

```bash
node ~/.claude/skills/deal-radar/scripts/deals.mjs --address Home          # Wolt, ranked text
node ~/.claude/skills/deal-radar/scripts/deals.mjs --list-addresses        # saved addresses
node ~/.claude/skills/deal-radar/scripts/deals.mjs --address Home --no-scan # fast promos-only
```

Sample output:

```
Deals near Office (lat 52.5069, lon 13.3762):

[W+]  50% off  €6.75 (was €13.50) ⭑8.6 40-50  Buy 2, pay for 1 on selected items (Halloumi Portion) — Grill House
        https://wolt.com/en/deu/berlin/restaurant/grill-house/halloumi-portion-itemid-<id>
[W+]  40% off  €8.97 (was €14.95) ⭑8.8 30-40  Carbonara Pasta — Save 40% on selected items with W+ — Pizza Express
        https://wolt.com/en/deu/berlin/restaurant/pizza-express/carbonara-pasta-itemid-<id>
```

Links are deep item links (`{venue}/{item-slug}-itemid-{id}`) whenever the deal
resolved to a concrete item; only unresolved venue-level badges fall back to the
venue URL.

Ranking: by discount band in 10-point steps (60s, 50s, 40s, 30s…) first, so a
bigger discount always ranks higher — Wolt+ or not. Within a 10-pt band, Wolt+
deals come first (and a same-% tie always goes to Wolt+).

Tags:

- `[W+]` — Wolt+ deal (exact discount shown in the `% off` column)
- `[  ]` — non-Wolt+ deal

## Providers (Wolt + Bolt)

The viewer scans **multiple delivery apps in parallel** and merges them:

- **Wolt** — `deals.mjs` (item-level deals; the main scanner documented below).
- **Bolt Food** — `bolt.mjs` (venue-level deals from food.bolt.eu's Home screen
  `labels`, e.g. "−35%"). API topology (base, `getScreenContent` feed, mint path,
  food `screen_id`) is **embedded in `bolt.mjs`** — the only thing
  `~/.config/deal-radar/bolt_auth.json` needs is a `refresh_token` plus a `city_slug`. On each run it generates a
  stable `deviceId`/`session_id`, mints a ~1h access token, and derives
  coords + `city_id` from the account's saved delivery address
  (`getDeliveryLocation`) — so changing your address in the app just works.
  Re-grab only on logout/expiry (~yearly): `bin/capture.mjs bolt` then
  `bin/import-tokens.mjs bolt '<paste>'`. That snippet takes `city_slug` from the
  `/en/<city>/…` URL you run it on; `--city <slug>` overrides.
  Bolt **item-level** deals need the auth-gated venue-menu endpoint (not yet
  captured — grab one `/p/<slug>` menu call from a logged-in browser to add it).
- **Foody** — `foody.mjs` (**item-level** deals from foody.com.cy = efood/Delivery
  Hero). `POST /v3/data/components` view `shop_list.cb_offers` lists offer-venues,
  then each venue's public `/v3/shops/catalog` is scanned for the real
  `category.offers[]` — the actual discounted **item + price** (the venue badge
  like "1+1" is too coarse — often just a coffee BOGO). Auth = `x-core-*` session
  headers in `~/.config/deal-radar/foody_auth.json` (session-bound — re-grab with
  `bin/capture.mjs foody` when calls fail; the import rejects a paste with no
  `x-core-session-id`, which is a guest session and hides every Foody+ deal).
  Coordinates come from `--lat/--lon` (the report always passes them).
  `--scan-limit` caps venues scanned (default 60). Venue URL: `/delivery/<city>/<slug>`.

Both emit the same unified deal shape (`provider`, `rating10` normalized to /10,
`venue_key` for joining) and the same `--stream` NDJSON events. Add a new app
later by writing a sibling `<name>.mjs --stream` and adding it to `PROVIDERS` in
`serve.mjs`.

```bash
node ~/.claude/skills/deal-radar/scripts/bolt.mjs --json      # Bolt deals alone
node ~/.claude/skills/deal-radar/scripts/foody.mjs --json     # Foody deals alone
```

## Live web report (`serve.mjs`)

Spin up a local web viewer that scans **Wolt + Bolt in parallel** and renders the
merged results as cards (discount %, image, price/was, rating, ETA, provider
badge, deep link), filling in **live** as venues are scanned:

```bash
node ~/.claude/skills/deal-radar/scripts/serve.mjs --address Home   # → http://localhost:8765
node ~/.claude/skills/deal-radar/scripts/serve.mjs --address Home --port 9000 --timeout 30
node ~/.claude/skills/deal-radar/scripts/serve.mjs --address Home --no-bolt --no-foody   # Wolt only
```

Provider toggles: `--no-wolt` / `--no-bolt` / `--no-foody`.

- Cards stream in during the scan (SSE); on completion the grid swaps to the
  canonical ranked + chain-collapsed set (matches the CLI output).
- Color-coded price / delivery ETA / venue rating (greener = better).
- Everything else lives in one **⚙️ Filters** menu, with a badge counting active
  selections: **Group by** (None / Category / **Venue · cross-app** / Venue
  (exact) / Discount band), app chips (each app split into regular vs `+`
  subscription deals — selection is a union), Fast/Healthy food compound chips,
  per-category chips with counts, and the 🥤 Drinks / 🍷 Alcohol toggles (both
  off by default). Dual-range sliders for price, delivery time and rating, each
  with keyboard-editable bounds. Selections persist in `localStorage`.
- "Venue · cross-app" joins the same venue across apps by `venue_key`, floats
  venues present on **more than one** app to the top with a 🤝 header comparing
  each app's best discount + rating (better rating highlighted).
- Full-text search over dish, venue, headline and category.
- Click a card photo for a full-screen preview.
- Delivery-address buttons come from `~/.config/deal-radar/places.json` when
  present, else the Wolt account's own address book (`GET /places`); the 📍 map
  picker rescans at an arbitrary pin.
- Static assets (page, stylesheet, vendored noUiSlider) are served from
  `scripts/public/`; brand logos from `scripts/logos/`.
- **↻ Rescan** button (POST `/rescan`) runs a fresh scan without restarting the
  server. **⏻ Kill server** (POST `/kill`) stops it; otherwise it auto-stops
  after `--timeout` minutes (default **60**).
- Any flag other than `--port`/`--timeout` is forwarded to `deals.mjs`
  (`--scan-limit`, `--min-discount`, `--scan-rps`, `--lat/--lon`, …).
- Powered by `deals.mjs --stream` (NDJSON events: `start`/`deal`/`progress`/`done`).

## Screenshots (`screenshots.mjs`, optional)

Shoots the top deals as annotated venue-page PNGs — one per venue, every deal on
it outlined with a rank/discount badge — and tiles them into one grid image.

```bash
node ~/.claude/skills/deal-radar/scripts/screenshots.mjs --address Home --top 10
```

Needs `npm i puppeteer` (the only optional dependency) and ImageMagick's
`montage` for the tile. It re-runs `deals.mjs --json` for the list, then loads
each venue page in headless Chrome with the Wolt cookies injected and the
account's address list intercepted so prices render for `--address`.

Sending the grid + list to Telegram is opt-out (`--no-send`) and needs
credentials, else it's skipped: `--token`/`--chat-id`, `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID`, or `{"token": …, "chat_id": …}` in
`~/.config/deal-radar/telegram.json`.

## Order history export (`wolt-history.mjs` + `/history`)

Wolt's app paginates your past orders and shows one at a time, with no export.
`scripts/wolt-history.mjs` walks the same endpoints with the captured tokens and
writes the whole thing to disk:

```bash
node ~/.claude/skills/deal-radar/scripts/wolt-history.mjs             # → ~/.config/deal-radar/order-history
node ~/.claude/skills/deal-radar/scripts/wolt-history.mjs --out ~/wolt-dump --rps 1 --concurrency 2
node ~/.claude/skills/deal-radar/scripts/wolt-history.mjs --refetch   # ignore the per-order cache
```

- `order-history/wolt_history.json` — `{ meta, orders: [ …summary, details ] }`.
- `order-history/details/<order_id>.json` — raw detail responses. They are the
  resume cache: an interrupted run costs nothing to restart, and a later run
  only fetches orders it has not seen.
- **Group orders** keep no top-level `items`; each participant's basket sits in
  `details.group.my_member` / `details.group.other_members[]`, along with
  `total_share` per person. ~1 in 6 orders is one of these — code that reads
  `details.items` alone silently sees an empty basket.
- Rate limits: these endpoints throttle **far** below the ~6.6 req/s the venue
  endpoints allow, so this uses the adaptive gate in `lib/ratelimit.mjs` (widen
  ×1.5 on the first 429 of a request, ×0.8 back down per 5 clean responses, cap
  3 s) instead of the scanner's fixed rate. A ~1100-order history settles around
  1.5–3 s per request and takes roughly 35 minutes cold; a re-run over a warm
  cache is seconds.
- `--stream` emits NDJSON (`start`/`listing`/`listed`/`progress`/`done`), which
  is what the web report drives its progress bar from.

In the report, **🧾 Order history** (or `/history` directly) opens the browser:
per-order table with search, sorting, expandable baskets (group orders split by
person), spend-by-month chart and headline stats. **⇩ Export** (POST
`/history/export`) runs the exporter and streams progress over SSE
(`/history/events`) into the status bar — phase, done/total, the pace the gate
settled on and how many 429s it absorbed. **↻ Re-fetch all** does the same with
`--refetch`. `GET /history/data` returns the saved export **verbatim** — nothing
is filtered server-side — and the page derives its table from it, keeping each
order's untouched JSON behind a "raw order JSON" toggle in the expanded row.

## Options

| Flag | Default | What |
|---|---|---|
| `--no-scan` | — | Disable default nearby venue menu scan. |
| `--scan-limit <n>` | 150 | Hard cap on total venues scanned (promo-tagged first, then blind-closest fill the rest) |
| `--scan-concurrency <n>` | 12 | Venue worker-pool size. Sized to keep `--scan-rps` saturated even through slow (large grocery) responses; the rate gate — not this — bounds req/s, so this never causes 429s. |
| `--scan-rps <f>` | 6.4 | Global requests/sec cap — the real throttle. Measured Wolt API ceiling is ~6.6 req/s; default is that −2%. Lower if you start seeing "venues failed"; raising it past ~6.6 gets you 429'd. |
| `--address <alias>` | `work_address` from auth.json | Substring match on a saved Wolt address alias (e.g. `Home`, `Office`, `Anna's`). One-off override. |
| `--list-addresses` | — | Dump all saved addresses + coords, then exit. |
| `--lat <f> --lon <f>` | — | Raw coord override (skips saved-address lookup). |
| `--min-discount <n>` | 30 | Drop deals weaker than this % |
| `--limit <n>` | 100 | Cap rows |
| `--json` | — | Machine-readable output |
| `--dump` | — | Raw promotions JSON (when output looks wrong). With `--venue`, dumps that venue's raw assortment items + dynamic campaigns instead. |
| `--venue <slug>` | — | Debug: scan ONE venue by slug (no area re-fetch). Prints every parsed deal for it (no food/min filter), so you can see exactly what the scanner derives. Combine with `--dump` (raw items+campaigns) or `--json` (parsed deal objects). |
| `--item <needle>` | — | With `--venue`, filter to items/campaigns whose name contains `needle` (or whose id equals it). |
| `--blind-top <n>` | 100 | Closest-N venues to scan blindly alongside the promo-tagged set. Catches unbadged assortment markdowns. |
| `--show-unparsed` | — | Print badge texts the parser couldn't turn into a %, grouped by kind+count. Use to decide what new parser rules or banlist entries to add. Log file: `~/.config/deal-radar/unparsed_promos.jsonl`. |

## How it works

1. **Primary**: hit `consumer-api.wolt.com/v1/pages/venue-list/promotions-near-you?lat&lon`.
   Returns 200+ venues each with `venue.promotions[]` badge texts. The script
   parses badges via `parsePromoPct` (handles `X% off`, `Save X% with W+`,
   `Buy N Pay M`, `Add N ... Pay M`, `X € off (spend Y €)`). Venue-level deals
   surface directly. Also deep-walks `venue.venue_preview_items[]` for embedded
   item-level markdowns.
2. **Default scan**: builds a hybrid candidate list — venues advertising ≥ `--min-discount`
   in the promotions response **plus** the closest-`--blind-top` venues by distance —
   then fetches each venue's assortment (`original_price > price` items) and dynamic
   (campaign item-discounts), **two requests per venue fired in parallel**, across a
   `--scan-concurrency` worker pool.

   **Rate limit (unofficial API).** Measured empirically: throughput plateaus at
   **~6.6 req/s** regardless of concurrency — anything faster returns HTTP 429.
   So requests/sec, not the worker count, is the real governor. Every request is
   paced through a global rate gate to `--scan-rps` (default **6.4**, the measured
   ceiling −2%); the rare 429 that slips through is retried with backoff. A full
   ~180-venue scan (≈360 requests) lands ~60–90s. Raising `--scan-concurrency`
   beyond what saturates the rate cap does **not** help — it just thrashes on 429s.

## Self-improving badge parser

Whenever a venue badge text doesn't parse to a discount % **and the scan couldn't
derive one either**, the script appends a classified record to
`~/.config/deal-radar/unparsed_promos.jsonl` (kind: `fixed_price`,
`fixed_amount_off`, `named_offer`, `unknown`). Review with `--show-unparsed`. New
parser rules go in `parsePromoPct` (deals.mjs); new non-food signals go in
`banlist.json`.

Kinds in `IGNORABLE_BADGE_KINDS` (`delivery_fee`, `schedule_label`,
`marketing_label`, `payment_promo`, `free_item`, `no_text`) are never logged and
never mark a venue as worth deep-scanning. `payment_promo` matters most: a
card-issuer campaign like "Enjoy €5 Cashback with Visa" runs Wolt-wide, so
reading it as an offer badge would send *every* venue into the deep scan.

Each `(badge text, venue)` is logged once, so counts in `--show-unparsed` are
venues carrying the badge rather than how many times you've scanned.

## Food filter

Two layers, both driven by `banlist.json`:

1. **Venue vertical** — `food_product_lines` allowlists Wolt's `product_line`
   (`restaurant` only). Every other vertical (grocery/supermarkets,
   health_and_beauty, pharmacy, pet_supply, florist, general_merchandise,
   alcohol) is dropped wholesale, so a beauty store that carries a stray
   food-ish tag can't surface. New food vertical → add it here; the allowlist
   fails closed.
2. **Item name** — `non_food_substrings` (sauces, drinks, coffee, water,
   add-ons, etc.). Items matching get dropped. To stop filtering a legit dish,
   add a more specific entry or relax via `--dump` + manual review.

Venue URLs are the canonical `wolt.com/en/{country}/{city}/{seg}/{slug}` form,
where `seg` is `restaurant` for restaurants and `venue` for grocery (the wrong
segment, and the slug-only `/en/venue/{slug}` form, both 404). City/country come
from the promotions response's `city_data`.

## Troubleshooting

- **"No current deals here"** with `--no-scan` → real-world condition,
  Wolt's promotions page is empty for these coords/right now. Re-run later
  without `--no-scan`.
- **`Refresh failed`** → Wolt refresh token expired. Re-capture:
  `bin/capture.mjs wolt` → `bin/import-tokens.mjs wolt '<paste>'`.
- **Wrong tier (no Wolt+ flag)** → some venues set `show_wolt_plus` at venue
  level, others mark `is_wolt_plus_only` per item. The scanner checks both.
  Use `--json` to inspect.
