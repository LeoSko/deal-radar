// Walk an item's option groups to compute the cheapest mandatory add-on
// total. Wolt items frequently require size / dough / etc. and the assortment
// `item.price` is the BASE without those required selections — so a "€6.45
// pizza" can checkout at €10–17 once a mandatory size is picked. We return
// the cheapest legal add-on sum + a human-readable breakdown so the scanner
// can flag misleading "headline" prices.
//
// Logic:
//   1. A group is mandatory when total_range.min >= 1 AND free_selections < min.
//   2. Root mandatory groups (no prerequisite_values) are always required.
//   3. Dependent groups (with prerequisite_values) only kick in once you pick
//      the parent value referenced by their prerequisites. To stay cheapest,
//      we evaluate every root permutation and pick the configuration with the
//      lowest total cost (which itself includes any chained dependents that
//      activate from that choice).
export function computeMandatoryAddons(item, optionsById) {
  const groups = item.options || [];
  if (!groups.length) return { addon_minor: 0, breakdown: [] };
  const isMandatory = (g) => {
    const r = g.multi_choice_config?.total_range;
    if (!r || !r.min || r.min < 1) return false;
    const free = g.multi_choice_config?.free_selections || 0;
    return free < r.min;
  };
  const rootMandatory = groups.filter((g) => isMandatory(g) && (!g.prerequisite_values || !g.prerequisite_values.length));
  if (!rootMandatory.length) return { addon_minor: 0, breakdown: [] };

  // For each root mandatory group, try every value; recursively compute the
  // chained dependent groups that activate; keep the cheapest combo per group.
  function pickGroup(group, valuePath, visitedGroupIds) {
    if (visitedGroupIds.has(group.id)) return { addon_minor: 0, breakdown: [] };
    const def = optionsById.get(group.option_id);
    const min = group.multi_choice_config.total_range.min || 1;
    const free = group.multi_choice_config.free_selections || 0;
    const billable = Math.max(0, min - free);
    const values = (def?.values || []).slice().sort((a, b) => (a.price || 0) - (b.price || 0));
    let best = null;
    const nextVisited = new Set([...visitedGroupIds, group.id]);
    for (const v of values) {
      const nextPath = [...valuePath, v.id];
      const deps = groups.filter((g) =>
        isMandatory(g) &&
        !nextVisited.has(g.id) &&
        (g.prerequisite_values || []).some((id) => nextPath.includes(id)),
      );
      const depResults = deps.map((d) => pickGroup(d, nextPath, new Set([...nextVisited, ...deps.map((x) => x.id)])));
      const depCost = depResults.reduce((s, r) => s + r.addon_minor, 0);
      const total = billable * (v.price || 0) + depCost;
      if (best === null || total < best.addon_minor) {
        best = {
          addon_minor: total,
          breakdown: [{ group: def?.name || group.option_id, value: v.name, price: v.price || 0, count: billable }]
            .concat(depResults.flatMap((r) => r.breakdown)),
        };
      }
    }
    return best || { addon_minor: 0, breakdown: [] };
  }

  let total = 0;
  const breakdown = [];
  for (const root of rootMandatory) {
    const picked = pickGroup(root, [], new Set());
    total += picked.addon_minor;
    breakdown.push(...picked.breakdown);
  }
  return { addon_minor: total, breakdown };
}
