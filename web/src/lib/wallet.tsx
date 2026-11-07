import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, type Address, type Chain } from "viem";

export const unichain = defineChain({
  id: 130,
  name: "Unichain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.unichain.org"] } },
  blockExplorers: { default: { name: "Uniscan", url: "https://uniscan.xyz" } },
});
export const unichainSepolia = defineChain({
  id: 1301,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.unichain.org"] } },
  blockExplorers: { default: { name: "Uniscan", url: "https://sepolia.uniscan.xyz" } },
  testnet: true,
});
export const localDemo = defineChain({
  id: 31337,
  name: "Local demo",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});
export const chains: Chain[] = [unichain, unichainSepolia, localDemo];

type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (e: string, f: (...a: any[]) => void) => void;
  removeListener?: (e: string, f: (...a: any[]) => void) => void;
};
declare global {
  interface Window { ethereum?: Eip1193 }
}

type Ctx = {
  hasProvider: boolean;
  account?: Address;
  chainId?: number;
  chain?: Chain;
  /** Native balance of the connected account on its current chain, refreshed every few seconds. */
  balance?: bigint;
  /** The last wallet request that failed or is waiting in the wallet, in words a person can act on. */
  error?: string;
  pending: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchTo: (c: Chain) => Promise<void>;
  clients: () => { pub: ReturnType<typeof createPublicClient>; wallet: ReturnType<typeof createWalletClient> } | null;
};
const WalletCtx = createContext<Ctx>(null as unknown as Ctx);
export const useWallet = () => useContext(WalletCtx);

export function WalletProvider({ children }: { children: ReactNode }) {
  const eth = window.ethereum;
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();

  useEffect(() => {
    if (!eth) return;
    const onAcc = (a: string[]) => setAccount(a[0] as Address | undefined);
    const onChain = (c: string) => setChainId(parseInt(c, 16));
    eth.request({ method: "eth_accounts" }).then((a) => onAcc(a as string[])).catch(() => {});
    eth.request({ method: "eth_chainId" }).then((c) => onChain(c as string)).catch(() => {});
    eth.on?.("accountsChanged", onAcc);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAcc);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [eth]);

  const [balance, setBalance] = useState<bigint>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // Runs one wallet request, turning the standard EIP-1193 failures into a message instead of a silent no-op.
  const guarded = useCallback(async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setError(undefined); setPending(true);
    try { return await f(); } catch (e) {
      const code = (e as { code?: number }).code;
      setError(
        code === 4001 ? "You rejected the request in your wallet." :
        code === -32002 ? "Your wallet already has a request waiting. Open the wallet and finish or reject it." :
        (e as Error).message ?? "The wallet request failed.",
      );
      return undefined;
    } finally { setPending(false); }
  }, []);

  const connect = useCallback(async () => {
    if (!eth) { setError("No browser wallet found. Install MetaMask, then reload this page."); return; }
    const a = await guarded(() => eth.request({ method: "eth_requestAccounts" }) as Promise<string[]>);
    if (a?.[0]) setAccount(a[0] as Address);
  }, [eth, guarded]);

  const switchTo = useCallback(
    async (c: Chain) => {
      if (!eth) return;
      const hex = "0x" + c.id.toString(16);
      await guarded(async () => {
        try {
          await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
        } catch (e) {
          // 4902: the wallet does not know this chain yet, so offer to add it. Anything else (a rejection) stands.
          if ((e as { code?: number }).code !== 4902) throw e;
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hex, chainName: c.name, nativeCurrency: c.nativeCurrency, rpcUrls: c.rpcUrls.default.http,
              ...(c.blockExplorers ? { blockExplorerUrls: [c.blockExplorers.default.url] } : {}),
            }],
          });
        }
      });
    },
    [eth, guarded],
  );

  useEffect(() => {
    setBalance(undefined);
    if (!eth || !account) return;
    let live = true;
    const read = () => eth.request({ method: "eth_getBalance", params: [account, "latest"] })
      .then((b) => { if (live) setBalance(BigInt(b as string)); }).catch(() => {});
    read();
    const t = setInterval(read, 4000);
    return () => { live = false; clearInterval(t); };
  }, [eth, account, chainId]);

  const disconnect = useCallback(() => {
    setAccount(undefined); setError(undefined);
    // Also drop the site's permission where the wallet supports it, so a reload does not reconnect silently.
    eth?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
  }, [eth]);

  const chain = chains.find((c) => c.id === chainId);
  const value = useMemo<Ctx>(
    () => ({
      hasProvider: !!eth, account, chainId, chain, balance, error, pending, connect, switchTo, disconnect,
      clients: () => {
        if (!eth || !account) return null;
        return {
          pub: createPublicClient({ chain, transport: custom(eth) }),
          wallet: createWalletClient({ account, chain, transport: custom(eth) }),
        };
      },
    }),
    [eth, account, chainId, chain, balance, error, pending, connect, switchTo, disconnect],
  );
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
