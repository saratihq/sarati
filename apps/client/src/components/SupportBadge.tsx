import type { NodeTypeSupport } from "@/api/client";

/** Support-tier marker for a catalog app/action — `instant` is the baseline and renders nothing. */
export default function SupportBadge({ support }: { support?: NodeTypeSupport }) {
  if (!support || support.tier === "instant") return null;
  const limited = support.tier === "limited";
  return (
    <span
      className="text-[9px] py-[1px] px-1.5 rounded font-medium shrink-0"
      title={support.reason}
      style={
        limited
          ? { background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }
          : { background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }
      }
    >
      {limited ? "Limited" : "Needs setup"}
    </span>
  );
}
