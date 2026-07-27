# deal-radar

Three food-delivery apps, one page of what is actually discounted near you.

![The live report](docs/report.png)

Wolt, Bolt Food and Foody each bury their promos behind a different screen, and
the venue badges oversell: "up to 50% off" usually means one coffee is half
price. deal-radar goes down to the item level — the real dish, the real price —
scans all three apps at once and ranks what comes back by how big the discount
actually is.

It runs on your machine and talks to the same private endpoints the apps' own
web clients use, with your session tokens. No server, nothing leaves the box.

## Setup

Node 18+. No dependencies.

```bash
git clone <this repo> ~/deal-radar && cd ~/deal-radar
```

Credentials live in `~/.config/deal-radar/`, never in the repo. Wolt is the one
that carries most of the weight, so start there:

1. Open [wolt.com](https://wolt.com) logged in, F12 → Console, run:
   ```js
   JSON.stringify({ wtoken:  document.cookie.match(/__wtoken=([^;]+)/)[1],
                    wrtoken: document.cookie.match(/__wrtoken=([^;]+)/)?.[1] })
   ```
2. `node bin/import-tokens.mjs '<paste that>'`
3. `node bin/set-address.mjs --auto` — picks which saved delivery address is the default target.

The access token lasts ~30 minutes and renews itself; the refresh token lasts
months. When it finally dies the scanner says so and you redo step 1.

Bolt and Foody are optional. Copy the matching file out of `config/` into
`~/.config/deal-radar/` (dropping `.example`) and fill it in:

- **Bolt** needs a `refresh_token` and your city slug. The header comment in
  `scripts/bolt.mjs` has a console one-liner that copies a ready-made
  `--set-refresh` command to your clipboard.
- **Foody** needs the `x-core-*` session headers from any logged-in request in
  the network tab. They are session-bound, so expect to re-grab them.

Delivery-address buttons come from your Wolt address book by default. To label
them yourself, drop a `places.json` next to the auth files — see
`config/places.example.json`.

## Use

```bash
node scripts/serve.mjs --address Home      # → http://localhost:8765
```

That is the whole thing: it scans all three providers in parallel, streams cards
in as venues come back, then settles on the ranked set.

One menu holds the filters — apps and their subscription tiers (W+/Bolt+/F+),
food categories, price, delivery time, rating, and the drinks/alcohol toggles
that are off by default because a €249 brandy is not lunch. What you pick sticks
in the browser.

![The filters menu](docs/filters.png)

Grouping by venue across apps floats the venues listed on more than one app to
the top, with each app's best discount and rating side by side:

![Grouped by venue across apps](docs/cross-app.png)

Rescan without restarting (↻), or point it somewhere else by dragging a pin on
the map. The server stops itself after an hour.

There is a text mode too, for when you just want the list:

```bash
node scripts/deals.mjs --address Home --limit 20
node scripts/bolt.mjs --json
node scripts/foody.mjs --json
```

`node scripts/deals.mjs --help`-worthy flags are documented in `SKILL.md`, along
with the scanner internals.

## How it finds things

Wolt's own "promotions near you" endpoint is fast but thin, so the scanner
treats it as a seed list and then fetches the assortment of every promoted venue
plus the closest ~100 others, looking for items whose original price beats their
current one. Badge texts that aren't a clean percentage ("Buy 2 pay 1", "€5 off
over €25") go through a parser; whatever it can't read gets logged to
`~/.config/deal-radar/unparsed_promos.jsonl` so the rules can be extended.

Non-food is filtered twice — first by the venue's vertical (restaurants only),
then by item name — both driven by `banlist.json`.

Wolt's API tops out around 6.6 requests/second no matter how much concurrency
you throw at it, so every request goes through a global rate gate. A full scan
of ~180 venues takes roughly a minute and a half.

## As a Claude Code skill

`SKILL.md` at the repo root makes this loadable as a skill — clone into
`~/.claude/skills-available/` and symlink it into `~/.claude/skills/`. Then
"find me a lunch deal" launches the report.

## Caveats

None of these APIs are public. They change without warning, and this will break
when they do. Rate limits are real — don't raise `--scan-rps`. Foody is
Cyprus-only. Bolt only exposes venue-level discounts (its item-level menu
endpoint needs an auth path that isn't captured here yet). The map picker pulls
Leaflet and tiles from a CDN, so that part needs internet beyond the delivery
APIs.
