"use client";

import { ArrowLeft } from "lucide-react";

/** THE chrome for the full-page settings surfaces: sticky bar, one back affordance, the page title. */
export function PageHeader({
  title,
  backLabel,
  onBack,
}: {
  title: string;
  /** Where Back goes, in words — "Back", "Settings", … */
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <header
      className="py-3.5 px-8 flex items-center gap-3 sticky top-0 z-50"
      style={{
        borderBottom: "1px solid var(--orchestr-line)",
        background: "var(--orchestr-surface-overlay)",
        backdropFilter: "blur(12px)",
      }}
    >
      <button
        onClick={onBack}
        className="flex items-center gap-2 bg-transparent border-none cursor-pointer text-xs"
        style={{ color: "var(--orchestr-ink-muted)" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--orchestr-ink)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--orchestr-ink-muted)")}
      >
        <ArrowLeft size={14} />
        {backLabel}
      </button>
      <div className="w-px h-4" style={{ background: "var(--orchestr-line)" }} />
      <h1 className="text-sm font-semibold text-[var(--orchestr-ink)] m-0">{title}</h1>
    </header>
  );
}
