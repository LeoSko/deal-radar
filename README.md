# deal-radar

**Three food-delivery apps, one page of what is actually discounted near you.**

![Node 18+](https://img.shields.io/badge/node-18%2B-3c873a)
![Dependencies: none](https://img.shields.io/badge/dependencies-none-6fe3c4)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Apps: Wolt · Bolt Food · Foody](https://img.shields.io/badge/apps-Wolt%20%C2%B7%20Bolt%20Food%20%C2%B7%20Foody-ff8a3d)

Wolt, Bolt Food and Foody each bury their promos behind a different screen, and
the venue badges oversell: "up to 50% off" usually means one coffee is half
price. deal-radar goes down to the item level — the real dish, the real price —
scans all three apps at once, and ranks what comes back by how big the discount
actually is.

It runs on your machine and talks to the same private endpoints the apps' own
web clients use, with your session tokens. No server, nothing leaves the box.

```bash
git clone https://github.com/LeoSko/deal-radar ~/deal-radar && cd ~/deal-radar
node bin/capture.mjs wolt                  # prints a console snippet to run in your browser
node bin/import-tokens.mjs wolt '<paste>'  # saves it to ~/.config/deal-radar
node scripts/serve.mjs --address Home      # → http://localhost:8765
```

![The live report: Bolt, Foody and Wolt deals side by side in one ranked grid, each card showing the real dish, its discounted price and the price it was before](docs/report.png)

## What it does

- **One grid, three apps.** Wolt, Bolt Food and Foody are scanned in parallel;
  cards stream in as venues come back, then settle into the ranked set.
- **Item level, not badge level.** The dish, its current price and its old
  price — not "up to 50% off" on a venue tile.
- **Ranked by real discount**, in 10-point bands, with subscription deals
  (W+/Bolt+/Foody+) first inside each band.
- **Filters that know what food is.** One chip for healthy or fast food, a
  category breakdown under it, sliders for price, delivery time and rating, and
  drinks/alcohol off by default because a €249 brandy is not lunch.
- **Deliver-to switching** from your saved addresses or a pin on the map,
  without restarting anything.
- **Your own order history**, exported and browsable — see below.

## Setup

Node 18+. No dependencies.

None of these apps has a public API, so there is no API key to issue yourself.
What you do instead is lift the credentials your own browser is already using —
same three-step pattern for each app:

```bash
node bin/capture.mjs <wolt|bolt|foody>          # prints the steps + a console snippet
# …run it in the browser, it copies to your clipboard…
node bin/import-tokens.mjs <provider> '<paste>'
```

`import-tokens.mjs` validates the paste and writes it to
`~/.config/deal-radar/<provider>_auth.json`, `chmod 600`. Nothing lands in the
repo.

> [!IMPORTANT]
> **Do the capture in a private / incognito window.** A browser keeps one
> session per site, so logging in again elsewhere to grab a token can invalidate
> the one you already saved — and ordinary browsing in that same tab rotates
> tokens under you. Incognito gives the capture its own session; close it when
> you're done.

Wolt carries most of the weight, so start there. After importing:

```bash
node bin/set-address.mjs --auto    # pick the default delivery target
```

<details>
<summary><b>Per-app notes</b> — token lifetimes and the quirks of each capture</summary>

**Wolt** — the access token lasts ~30 minutes and renews itself; the refresh
token lasts months. When that finally dies the scanner says so and you
re-capture.

**Bolt** — browse to your city first, so the URL looks like `/en/<city>/…`. The
snippet reads the refresh token out of Bolt's obfuscated localStorage blob *and*
the city slug out of that URL, which is what venue links are built from. If you
were on the home page it'll say so; pass `--city <slug>` yourself in that case.
The token is good for about a year.

**Foody** — there is no token here at all; the credential is one logged-in
session's `x-core-*` headers. The snippet hooks `fetch`/`XHR`, waits for the
page to make its own API call, then pops a green button that copies the whole
thing. If no button shows up, click a Sorting option or a category — not a
restaurant — to make the page fire a request. The import refuses a paste without
`x-core-session-id`, because a guest session silently hides every Foody+ deal.
Expect to redo this one occasionally.

**Addresses** — the deliver-to buttons come from your Wolt address book by
default. To label them yourself, drop a `places.json` next to the auth files;
see `config/places.example.json`.

</details>

## Using the report

```bash
node scripts/serve.mjs --address Home      # → http://localhost:8765
node scripts/serve.mjs --address Home --port 9000 --timeout 30
node scripts/serve.mjs --address Home --no-bolt --no-foody     # Wolt only
```

The server stops itself after an hour, or on the 🛑 button. ↻ rescans in place;
drag the map pin to scan somewhere else.

### Filters

![The filters menu with the Healthy food chip active: it has ticked every healthy category, and the deal count has dropped from 220 to 92](docs/filters.png)

Everything lives in one menu with a badge counting active selections, and your
picks persist in the browser.

### Grouping across apps

![Grouped by venue across apps: one header for Stathis Grill House showing Foody at 51% and Wolt at 50% side by side, with that venue's deals from both apps underneath](docs/cross-app.png)

Ordering from the same place on the app that happens to be cheaper today is most
of the value here, so venues listed on more than one app float to the top.

### Text mode

```bash
node scripts/deals.mjs --address Home --limit 20
node scripts/bolt.mjs --json
node scripts/foody.mjs --json
```

Every flag is documented in `SKILL.md`, along with the scanner internals.

### Picture mode

```bash
npm i puppeteer                                  # the only optional dep
node scripts/screenshots.mjs --address Home --top 10
```

Opens each venue's page logged in, outlines every proposed item with its rank
and discount, and tiles the shots into one grid (ImageMagick's `montage`). It
can post that grid to Telegram given a bot token and chat id — `--token` /
`--chat-id`, `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, or `telegram.json` next
to the auth files.

## Your own order history

The same Wolt session that finds deals can also hand back everything you have
ever ordered — which the app itself will only show you fifty at a time, one
order per screen, with no export.

```bash
node scripts/wolt-history.mjs        # → ~/.config/deal-radar/order-history/
```

You get one `wolt_history.json` holding every order with its full detail: the
basket with per-item prices and options, discounts, fees, tips, the payment
method, the venue, the delivery distance and time. Group orders keep each
participant's items and share, so a dinner for six is still six baskets rather
than one anonymous total. Every response is cached per order, so an interrupted
run resumes for free and the next one only fetches what is new.

Open **🧾 Order history** in the report (or `/history`) to search and sort your
orders, expand one for its basket split by person, and see spend by month. The
**⇩ Export** button runs the exporter from the browser and streams its progress
into the status bar. Nothing is trimmed on the way to the page — it is handed
the export exactly as saved.

These endpoints are throttled far harder than the ones the scanner uses, so the
export paces itself adaptively instead of at a fixed rate: a thousand orders
takes about half an hour the first time, seconds after that.

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

## License

MIT — see [LICENSE](LICENSE).
