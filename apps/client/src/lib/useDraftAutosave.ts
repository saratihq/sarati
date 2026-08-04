"use client";

import { useEffect, useRef } from "react";
import { saveDraft, type WorkflowDraft } from "@/lib/drafts";

interface AutosaveParams {
  /** Namespaces the draft per user (Clerk id). Nullish ⇒ nothing is written. */
  userId: string | null | undefined;
  /** null ⇒ the per-user scratch draft (build-from-scratch). */
  workflowId: string | null;
  /** The working document to persist (store's `workflowJson`). */
  ir: Record<string, unknown> | null;
  /** Name to persist alongside the IR (typed name on scratch; workflow name on edit). */
  name: string;
  /** Only auto-save when there's real work: `dirty` (edit) or `hasSteps` (scratch). */
  enabled: boolean;
}

function write(params: AutosaveParams): void {
  const { userId, workflowId, ir, name, enabled } = params;
  if (!enabled || !userId || !ir) return;
  const draft: WorkflowDraft = { ir, name, savedAt: new Date().toISOString() };
  saveDraft(userId, workflowId, draft);
}

/**
 * Debounced auto-save of the editor's working state to a resumable draft, flushed on tab hide.
 * Returns a `flush()` for in-app navigation, where the debounce timer may not have fired yet.
 */
export function useDraftAutosave({ userId, workflowId, ir, name, enabled }: AutosaveParams): () => void {
  // Kept current in an effect, so the flush paths never assign a ref in render or read stale data.
  const latest = useRef({ userId, workflowId, ir, name, enabled });
  useEffect(() => {
    latest.current = { userId, workflowId, ir, name, enabled };
  });

  // Each change resets the timer; persist after 800ms idle.
  useEffect(() => {
    if (!enabled || !userId || !ir) return;
    const t = setTimeout(() => write({ userId, workflowId, ir, name, enabled }), 800);
    return () => clearTimeout(t);
  }, [enabled, userId, workflowId, ir, name]);

  // References only the stable `latest` ref + the module `write`, so [] is exact.
  useEffect(() => {
    const onHide = () => write(latest.current);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  return () => write(latest.current);
}
