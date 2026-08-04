"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ResumeDraftModalProps {
  /** Short heading, e.g. "Resume your draft?". */
  title: string;
  /** Recognition line, e.g. "You have an unsaved workflow from 5m ago." */
  message: string;
  /** Primary path — load the saved draft into the editor. */
  onContinue: () => void;
  /** Secondary path — discard the draft and start from the clean canvas. */
  onStartFresh: () => void;
}

/** Blocking resume decision over a frozen editor — Escape and backdrop clicks do nothing; the two buttons are the only exits. */
export function ResumeDraftModal({ title, message, onContinue, onStartFresh }: ResumeDraftModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the recommended path on open; restore focus to the trigger on close.
    const prev = document.activeElement as HTMLElement | null;
    continueRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    // Trap Tab within the dialog (no Escape handler — Escape is a no-op here).
    const onKey = (e: KeyboardEvent) => {
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
  }, []);

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="rounded-2xl p-6 max-w-[400px] w-full mx-4"
        style={{
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
      >
        <span
          className="grid place-items-center w-9 h-9 rounded-lg mb-3"
          style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-accent)" }}
          aria-hidden
        >
          <History size={17} />
        </span>
        <h2 className="text-[15px] font-semibold m-0 mb-2" style={{ color: "var(--orchestr-ink)" }}>
          {title}
        </h2>
        <p className="text-[13px] m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
          {message}
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" size="sm" onClick={onStartFresh}>
            Start fresh
          </Button>
          <Button ref={continueRef} size="sm" onClick={onContinue}>
            Continue draft
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
