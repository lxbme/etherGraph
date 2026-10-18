/**
 * The brand (docs/brand/README.md): a solid dot inside a concentric ring of eight dashes, set on a 32-unit grid.
 * Ring radius 13, stroke 2.4 with round caps, each dash 55% of its segment; dot radius 7.
 * The dash offset centres one dash at 12 o'clock (an SVG circle's stroke starts at 3 o'clock).
 */
export const MARK = {
  ring: 13,
  stroke: 2.4,
  dot: 7,
  dashes: 8,
  dashShare: 0.55,
} as const;

const CIRC = 2 * Math.PI * MARK.ring;
const SEG = CIRC / MARK.dashes;
const DASH = SEG * MARK.dashShare;
/** `stroke-dasharray` and `stroke-dashoffset` of the ring. */
export const RING_DASH = { array: `${DASH.toFixed(3)} ${(SEG - DASH).toFixed(3)}`, offset: (DASH / 2 + CIRC / 4).toFixed(3) };

/** The mark alone, drawn in `currentColor`. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle
        cx="16"
        cy="16"
        r={MARK.ring}
        fill="none"
        stroke="currentColor"
        strokeWidth={MARK.stroke}
        strokeLinecap="round"
        strokeDasharray={RING_DASH.array}
        strokeDashoffset={RING_DASH.offset}
      />
      <circle cx="16" cy="16" r={MARK.dot} fill="currentColor" />
    </svg>
  );
}

/** Mark + wordmark: "ether" regular and muted, "Graph" bold. Sized by the parent's font-size. */
export function BrandLockup() {
  return (
    <span className="brand">
      <BrandMark className="brand__mark" />
      <span className="brand__ether">ether</span>
      <span className="brand__graph">Graph</span>
    </span>
  );
}
