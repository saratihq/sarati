"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Rocket } from "lucide-react";
import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import DiffView from "./DiffView";

interface PublishDialogProps {
  workflowId: string;
  /** The version running now (null = nothing published yet — the first publish). */
  liveVersion: number | null;
  /** Version id of the live version — the unambiguous from side of the diff (invariant #1). */
  liveVersionId?: string | null;
  /** The version about to go live (the default-branch head). */
  latestVersion: number;
  /** Version id of the default-branch head — the unambiguous to side of the diff. */
  latestVersionId?: string | null;
  onClose: () => void;
  /** Fired after a successful publish so the parent can refetch. */
  onPublished: (liveVersion: number) => void;
}

/** Release confirmation — shows the field-level live → latest diff, then moves the live pointer. */
export default function PublishDialog({
  workflowId,
  liveVersion,
  liveVersionId,
  latestVersion,
  latestVersionId,
  onClose,
  onPublished,
}: PublishDialogProps) {
  const [publishing, setPublishing] = useState(false);
  const canDiff =
    liveVersion != null &&
    (liveVersionId != null && latestVersionId != null
      ? liveVersionId !== latestVersionId
      : liveVersion < latestVersion);

  // Escape closes (unless a publish is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !publishing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, publishing]);

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const res = await api.publishWorkflow(workflowId, latestVersion);
      toast.success(`Published v${res.live_version} — now live`, "Runs and triggers now use this version.");
      onPublished(res.live_version);
    } catch (e) {
      toast.error("Couldn't publish", e instanceof Error ? e.message : undefined);
      setPublishing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={() => !publishing && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={`Publish v${latestVersion}`}
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
            Publish v{latestVersion}
          </h2>
          <p className="text-[13px] m-0 mt-1.5 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
            {canDiff ? (
              <>
                Here is exactly what production will start doing — the change from live{" "}
                <span className="font-mono font-semibold" style={{ color: "var(--orchestr-ink)" }}>
                  v{liveVersion}
                </span>{" "}
                to{" "}
                <span className="font-mono font-semibold" style={{ color: "var(--orchestr-ink)" }}>
                  v{latestVersion}
                </span>
                .
              </>
            ) : (
              <>
                This makes v{latestVersion} the live version. Runs and triggers will start using it immediately.
              </>
            )}
          </p>
        </div>

        {canDiff && (
          <div className="px-6 py-1 overflow-y-auto flex-1 min-h-0">
            <DiffView
              workflowId={workflowId}
              fromVersion={liveVersion}
              toVersion={latestVersion}
              fromVersionId={liveVersionId}
              toVersionId={latestVersionId}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 p-6 pt-4" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={publishing}>
            Cancel
          </Button>
          <Button variant="success" size="sm" onClick={handlePublish} disabled={publishing}>
            <Rocket size={13} />
            {publishing ? "Publishing…" : `Publish v${latestVersion}`}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
