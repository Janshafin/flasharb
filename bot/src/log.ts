export type Logger = {
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
};

/** Plain logger that scrubs any secret value it is told about, wherever it shows up in a message. */
export function makeLogger(secrets: string[] = [], out: (line: string) => void = console.log): Logger {
  const scrub = (s: string) => secrets.filter(Boolean).reduce((acc, secret) => acc.split(secret).join("[redacted]"), s);
  const line = (level: string, msg: string, extra?: unknown) => {
    const tail = extra === undefined ? "" : " " + (typeof extra === "string" ? extra : JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    out(scrub(`${new Date().toISOString()} ${level} ${msg}${tail}`));
  };
  return { info: (m, e) => line("info ", m, e), warn: (m, e) => line("warn ", m, e), error: (m, e) => line("error", m, e) };
}
