#!/usr/bin/env node
// Print the browser-console snippet that captures one provider's credentials,
// with the steps around it. Every provider is scraped from a logged-in web
// session, so the capture happens in your browser, not here.
//
//   node bin/capture.mjs            # list providers
//   node bin/capture.mjs foody      # steps + snippet for Foody

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = new URL(".", import.meta.url);

const STEPS = {
  wolt: {
    site: "https://wolt.com",
    after: [
      "Paste the copied JSON into:",
      "  node bin/import-tokens.mjs wolt '<paste>'",
      "Then pick which saved address is the default target:",
      "  node bin/set-address.mjs --auto",
    ],
  },
  bolt: {
    site: "https://food.bolt.eu",
    after: [
      "Browse to your city first (the URL should look like /en/<city>/...) — the",
      "snippet reads the city slug out of it, and venue links need it.",
      "",
      "Paste the copied JSON into:",
      "  node bin/import-tokens.mjs bolt '<paste>'",
    ],
  },
  foody: {
    site: "https://www.foody.com.cy",
    after: [
      "The snippet arms a capture, then waits for the page to make its own API",
      "call. If no green button appears, click a Sorting option or a category",
      "(\"Delivery time\", \"Shops\") — NOT a restaurant — and it will fire.",
      "Click the green button to copy, then:",
      "  node bin/import-tokens.mjs foody '<paste>'",
      "",
      "The paste must contain x-core-session-id. Without it Foody answers as a",
      "guest and the Foody+ / Pro deals never show up.",
    ],
  },
};

async function main() {
  const provider = (process.argv[2] || "").toLowerCase();
  if (!STEPS[provider]) {
    console.error(`Usage: capture.mjs <${Object.keys(STEPS).join("|")}>`);
    process.exit(2);
  }
  const { site, after } = STEPS[provider];
  const snippet = await readFile(fileURLToPath(new URL(`snippets/${provider}.js`, HERE)), "utf8");

  console.log(`
1. Open a PRIVATE / INCOGNITO window and log in to ${site} there.
   Use incognito for the capture: a normal window shares one session per site,
   so grabbing a second account's token silently invalidates the first, and
   anything you do later in that tab can rotate the token you just saved.
2. F12 → Console. Paste the snippet below and run it.
`);
  console.log(snippet.trim());
  console.log("\n" + after.join("\n") + "\n");
  console.log("3. Close the incognito window when you're done.\n");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
