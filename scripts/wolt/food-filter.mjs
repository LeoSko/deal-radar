// Food or not: the banlist checks that keep sauces and non-food venues (grocery,
// beauty, pharmacy) out of the Wolt deal list.
import { readFile } from "node:fs/promises";

const BANLIST_PATH = new URL("../../banlist.json", import.meta.url);

export async function loadBanlist() {
  const raw = await readFile(BANLIST_PATH, "utf8");
  return JSON.parse(raw);
}

export function isFood(name, banlist) {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  for (const exact of banlist.non_food_strict) if (lower === exact) return false;
  for (const sub of banlist.non_food_substrings) {
    const re = new RegExp(`(^|[^a-z])${sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(lower)) return false;
  }
  return true;
}

// True if the venue is a food/restaurant venue. Primary signal is Wolt's
// `product_line`: the only food vertical we scan is "restaurant"; everything else
// (grocery/supermarkets, health_and_beauty, pharmacy, pet_supply, florist,
// general_merchandise, alcohol) is dropped. We allowlist via banlist.food_product_lines so a new
// non-food vertical fails closed. Tag/name banlists below are defense-in-depth
// (e.g. a "restaurant"-tagged hookah lounge). product_line caught a beauty
// store that a stray "korean" tag had let through.
export function isFoodVenue(venue, banlist) {
  const pl = String(venue?.product_line || "").toLowerCase();
  const allow = banlist.food_product_lines || [];
  if (pl && allow.length && !allow.includes(pl)) return false;
  const tags = (venue?.tags || []).map((t) => String(t).toLowerCase());
  for (const bad of banlist.non_food_venue_tags || []) {
    const needle = bad.toLowerCase();
    if (tags.some((t) => t === needle || t.includes(needle))) return false;
  }
  const name = String(venue?.name || "").toLowerCase();
  for (const bad of banlist.non_food_venue_name_substrings || []) {
    if (name.includes(bad.toLowerCase())) return false;
  }
  return true;
}
