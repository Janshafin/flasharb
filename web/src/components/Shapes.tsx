export type Kind = "circle" | "square" | "triangle";

/** The three shapes that stand for the three parts of a trade. */
export function Shape({ kind, size = 32, fill = "currentColor" }: { kind: Kind; size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      {kind === "circle" && <circle cx="16" cy="16" r="15" fill={fill} />}
      {kind === "square" && <rect x="1" y="1" width="30" height="30" fill={fill} />}
      {kind === "triangle" && <polygon points="16,1 31,31 1,31" fill={fill} />}
    </svg>
  );
}
