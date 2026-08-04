type LogoMarkProps = {
  size?: number;
  fg?: string;
  surface?: string;
  flush?: boolean;
};

type LoaderProps = {
  size?: number;
  color?: string;
  surface?: string;
  ariaLabel?: string;
};

/** Sarati "Duet" mark — the approved brand symbol, verbatim from the design source `m-5b`. */
const MARK_VIEWBOX = "0 0 96 96";

const MARK_DOTS: { cx: number; cy: number; r: number }[] = [
  { cx: 78, cy: 48, r: 2 },
  { cx: 74, cy: 63, r: 2.6 },
  { cx: 63, cy: 74, r: 3.1 },
  { cx: 48, cy: 78, r: 3.6 },
  { cx: 33, cy: 74, r: 4.2 },
  { cx: 22, cy: 63, r: 4.7 },
  { cx: 18, cy: 48, r: 5.3 },
  { cx: 22, cy: 33, r: 5.8 },
  { cx: 33, cy: 22, r: 6.4 },
];

// The stroke trio, rotated 5° clockwise off the verbatim 5b positions so every
// edge gap lands in 3.1–4.3px.
const MARK_STROKES: { x1: number; y1: number; x2: number; y2: number; w: number }[] = [
  { x1: 47.11, y1: 21.61, x2: 54.11, y2: 14.61, w: 9 },
  { x1: 61.71, y1: 26.91, x2: 68.71, y2: 19.91, w: 10.5 },
  { x1: 71.71, y1: 38.82, x2: 78.71, y2: 31.82, w: 12 },
];

// Loader shimmer period (s) — must match `orchestr-mark-shimmer` in globals.css.
const SHIMMER_DUR = 1.6;
const RING_COUNT = MARK_DOTS.length + MARK_STROKES.length;
const shimmerDelay = (ringIndex: number) => `${(-(ringIndex / RING_COUNT) * SHIMMER_DUR).toFixed(2)}s`;

function MarkGlyph({ size, color, loader }: { size: number; color: string; loader?: boolean }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      width={size}
      height={size}
      fill={color}
      className={loader ? "orchestr-mark-breathe" : undefined}
      aria-hidden="true"
    >
      {MARK_DOTS.map((d, i) => (
        <circle
          key={i}
          cx={d.cx}
          cy={d.cy}
          r={d.r}
          className={loader ? "orchestr-mark-shimmer" : undefined}
          style={loader ? { animationDelay: shimmerDelay(i) } : undefined}
        />
      ))}
      <g stroke={color} strokeLinecap="round" fill="none">
        {MARK_STROKES.map((s, i) => (
          <line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            strokeWidth={s.w}
            className={loader ? "orchestr-mark-shimmer" : undefined}
            style={loader ? { animationDelay: shimmerDelay(MARK_DOTS.length + i) } : undefined}
          />
        ))}
      </g>
    </svg>
  );
}

/** Loading indicator — a glow shimmers around the mark's ring over a breathing scale (~1.6s/sweep). */
export function SaratiLoader({ size = 56, color = "currentColor", ariaLabel = "Loading" }: LoaderProps) {
  return (
    <span role="status" aria-label={ariaLabel} style={{ display: "inline-flex", lineHeight: 0 }}>
      <MarkGlyph size={size} color={color} loader />
    </span>
  );
}

/** Standalone monochrome mark — defaults to `currentColor` because the SVG `fill` attribute resolves that but not `var()`. */
export function SaratiMark({ size = 28, fg = "currentColor" }: LogoMarkProps) {
  return <MarkGlyph size={size} color={fg} />;
}

type SquircleProps = {
  size?: number;
  bg?: string;
  fg?: string;
  radius?: number;
};

/** Dark squircle + mark — for favicons, avatars, and other arbitrary surfaces at small sizes. */
export function SaratiSquircle({ size = 36, bg = "#0a0a0a", fg = "#fafafa", radius }: SquircleProps) {
  const r = radius ?? Math.round(size * 0.225);
  const inner = Math.round(size * 0.62);
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: r,
        background: bg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <SaratiMark size={inner} fg={fg} />
    </span>
  );
}

type LockupProps = {
  size?: number;
  iconFg?: string;
  wordFg?: string;
  surface?: string;
  wordSize?: number;
  wordWeight?: number;
  gap?: number;
  className?: string;
};

/** Horizontal lockup: mark + "Sarati" wordmark (placeholder typography pending the final logotype). */
export function SaratiLockup({
  size = 28,
  iconFg = "currentColor",
  wordFg = "currentColor",
  wordSize = 18,
  wordWeight = 500,
  gap = 9,
  className,
}: LockupProps) {
  return (
    // Ink is set here so the lockup follows the theme instead of staying a
    // white wordmark that vanishes on a light header.
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap,
        lineHeight: 1,
        color: "var(--orchestr-ink)",
      }}
    >
      <SaratiMark size={size} fg={iconFg} />
      <span
        style={{
          fontFamily: "'Inter', system-ui, sans-serif",
          fontWeight: wordWeight,
          fontSize: wordSize,
          letterSpacing: "-0.03em",
          color: wordFg,
          lineHeight: 1,
        }}
      >
        Sarati
      </span>
    </span>
  );
}
