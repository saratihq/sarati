"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * THE composer opener — its `✨ Composer` cluster (position, icon 14, gap 8, semibold) must stay
 * pixel-aligned with ComposerPanelHeader's, so opening crossfades as one continuous title.
 */
export default function ComposerOpener({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  // Faded, not unmounted, while open (200ms matches the panel's slide) and inert: no pointer/focus/AT.
  return (
    <div
      className="fixed z-30 transition-opacity duration-200 ease-out motion-reduce:transition-none"
      style={{ left: 13, top: 72, opacity: open ? 0 : 1, pointerEvents: open ? "none" : "auto" }}
      aria-hidden={open}
    >
      <Button
        variant="secondary"
        size="sm"
        aria-label="Show composer panel"
        onClick={onOpen}
        data-testid="composer-panel-toggle"
        tabIndex={open ? -1 : undefined}
        style={{ gap: 8, fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.4), 0 6px 16px rgba(0,0,0,0.28)" }}
      >
        {/* The `size-` class is required: it opts out of the Button base's 16px svg override. */}
        <Sparkles className="size-3.5" style={{ color: "var(--orchestr-ai)" }} />
        Composer
      </Button>
    </div>
  );
}
