import { existsSync } from "node:fs";
import { decodeErrorResult, type PublicClient, type WalletClient } from "viem";
import { erc20Abi, executorAbi, poolManagerAbi } from "./abi";
import type { Config } from "./config";
import type { Logger } from "./log";
import { applySlippage, parseUnitsString } from "./price";
import { quoteArb, revertData, type ArbParams } from "./quote";
import type { TradeStore } from "./store";
import type { Address, Deployment, Opportunity, Trade } from "./types";

export function explainRevert(err: unknown): string {
  const data = revertData(err);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: executorAbi, data });
      return `${d.errorName}${d.args?.length ? `(${d.args.map(String).join(", ")})` : ""}`;
    } catch {
      /* fall through */
    }
  }
  const msg = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err);
  return msg.split("\n")[0].slice(0, 300);
}

export class Trader {
  inFlight = false;
  lastError: string | undefined;

  constructor(
    private client: PublicClient,
    private wallet: WalletClient | undefined,
    private dep: Deployment,
    private cfg: Config,
    private store: TradeStore,
    private backoff: Map<string, number>,
    private log: Logger,
  ) {}

  /** True when the kill switch file exists. */
  stopped(): boolean {
    return existsSync(this.cfg.stopFile);
  }

  private async profitBalance(token: Address): Promise<bigint> {
    if (this.cfg.profitAsClaim) {
      return this.client.readContract({ address: this.dep.poolManager, abi: poolManagerAbi, functionName: "balanceOf", args: [this.dep.executor, BigInt(token)] });
    }
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [this.dep.owner] });
  }

  /** Re-proves one opportunity on the latest block and, if it still pays after gas, sends it. */
  async tryExecute(op: Opportunity, head: bigint): Promise<Trade | null> {
    if (this.cfg.dryRun || !this.wallet?.account) return null;
    if (this.inFlight || this.stopped() || op.status !== "ready") return null;
    this.inFlight = true;
    const id = `${op.id}:${head}`;
    const started = Date.now();
    const fail = (error: string, extra: Partial<Trade> = {}): Trade => {
      this.backoff.set(op.id, Date.now() + this.cfg.backoffMs);
      this.lastError = error;
      this.log.warn(`trade failed for ${op.id}: ${error}`);
      const t: Trade = {
        id, ts: started, block: head.toString(), txHash: null, pool: op.pool, direction: op.direction,
        profitSymbol: op.profitSymbol, profitToken: op.sellToken, decimals: op.decimals, amountIn: op.amountIn,
        quotedProfit: op.quotedProfit, minProfit: "0", realizedProfit: "0", gasUsed: "0", effectiveGasPrice: "0",
        status: "failed", error, ...extra,
      };
      this.store.add(t);
      return t;
    };
    try {
      const gasPrice = await this.client.getGasPrice();
      if (gasPrice > BigInt(Math.floor(this.cfg.maxGasPriceGwei * 1e9))) {
        this.inFlight = false;
        this.log.warn(`gas price above the ${this.cfg.maxGasPriceGwei} gwei cap; skipping ${op.id}`);
        return null;
      }
      const order = { maker: op.order.maker, traits: BigInt(op.order.traits), data: op.order.data };
      const arb: ArbParams = {
        key: op.poolKey, zeroForOne: op.direction === "sell-currency0", amountIn: BigInt(op.amountIn),
        minProfit: 0n, lastBlock: Number(head) + this.cfg.expiryBlocks, profitAsClaim: this.cfg.profitAsClaim, order,
      };
      const q = await quoteArb(this.client, this.dep, arb);
      if (!q.viable || q.profit <= 0n) {
        this.inFlight = false;
        this.log.info(`opportunity ${op.id} no longer pays; skipping`);
        return null;
      }
      const net = q.profit - BigInt(op.gasCost);
      if (net <= 0n) {
        this.inFlight = false;
        return null;
      }
      arb.minProfit = applySlippage(q.profit, this.cfg.slippageBps) || 1n;

      const before = await this.profitBalance(op.sellToken);
      const { request } = await this.client.simulateContract({
        account: this.wallet.account, address: this.dep.executor, abi: executorAbi, functionName: "arb", args: [arb],
      });
      const hash = await this.wallet.writeContract(request as never);
      this.log.info(`sent ${hash} for ${op.id}`);
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") {
        return fail("transaction reverted on-chain", { txHash: hash, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), minProfit: arb.minProfit.toString() });
      }
      const after = await this.profitBalance(op.sellToken);
      const trade: Trade = {
        id, ts: started, block: receipt.blockNumber.toString(), txHash: hash, pool: op.pool, direction: op.direction,
        profitSymbol: op.profitSymbol, profitToken: op.sellToken, decimals: op.decimals, amountIn: op.amountIn,
        quotedProfit: q.profit.toString(), minProfit: arb.minProfit.toString(), realizedProfit: (after - before).toString(),
        gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), status: "success",
      };
      this.store.add(trade);
      this.lastError = undefined;
      this.log.info(`confirmed ${hash}: profit ${trade.realizedProfit} ${op.profitSymbol} (raw), gas ${trade.gasUsed}`);
      return trade;
    } catch (e) {
      return fail(explainRevert(e));
    } finally {
      this.inFlight = false;
    }
  }
}

export { parseUnitsString };
