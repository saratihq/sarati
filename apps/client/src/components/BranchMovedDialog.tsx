"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SaratiLoader } from "./SaratiLogo";
import { useWorkflow } from "@/store/useWorkflow";

/**
 * Optimistic-concurrency conflict dialog (ADR 0034 B5) for a 409 `branch_moved` commit: rebase onto
 * the moved head or discard. Escape/backdrop keeps the local edits — never a silent retry or overwrite.
 */
export function BranchMovedDialog({ onResolved }: { onResolved?: () => void } = {}) {
  const branchMoved = useWorkflow((s) => s.branchMoved);
  const rebaseOntoHead = useWorkflow((s) => s.rebaseOntoHead);
  const discardAndLoadHead = useWorkflow((s) => s.discardAndLoadHead);
  const dismiss = useWorkflow((s) => s.dismissBranchMoved);

  const dialogRef = useRef<HTMLDivElement>(null);
  const rebaseRef = useRef<HTMLButtonElement>(null);
  // Which resolution is running; disables both buttons so the two async paths never overlap.
  const [pending, setPending] = useState<"rebase" | "discard" | null>(null);
  const busy = pending !== null;

  const open = branchMoved !== null;

  useEffect(() => {
    if (!open) return;
    // Focus the recommended path on open; restore focus to the trigger on close.
    const prev = document.activeElement as HTMLElement | null;
    rebaseRef.current?.focus();
    return () => prev?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape is the safe exit (keep editing) — but not mid-resolution.
      if (e.key === "Escape") {
        if (!busy) dismiss();
        return;
      }
      // Trap Tab within the dialog.
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, dismiss]);

  if (!branchMoved) return null;

  // A resolution succeeded iff branchMoved is cleared: both store actions leave it set on failure.
  const resolvedOk = () => useWorkflow.getState().branchMoved === null;
  const runRebase = async () => {
    setPending("rebase");
    try {
      await rebaseOntoHead();
      if (resolvedOk()) onResolved?.();
    } finally {
      setPending(null);
    }
  };
  const runDiscard = async () => {
    setPending("discard");
    try {
      await discardAndLoadHead();
      if (resolvedOk()) onResolved?.();
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={() => {
        if (!busy) dismiss();
      }}
    >
      <motion.div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="This branch moved on"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="rounded-2xl p-6 max-w-[420px] w-full mx-4"
        style={{
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span
          className="grid place-items-center w-9 h-9 rounded-lg mb-3"
          style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
          aria-hidden
        >
          <GitBranch size={17} />
        </span>
        <h2 className="text-[15px] font-semibold m-0 mb-2" style={{ color: "var(--orchestr-ink)" }}>
          This branch moved on
        </h2>
        <p className="text-[13px] m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
          Someone committed while you were editing — the latest is now{" "}
          <span className="font-semibold" style={{ color: "var(--orchestr-ink)" }}>
            v{branchMoved.currentHeadVersionNumber}
          </span>
          . Rebase to replay your changes on top of it, or discard your changes and load the
          latest. Your edits are still here either way until you choose.
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="destructive" size="sm" onClick={runDiscard} disabled={busy}>
            {pending === "discard" ? (
              <>
                <SaratiLoader size={13} /> Discarding…
              </>
            ) : (
              "Discard my changes"
            )}
          </Button>
          <Button ref={rebaseRef} size="sm" onClick={runRebase} disabled={busy}>
            {pending === "rebase" ? (
              <>
                <SaratiLoader size={13} /> Rebasing…
              </>
            ) : (
              "Rebase onto latest"
            )}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
