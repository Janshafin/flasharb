import Stage from "./Stage";
import { Shape } from "./Shapes";

const gas = [
  ["First trade, profit kept as a claim", "219,380"],
  ["First trade, profit sent to your wallet", "203,122"],
  ["Later trade, claim", "185,148"],
  ["Later trade, sent to your wallet", "185,990"],
];
const calls = [
  ["unlock, unlockCallback", "Opens the one window in which every balance change is only recorded.", "Uniswap v4"],
  ["swap", "Sells the input token on the v4 pool. Records deltas, moves no tokens.", "Uniswap v4"],
  ["sync, settle", "Lets Aqua pay straight into the PoolManager and credits what arrived.", "Uniswap v4"],
  ["take", "Pays the Aqua maker out of the delta the v4 swap left behind.", "Uniswap v4"],
  ["mint, burn", "Keeps profit as a claim inside the PoolManager and redeems it later.", "Uniswap v4"],
  ["router swap", "Buys the token back from an Aqua strategy priced by SwapVM.", "1inch SwapVM"],
  ["preTransferInCallback, push", "SwapVM calls back before it checks payment; the executor pays the maker.", "1inch Aqua"],
];
const steps: [string, "circle" | "square" | "triangle", string][] = [
  ["Sell on Uniswap v4", "circle", "An exact-in swap on the pool. The PoolManager books what it owes and what it is owed. No tokens move."],
  ["Pay the maker through Aqua", "square", "SwapVM calls back before checking payment. The executor takes the USDC it owes from the v4 balance and pushes it to the maker."],
  ["Take WETH back from Aqua", "circle", "Aqua pulls WETH from the maker's wallet straight into the pool, and settle credits what arrived."],
  ["Keep the difference", "triangle", "The executor keeps the surplus as a claim or a transfer. Any balance left open reverts the whole transaction."],
];

export default function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <h1>Arbitrage between Uniswap v4 and 1inch Aqua, without a flash loan.</h1>
        <div className="hero-side">
          <p>
            flasharb sells on v4, buys back from an Aqua strategy and keeps the difference, all inside one
            transaction. If a trade does not pay, it reverts and costs only gas.
          </p>
          <div className="actions">
            <a className="btn black" href="#/app/execute">Run a trade</a>
            <a className="btn line" href="#how">See how it works</a>
          </div>
        </div>
        <Stage />
      </section>

      <section className="block yellow">
        <div className="inner split">
          <h2>No loan, so nothing to repay and no fee.</h2>
          <div>
            <p className="big">
              Uniswap v4 checks balances only when the transaction ends. flasharb uses that gap to sell first and
              buy back second. Only the owner wallet can start a trade, and a minimum profit and an expiry block
              protect against stale prices.
            </p>
          </div>
        </div>
      </section>

      <section className="block white" id="how">
        <div className="inner">
          <h2>One transaction, four moves</h2>
          <ol className="moves">
            {steps.map(([t, k, d], i) => (
              <li key={t}>
                <span className="mv-top"><Shape kind={k} size={44} fill={k === "circle" ? "var(--blue)" : k === "square" ? "var(--red)" : "var(--yellow)"} /><b>{i + 1}</b></span>
                <h3>{t}</h3>
                <p>{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="block grey">
        <div className="inner split">
          <h2>What a trade costs in gas</h2>
          <div>
            <table className="flat">
              <thead><tr><th scope="col">Trade</th><th scope="col" className="r">Gas</th></tr></thead>
              <tbody>{gas.map(([a, b]) => <tr key={a}><td>{a}</td><td className="r">{b}</td></tr>)}</tbody>
            </table>
            <p className="note">
              Call-frame gas from the Solidity reference build, 6,344 bytes of runtime code. Storage a test touched
              earlier is already warm, so real transactions cost more. The first claim costs extra because it fills an
              empty storage slot.
            </p>
          </div>
        </div>
      </section>

      <section className="block blue">
        <div className="inner">
          <h2>Where each call happens</h2>
          <div className="tw"><table className="flat on-dark">
            <thead><tr><th scope="col">Call</th><th scope="col">What it does here</th><th scope="col">Part of</th></tr></thead>
            <tbody>{calls.map(([a, b, c]) => <tr key={a}><td className="code">{a}</td><td>{b}</td><td>{c}</td></tr>)}</tbody>
          </table></div>
        </div>
      </section>

      <section className="block black">
        <div className="inner split">
          <h2>Connect the owner wallet and run a trade.</h2>
          <div>
            <p className="big">Simulate against live state first. Send unlocks only for the exact inputs that passed.</p>
            <div className="actions"><a className="btn yellow" href="#/app/execute">Run a trade</a><a className="btn line-w" href="#/app">View the dashboard</a></div>
          </div>
        </div>
      </section>

      <footer className="foot">Built at ETHGlobal Mumbai 2026. flasharb is MIT licensed. Aqua and SwapVM keep their own licenses.</footer>
    </div>
  );
}
