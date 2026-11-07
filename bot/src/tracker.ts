import { decodeAbiParameters, keccak256, type PublicClient } from "viem";
import { aquaAbi } from "./abi";
import type { Deployment, Hex, Strategy } from "./types";

const orderParam = [
  {
    type: "tuple",
    components: [
      { name: "maker", type: "address" },
      { name: "traits", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

/**
 * SwapVM v1.0.x MakerTraits keeps the four hook flags in bits 249 to 252 (pre/post transfer-in, pre/post transfer-out;
 * see lib/swap-vm/src/libs/MakerTraits.sol). A hook is code the maker chose that runs inside our arb.
 */
export function hasHooks(traits: bigint): boolean {
  return ((traits >> 249n) & 0xfn) !== 0n;
}

/** Decodes the `strategy` bytes Aqua emits in Shipped: abi.encode(SwapVM Order). */
export function decodeStrategy(strategy: Hex, strategyHash: Hex, shippedBlock: bigint): Strategy | null {
  if (keccak256(strategy) !== strategyHash) return null; // Aqua defines strategyHash = keccak256(strategy)
  try {
    const [o] = decodeAbiParameters(orderParam, strategy);
    return { maker: o.maker, strategyHash, order: { maker: o.maker, traits: o.traits, data: o.data }, shippedBlock, hooked: hasHooks(o.traits) };
  } catch {
    return null;
  }
}

/** Follows Aqua's Shipped and Docked events for strategies whose app is the SwapVM router. */
export class StrategyTracker {
  readonly strategies = new Map<string, Strategy>();
  private nextBlock: bigint;

  constructor(
    private client: PublicClient,
    private dep: Deployment,
    private chunk: number,
  ) {
    this.nextBlock = dep.startBlock;
  }

  private key(maker: string, hash: string) {
    return `${maker.toLowerCase()}:${hash}`;
  }

  /** Scans new blocks. Safe to call repeatedly; the last two blocks are re-read to cover shallow reorgs. */
  async sync(): Promise<{ head: bigint; added: number }> {
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    let from = this.nextBlock > 2n ? this.nextBlock - 2n : this.nextBlock;
    let added = 0;
    while (from <= head) {
      const to = from + BigInt(this.chunk) - 1n > head ? head : from + BigInt(this.chunk) - 1n;
      const logs = await this.client.getLogs({
        address: this.dep.aqua,
        events: [aquaAbi[0], aquaAbi[1]],
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      for (const log of logs) {
        const args = log.args as { maker: `0x${string}`; app: `0x${string}`; strategyHash: Hex; strategy?: Hex };
        if (args.app.toLowerCase() !== this.dep.router.toLowerCase()) continue;
        const k = this.key(args.maker, args.strategyHash);
        if (log.eventName === "Shipped" && args.strategy) {
          if (this.strategies.has(k)) continue;
          const s = decodeStrategy(args.strategy, args.strategyHash, log.blockNumber ?? 0n);
          if (s) {
            this.strategies.set(k, s);
            added++;
          }
        } else if (log.eventName === "Docked") {
          this.strategies.delete(k);
        }
      }
      from = to + 1n;
    }
    this.nextBlock = head + 1n;
    return { head, added };
  }
}
