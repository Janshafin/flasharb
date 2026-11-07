export type SearchResult = { amount: bigint; profit: bigint; evals: number };

/**
 * Golden-section search for the trade size that maximises profit. Profit as a function of size rises to one peak
 * and then falls (test/FlashArbExecutorHardening.t.sol: test_sizeCurve_hasASinglePeak), so a bracketing search works
 * with about 20 quotes instead of a scan. `f` returns null when a size cannot be quoted; that counts as the worst
 * possible value, and ties between two unquotable points shrink towards the small end, where trades are safest.
 */
export async function searchBestSize(
  f: (amount: bigint) => Promise<bigint | null>,
  lo: bigint,
  hi: bigint,
  opts: { maxEvals?: number; tolBps?: number } = {},
): Promise<SearchResult | null> {
  const maxEvals = opts.maxEvals ?? 24;
  const tolBps = BigInt(opts.tolBps ?? 50); // stop when the bracket is 0.5% of the upper end
  if (lo < 1n || hi < lo) return null;

  const cache = new Map<bigint, bigint | null>();
  let evals = 0;
  let best: SearchResult | null = null;
  const ev = async (x: bigint): Promise<bigint | null> => {
    if (cache.has(x)) return cache.get(x)!;
    evals++;
    const y = await f(x);
    cache.set(x, y);
    if (y !== null && (best === null || y > best.profit)) best = { amount: x, profit: y, evals };
    return y;
  };
  const greater = (a: bigint | null, b: bigint | null) => (a === null ? false : b === null ? true : a > b);

  let a = lo;
  let b = hi;
  while (evals < maxEvals && (b - a) * 10_000n > b * tolBps && b - a > 3n) {
    const span = b - a;
    const c = b - (span * 618n) / 1000n;
    const d = a + (span * 618n) / 1000n;
    const fc = await ev(c);
    const fd = await ev(d);
    if (greater(fd, fc)) a = c;
    else b = d;
  }
  // The bracket's ends can be the best point (a monotone region), so check them as well.
  if (evals < maxEvals + 2) {
    await ev(lo);
    await ev(hi);
  }
  const result = best as SearchResult | null;
  return result ? { ...result, evals } : null;
}
