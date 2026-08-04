// Resumable editor drafts: per-user AUTO-SAVED working state, explicitly NOT a version — exactly one
// per (user, workflow) plus one scratch draft, keyed per user so two accounts never cross-read.
// localStorage-backed, so deliberately single-device.

/** A resumable editor draft; `savedAt` is an ISO timestamp so it feeds `timeAgo` directly. */
export interface WorkflowDraft {
  ir: Record<string, unknown>;
  name: string;
  savedAt: string;
}

/** null workflowId ⇒ the per-user build-from-scratch ("scratch") draft. */
function draftKey(userId: string, workflowId: string | null): string {
  return `orchestr:draft:${userId}:${workflowId ?? "scratch"}`;
}

/** SSR-safe: nothing to read/write without a real user + a `window`. */
function storage(userId: string | null | undefined): Storage | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage disabled (private mode / blocked cookies) — drafts just no-op.
    return null;
  }
}

export function saveDraft(
  userId: string | null | undefined,
  workflowId: string | null,
  draft: WorkflowDraft,
): void {
  const store = storage(userId);
  if (!store) return;
  try {
    store.setItem(draftKey(userId!, workflowId), JSON.stringify(draft));
  } catch {
    // Quota exceeded / serialization failure — the draft just isn't saved.
  }
}

export function loadDraft(
  userId: string | null | undefined,
  workflowId: string | null,
): WorkflowDraft | null {
  const store = storage(userId);
  if (!store) return null;
  try {
    const raw = store.getItem(draftKey(userId!, workflowId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // localStorage can hold hand-edited or stale-schema data — a malformed draft reads as "no draft".
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as WorkflowDraft).ir !== "object" ||
      (parsed as WorkflowDraft).ir === null ||
      typeof (parsed as WorkflowDraft).savedAt !== "string"
    ) {
      return null;
    }
    const d = parsed as WorkflowDraft;
    return { ir: d.ir, name: typeof d.name === "string" ? d.name : "", savedAt: d.savedAt };
  } catch {
    return null;
  }
}

export function clearDraft(userId: string | null | undefined, workflowId: string | null): void {
  const store = storage(userId);
  if (!store) return;
  try {
    store.removeItem(draftKey(userId!, workflowId));
  } catch {
    /* ignore */
  }
}
