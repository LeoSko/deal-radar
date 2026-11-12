// Cross-provider venue join key: first two significant words, normalized. Drops
// branch/location noise so "Burger King Makariou" (Wolt) ≈ "Burger King" (Bolt).
export function venueKey(name) {
  return String(name || "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").filter(Boolean).slice(0, 2).join(" ");
}
