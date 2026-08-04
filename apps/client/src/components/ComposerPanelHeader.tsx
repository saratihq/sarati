"use client";

import { Sparkles, X } from "lucide-react";

/** The ONE composer panel header; its `✨ Composer` cluster must stay pixel-aligned with ComposerOpener. */
export default function ComposerPanelHeader({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="flex items-center gap-2 px-4 h-12 shrink-0"
      style={{ borderBottom: "1px solid var(--orchestr-line)" }}
    >
      <Sparkles size={14} className="shrink-0" style={{ color: "var(--orchestr-ai)" }} />
      <span className="text-[12px] font-semibold" style={{ color: "var(--orchestr-ink)" }}>
        Composer
      </span>
      <span
        className="text-[9px] font-bold leading-none tracking-[0.06em] px-1.5 py-1 rounded"
        style={{ background: "var(--orchestr-ai-tint)", color: "var(--orchestr-ai)" }}
      >
        AI
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close composer panel"
        className="ml-auto bg-transparent border-none cursor-pointer p-1 shrink-0"
        style={{ color: "var(--orchestr-ink-subtle)" }}
        data-testid="composer-panel-close"
      >
        <X size={14} />
      </button>
    </div>
  );
}
