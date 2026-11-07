// Read-only market survey: which live Aqua strategies (SwapVM router) exist, which token pairs they trade, and
// whether a hook-free Uniswap v4 pool exists for each pair. It sends no transactions and needs no key.
//
//   RPC_URL=https://mainnet.unichain.org FROM_BLOCK=53720846 npx tsx tools/survey.ts
//
// Public RPCs cap eth_getLogs at about 1000 blocks, so the scan walks the range in chunks, several at a time.
import { createPublicClient, http, parseAbiItem, type Address, type Hex } from "viem";
import { aquaAbi, erc20Abi } from "../src/abi";
import { poolId, readSqrtPrice } from "../src/price";
import { decodeStrategy, hasHooks } from "../src/tracker";
import type { Deployment, PoolKey } from "../src/types";

const RPC = process.env.RPC_URL ?? "https://mainnet.unichain.org";
const AQUA = (process.env.AQUA ?? "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a") as Address;
const ROUTER = (process.env.ROUTER ?? "0x111111338c5091E8440b67B168bAe16a668AC0De") as Address;
const POOL_MANAGER = (process.env.POOL_MANAGER ?? "0x1F98400000000000000000000000000000000004") as Address;
const CHUNK = Number(process.env.CHUNK ?? 1000);
const PARALLEL = Number(process.env.PARALLEL ?? 6);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const client = createPublicClient({ transport: http(RPC, { retryCount: 4, retryDelay: 400 }), cacheTime: 0 });
const pushed = parseAbiItem("event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)");

async function main() {
  const head = await client.getBlockNumber();
  const from = BigInt(process.env.FROM_BLOCK ?? head - 200_000n);
  console.log(`RPC ${RPC}\nscanning blocks ${from} to ${head} (${head - from + 1n} blocks, chunks of ${CHUNK})`);

  const ranges: [bigint, bigint][] = [];
  for (let b = from; b <= head; b += BigInt(CHUNK)) ranges.push([b, b + BigInt(CHUNK) - 1n > head ? head : b + BigInt(CHUNK) - 1n]);

  type Ship = { maker: Address; hash: Hex; strategy: Hex; block: bigint; tx: Hex };
  const ships = new Map<string, Ship>();
  const docked = new Set<string>();
  let done = 0;
  const scan = async (list: [bigint, bigint][], parallel: number): Promise<[bigint, bigint][]> => {
    const failedRanges: [bigint, bigint][] = [];
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const [a, b] = list[i++];
        try {
          const logs = await client.getLogs({ address: AQUA, events: [aquaAbi[0], aquaAbi[1]], fromBlock: a, toBlock: b, strict: true });
          for (const l of logs) {
            const x = l.args as { maker: Address; app: Address; strategyHash: Hex; strategy?: Hex };
            if (x.app.toLowerCase() !== ROUTER.toLowerCase()) continue;
            const k = `${x.maker.toLowerCase()}:${x.strategyHash}`;
            if (l.eventName === "Shipped" && x.strategy) ships.set(k, { maker: x.maker, hash: x.strategyHash, strategy: x.strategy, block: l.blockNumber!, tx: l.transactionHash! });
            if (l.eventName === "Docked") docked.add(k);
          }
        } catch {
          failedRanges.push([a, b]);
        }
        if (++done % 500 === 0) console.log(`  ${done} chunk reads, ${ships.size} strategies so far`);
      }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
    return failedRanges;
  };
  // Public RPCs rate-limit; failed chunks are retried at lower parallelism so coverage is exact, not hoped for.
  let pending = await scan(ranges, PARALLEL);
  for (let pass = 1; pending.length && pass <= 4; pass++) {
    console.log(`  retrying ${pending.length} failed chunks (pass ${pass}, parallel ${Math.max(1, PARALLEL >> pass)})`);
    await new Promise((r) => setTimeout(r, 2000 * pass));
    pending = await scan(pending, Math.max(1, PARALLEL >> pass));
  }
  const covered = ranges.length - pending.length;
  console.log(`coverage: ${covered} of ${ranges.length} chunks read (${((covered / ranges.length) * 100).toFixed(1)}% of blocks ${from} to ${head})`);
  console.log(`Shipped via the SwapVM router: ${ships.size}, docked: ${docked.size}`);
  if (pending.length) console.log(`  ${pending.length} chunks could not be read; the counts above may be low`);

  const live = [...ships.entries()].filter(([k]) => !docked.has(k)).map(([, s]) => s);
  console.log(`live (shipped and not docked): ${live.length}`);
  const pairs = new Map<string, { a: Address; b: Address; count: number; hooked: number }>();
  for (const s of live) {
    const order = decodeStrategy(s.strategy, s.hash, s.block);
    const tokens = new Set<Address>();
    const pushes = await client.getLogs({ address: AQUA, event: pushed, fromBlock: s.block, toBlock: s.block });
    for (const p of pushes) if (p.args.strategyHash === s.hash) tokens.add(p.args.token!);
    const t = [...tokens].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    if (t.length !== 2) continue;
    try {
      await client.readContract({ address: AQUA, abi: aquaAbi, functionName: "safeBalances", args: [s.maker, ROUTER, s.hash, t[0], t[1]] });
    } catch {
      continue; // docked in a way the events missed, or empty
    }
    const k = `${t[0]}:${t[1]}`;
    const e = pairs.get(k) ?? { a: t[0], b: t[1], count: 0, hooked: 0 };
    e.count++;
    if (order && hasHooks(order.order.traits)) e.hooked++;
    pairs.set(k, e);
  }

  const dep = { poolManager: POOL_MANAGER } as Deployment;
  console.log(`\ntoken pairs with a live strategy: ${pairs.size}`);
  let overlaps = 0;
  for (const p of pairs.values()) {
    const sym = async (a: Address) => client.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }).catch(() => a.slice(0, 8));
    const label = `${await sym(p.a)}/${await sym(p.b)}`;
    const found: string[] = [];
    for (const [fee, spacing] of [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const) {
      const key: PoolKey = { currency0: p.a, currency1: p.b, fee, tickSpacing: spacing, hooks: ZERO };
      const sqrt = await readSqrtPrice(client, dep, key).catch(() => 0n);
      if (sqrt > 0n) found.push(`fee ${fee} (pool ${poolId(key).slice(0, 10)})`);
    }
    if (found.length) overlaps++;
    console.log(`  ${label}: ${p.count} live strateg${p.count === 1 ? "y" : "ies"}${p.hooked ? ` (${p.hooked} with hooks)` : ""}; hook-free v4 pools: ${found.length ? found.join(", ") : "none"}`);
  }
  console.log(`\npairs that overlap a hook-free v4 pool: ${overlaps}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
