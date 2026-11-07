import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { parseDeployment } from "../src/deployments";
import { makeLogger } from "../src/log";
import { decodeStrategy, hasHooks } from "../src/tracker";

const maker = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

describe("decodeStrategy", () => {
  const strategy = encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "maker", type: "address" }, { name: "traits", type: "uint256" }, { name: "data", type: "bytes" }] }],
    [{ maker, traits: 123n, data: "0x1100" }],
  );
  it("decodes abi.encode(Order) and checks the hash", () => {
    const s = decodeStrategy(strategy, keccak256(strategy), 7n);
    expect(s).toMatchObject({ maker, order: { maker, traits: 123n, data: "0x1100" }, shippedBlock: 7n });
  });
  it("rejects a strategy whose hash does not match", () => {
    expect(decodeStrategy(strategy, "0x" + "00".repeat(32) as `0x${string}`, 1n)).toBeNull();
  });
  it("rejects garbage", () => {
    expect(decodeStrategy("0x1234", keccak256("0x1234"), 1n)).toBeNull();
  });
});

describe("parseDeployment", () => {
  const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const good = {
    chainId: 31337, startBlock: 3, poolManager: a(1), aqua: a(2), router: a(3), executor: a(4), owner: a(5),
    tokens: { weth: { address: a(10), decimals: 18, symbol: "WETH" }, usdc: { address: a(11), decimals: 6, symbol: "USDC" } },
    pools: [{ symbol: "WETH/USDC", key: { currency0: a(10), currency1: a(11), fee: 3000, tickSpacing: 60, hooks: a(0) } }],
  };
  it("accepts a record written by the scripts", () => {
    const d = parseDeployment(good);
    expect(d.tokens.map((t) => t.symbol)).toEqual(["WETH", "USDC"]);
    expect(d.startBlock).toBe(3n);
    expect(d.pools[0].key.fee).toBe(3000);
  });
  it("rejects bad addresses and unsorted currencies", () => {
    expect(() => parseDeployment({ ...good, executor: "nope" })).toThrow(/executor/);
    const swapped = { ...good, pools: [{ symbol: "x", key: { ...good.pools[0].key, currency0: a(11), currency1: a(10) } }] };
    expect(() => parseDeployment(swapped)).toThrow(/currency0 must be below/);
  });
});

describe("makeLogger", () => {
  it("scrubs secrets wherever they appear", () => {
    const lines: string[] = [];
    const log = makeLogger(["0xsecretkey"], (l) => lines.push(l));
    log.info("using 0xsecretkey now", { k: "0xsecretkey" });
    expect(lines[0]).not.toContain("0xsecretkey");
    expect(lines[0]).toContain("[redacted]");
  });
  it("keeps transaction hashes readable", () => {
    const lines: string[] = [];
    const h = "0x" + "ab".repeat(32);
    makeLogger(["0xsecretkey"], (l) => lines.push(l)).info(`sent ${h}`);
    expect(lines[0]).toContain(h);
  });
});

describe("hasHooks", () => {
  it("detects each of the four hook flags and ignores the others", () => {
    for (const bit of [249n, 250n, 251n, 252n]) expect(hasHooks(1n << bit)).toBe(true);
    expect(hasHooks(0n)).toBe(false);
    expect(hasHooks(1n << 254n)).toBe(false); // use Aqua instead of signature
    expect(hasHooks(1n << 255n)).toBe(false); // unwrap WETH
    expect(hasHooks(1n << 248n)).toBe(false); // "hook has target" alone is not a hook
  });
  it("the demo strategy's traits carry no hook", () => {
    // traits written by script/DemoSetup.s.sol (deployments/31337.json demoStrategy)
    expect(hasHooks(28948022309329048855892746252171976963317496166410141009864396001978282409984n)).toBe(false);
  });
});
