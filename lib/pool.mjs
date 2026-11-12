// Run `fn` over `items` with at most `concurrency` in flight at once. Workers
// pull from a shared cursor, so a slow venue never blocks the others (unlike a
// fixed-size Promise.all batch that stalls on its slowest member).
export async function mapPool(items, concurrency, fn) {
  const out = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return out;
}
