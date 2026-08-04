"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Button } from "./button";

interface ConfirmDialogProps {
  open: boolean;
  /** Short heading. Defaults to "Are you sure?". */
  title?: string;
  /** What's about to happen, in plain words. */
  message: string;
  /** Extra consequence line, rendered in danger color (e.g. "This cannot be undone."). */
  consequence?: string;
  /** Require the user to type this exact string to enable the confirm CTA (destructive ops). */
  nameEcho?: string;
  confirmLabel?: string;
  /** Label for the cancel CTA (e.g. "Keep editing"). Defaults to "Cancel". */
  cancelLabel?: string;
  /** Solid-danger confirm CTA. Implied when nameEcho is set. */
  destructive?: boolean;
  /** Optional third way out (e.g. "Save & leave"), rendered left of the CTA pair. */
  alt?: { label: string; onClick: () => void };
  onConfirm: () => void;
  onCancel: () => void;
}

/** THE confirm dialog: blur backdrop, Escape/backdrop cancel, optional type-the-name gate. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  // Body is a separate component so its state mounts fresh on every open.
  if (!props.open) return null;
  return <ConfirmDialogBody {...props} />;
}

function ConfirmDialogBody({
  title = "Are you sure?",
  message,
  consequence,
  nameEcho,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  alt,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [echo, setEcho] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      // Trap Tab within the dialog so focus can't reach the controls behind the backdrop.
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
  }, [onCancel]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Name-echo input autofocuses itself; otherwise focus the confirm button.
    if (!nameEcho) confirmRef.current?.focus();
    return () => prev?.focus?.();
  }, [nameEcho]);

  const isDestructive = destructive || Boolean(nameEcho);
  const confirmBlocked = Boolean(nameEcho) && echo !== nameEcho;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onCancel}
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
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold m-0 mb-2" style={{ color: "var(--orchestr-ink)" }}>
          {title}
        </h2>
        <p className="text-[13px] m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
          {message}
        </p>
        {consequence && (
          <p className="text-xs mt-2 m-0 font-medium" style={{ color: "var(--orchestr-danger)" }}>
            {consequence}
          </p>
        )}
        {nameEcho && (
          <div className="mt-4">
            <label className="block text-xs mb-1.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
              Type{" "}
              <span className="font-semibold" style={{ color: "var(--orchestr-ink)" }}>
                {nameEcho}
              </span>{" "}
              to confirm
            </label>
            <input
              value={echo}
              onChange={(e) => setEcho(e.target.value)}
              autoFocus
              className="w-full py-2 px-3 rounded-lg text-sm outline-none"
              style={{
                background: "var(--orchestr-accent-tint)",
                border: "1px solid var(--orchestr-line)",
                color: "var(--orchestr-ink)",
              }}
              placeholder={nameEcho}
            />
          </div>
        )}
        <div className="flex justify-end gap-2 mt-5">
          {alt && (
            <Button variant="secondary" size="sm" className="mr-auto" onClick={alt.onClick}>
              {alt.label}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={isDestructive ? "destructiveSolid" : "default"}
            size="sm"
            disabled={confirmBlocked}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}