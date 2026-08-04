"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Rocket } from "lucide-react";
import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import DiffView from "./DiffView";

interface PromoteDialogProps {
  workflowId: string;
  /** The environment being pointed (lowercase slug — "staging", "prod", …). */
  environment: string;
  /** The version about to run in this environment. */
  targetVersion: number;
  targetVersionId: string;
  /** What the environment runs now (null = nothing promoted there yet). */
  currentVersion: number | null;
  /** Version id of what the environment runs now — the unambiguous from side of the diff (invariant #1). */
  currentVersionId?: string | null;
  /** Branch the target version lives on (version numbers are per-branch); undefined = main. */
  targetBranch?: string;
  onClose: () => void;
  /** Fired after a successful promote so the parent can refetch. */
  onPromoted: () => void;
}

/** Promotion confirmation — shows the field-level diff, then moves that environment's pointer. */
export default function PromoteDialog({
  workflowId,
  environment,
  targetVersion,
  targetVersionId,
  currentVersion,
  currentVersionId,
  targetBranch,
  onClose,
  onPromoted,
}: PromoteDialogProps) {
  const [promoting, setPromoting] = useState(false);
  // Compare IDENTITY, not the number: version numbers are per-branch, so promoting feature@v3 over
  // a pointer at main@v3 is a real change that a number comparison calls a no-op (invariant #1).
  const canDiff =
    currentVersion != null &&
    (currentVersionId != null ? currentVersionId !== targetVersionId : currentVersion !== targetVersion);
  const sameNumber = currentVersion === targetVersion;

  // Escape closes (unless a promote is in flight) — same pattern as publish.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !promoting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, promoting]);

  const handlePromote = async () => {
    setPromoting(true);
    try {
      const res = await api.promoteToEnvironment(workflowId, environment, targetVersionId);
      toast.success(
        `${environment} runs v${res.version_number}`,
        `Runs and ${environment}-scoped triggers use this version now.`,
      );
      onPromoted();
    } catch (e) {
      toast.error(`Couldn't promote to ${environment}`, e instanceof Error ? e.message : undefined);
      setPromoting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={() => !promoting && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={`Promote v${targetVersion} to ${environment}`}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="rounded-2xl w-full max-w-[560px] mx-4 flex flex-col max-h-[85vh]"
        style={{
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 pb-3">
          <h2 className="text-[16px] font-semibold m-0 flex items-center gap-2" style={{ color: "var(--orchestr-ink)" }}>
            <Rocket size={16} style={{ color: "var(--orchestr-success)" }} />
            Promote v{targetVersion} to {environment}
          </h2>
          <p className="text-[13px] m-0 mt-1.5 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
            {canDiff ? (
              <>
                Here is exactly what {environment} will start doing — the change from{" "}
                <span className="font-mono font-semibold" style={{ color: "var(--orchestr-ink)" }}>
                  {sameNumber ? `the version ${environment} runs now` : `v${currentVersion}`}
                </span>{" "}
                to{" "}
                <span className="font-mono font-semibold" style={{ color: "var(--orchestr-ink)" }}>
                  v{targetVersion}
                </span>
                .
              </>
            ) : (
              <>
                {environment} will start running v{targetVersion}. Runs and {environment}-scoped triggers use
                it immediately.
              </>
            )}
          </p>
        </div>

        {canDiff && (
          <div className="px-6 py-1 overflow-y-auto flex-1 min-h-0">
            <DiffView
              workflowId={workflowId}
              fromVersion={currentVersion}
              toVersion={targetVersion}
              fromVersionId={currentVersionId}
              toVersionId={targetVersionId}
              toBranch={targetBranch}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 p-6 pt-4" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={promoting}>
            Cancel
          </Button>
          <Button variant="success" size="sm" onClick={handlePromote} disabled={promoting}>
            <Rocket size={13} />
            {promoting ? "Promoting…" : `Promote to ${environment}`}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
