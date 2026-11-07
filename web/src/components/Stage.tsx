import { useEffect, useState } from "react";

const STEPS = [
  "Sell 10 WETH on Uniswap v4. The pool records what it owes; nothing moves yet.",
  "Pay the Aqua maker 32,000 USDC out of that balance.",
  "Aqua pays 10.048 WETH into the pool.",
  "Keep the 0.048 WETH difference. Every balance is zero, so the transaction can finish.",
];
// dot position per step index 0..4: circle, circle, square, circle, triangle
const POS: [number, number][] = [[200, 270], [200, 270], [760, 270], [200, 270], [480, 120]];
const BAL = [["0.0000", "0.00"], ["−0.0000".replace("0.0000", "10.0000"), "+32,000.00"], ["−10.0000", "0.00"], ["+0.0480", "0.00"], ["0.0000", "0.00"]];
const hot = (step: number) => (step === 1 || step === 3 ? "circle" : step === 2 ? "square" : step === 4 ? "triangle" : "");

export default function Stage() {
  const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [step, setStep] = useState(reduce ? 4 : 0);
  const [paused, setPaused] = useState(false);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (reduce || paused || step >= 4) return;
    const t = setTimeout(() => setStep((s) => s + 1), step === 0 ? 900 : 1700);
    return () => clearTimeout(t);
  }, [step, paused, run, reduce]);

  const [x, y] = POS[step];
  const done = step === 4;
  const [w, u] = BAL[step];
  return (
    <figure className="stage">
      <div className="art">
      <svg viewBox="0 0 960 440" role="img" aria-label="A dot travels between a circle for Uniswap v4, a square for 1inch Aqua and a triangle for the executor, and ends with a yellow bar for the profit.">
        <rect width="960" height="440" fill="var(--blue)" />
        <g stroke="#fff" strokeWidth="3" fill="none">
          <line x1="200" y1="270" x2="480" y2="120" />
          <line x1="480" y1="120" x2="760" y2="270" />
          <line x1="200" y1="270" x2="760" y2="270" strokeDasharray="2 10" strokeLinecap="round" />
        </g>
        <g className={`node ${hot(step) === "circle" ? "hot" : ""}`}><circle cx="200" cy="270" r="74" fill="#fff" /></g>
        <g className={`node ${hot(step) === "square" ? "hot" : ""}`}><rect x="692" y="202" width="136" height="136" fill="var(--red)" /></g>
        <g className={`node ${hot(step) === "triangle" ? "hot" : ""}`}><polygon points="480,52 552,176 408,176" fill="var(--yellow)" /></g>
        <g className="lbl" fill="#fff">
          <text x="200" y="380" textAnchor="middle">Uniswap v4</text>
          <text x="760" y="380" textAnchor="middle">1inch Aqua</text>
          <text x="480" y="214" textAnchor="middle">Executor</text>
        </g>
        <circle className="dot" r="13" fill="#000" stroke="#fff" strokeWidth="4" style={{ transform: `translate(${x}px, ${y}px)` }} />
      </svg>
      <dl className="readout">
        <div><dt>WETH balance owed</dt><dd>{w}</dd></div>
        <div><dt>USDC balance owed</dt><dd>{u}</dd></div>
      </dl>
      <p className="kept" data-on={done}>+0.0480 WETH kept</p>
      </div>
      <figcaption>
        <ol aria-live="polite">
          {STEPS.map((t, i) => (
            <li key={t} data-on={step === i + 1 || (done && i === 3) ? "true" : "false"} data-past={step > i + 1 ? "true" : "false"}><span>{i + 1}</span>{t}</li>
          ))}
        </ol>
        <div className="stage-actions">
          {!done && !reduce && <button className="textbtn" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>{paused ? "Resume" : "Pause"}</button>}
          <button className="textbtn" onClick={() => { setStep(0); setPaused(false); setRun((n) => n + 1); }}>Replay</button>
          <span className="sample">Sample amounts</span>
        </div>
      </figcaption>
    </figure>
  );
}
