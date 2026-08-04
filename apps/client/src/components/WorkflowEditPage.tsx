"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, GitBranch } from "lucide-react";
import InlineRename from "./InlineRename";
import { useWorkflow } from "@/store/useWorkflow";
import { Button } from "@/components/ui/button";
import { ResumeDraftModal } from "@/components/ResumeDraftModal";
import { BranchMovedDialog } from "@/components/BranchMovedDialog";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useDraftAutosave } from "@/lib/useDraftAutosave";
import { useSessionUserId } from "@/lib/useSessionUserId";
import { loadDraft, clearDraft, type WorkflowDraft } from "@/lib/drafts";
import { irContentKey } from "@/lib/irCompare";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useMissingRequired } from "@/lib/workflow-validation";
import { useComposerAvailable } from "@/lib/useComposerAvailable";
import { SaratiLoader } from "./SaratiLogo";
import ComposerBar from "./ComposerBar";
import ComposerPanelHeader from "./ComposerPanelHeader";
import ComposerOpener from "./ComposerOpener";
import PreviewPanel from "./PreviewPanel";

/** Standalone editor for a live workflow — loads a branch head, saves a new version, autosaves to a per-user draft. */
export default function WorkflowEditPage() {
  const params = useParams();
  const id = params.id ? String(params.id) : undefined;
  const router = useRouter();
  // Which branch this editor works on: loads its head, saves commits to it.
  const searchParams = useSearchParams();
  const branch = searchParams.get("branch") || "main";
  const onMain = branch === "main";
  // Continue-from-vN (?v=): opens THAT version's content; Save appends a new
  // head and the old version stays immutable history.
  const fromVersion = searchParams.get("v") ? Number(searchParams.get("v")) : undefined;
  // Flips once a save lands from a ?v=N entry — the canvas is the new head, so
  // framing, URL param and draft slot all switch to plain head editing.
  const [savedPastFromVersion, setSavedPastFromVersion] = useState(false);
  const editContextKey = `${id}|${branch}|${fromVersion ?? ""}`;
  const [lastContextKey, setLastContextKey] = useState(editContextKey);
  if (editContextKey !== lastContextKey) {
    setLastContextKey(editContextKey);
    setSavedPastFromVersion(false);
  }
  const effectiveFromVersion = savedPastFromVersion ? undefined : fromVersion;
  // Branch drafts get their own slot — a shared slot would cross-apply a branch
  // edit onto main.
  const draftId = id
    ? `${onMain ? id : `${id}@${branch}`}${effectiveFromVersion ? `#v${effectiveFromVersion}` : ""}`
    : undefined;

  const loadForEdit = useWorkflow((s) => s.loadForEdit);
  const saveDeployedEdits = useWorkflow((s) => s.saveDeployedEdits);
  const resumeDraftIr = useWorkflow((s) => s.resumeDraftIr);
  const reset = useWorkflow((s) => s.reset);
  const workflowJson = useWorkflow((s) => s.workflowJson);
  const workflowName = useWorkflow((s) => s.workflowName);
  const dirty = useWorkflow((s) => s.dirty);
  const isLoading = useWorkflow((s) => s.isLoading);
  // Namespace drafts per user; the profile store isn't loaded on this route, so
  // use the always-available session id.
  const userId = useSessionUserId();

  // Track load outcome by id so the view state derives — it resets to "loading"
  // for free when the id changes.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [resumeDraft, setResumeDraft] = useState<WorkflowDraft | null>(null);
  // Collapsible, never unmounted: display-toggling keeps the composer's SSE
  // stream and thread alive.
  const [panelOpen, setPanelOpen] = useState(false);
  const state = failedId === id ? "error" : loadedId === id ? "ready" : "loading";
  // The composer serves canvases on main only — its merge base and save path
  // target main's draft; branch edits keep the classic surface. An instance
  // without the composer falls to that same classic surface; while the probe
  // is still out we assume present, so the common install never flashes.
  const composer = useComposerAvailable();
  const composerHere = state === "ready" && onMain && composer?.available !== false;
  useDocumentTitle("Edit", workflowName ?? undefined);

  // Read the user id through a ref so the async load decision below stays
  // current without re-triggering the load.
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  });

  useEffect(() => {
    if (!id) return;
    const draftKey = `${branch === "main" ? id : `${id}@${branch}`}${fromVersion ? `#v${fromVersion}` : ""}`;
    let active = true;
    loadForEdit(id, branch, fromVersion).then((ok) => {
      if (!active) return;
      if (!ok) {
        clearDraft(userIdRef.current, draftKey); // a dead workflow's draft dies with it
        setFailedId(id);
        return;
      }
      setLoadedId(id);
      // Draft resume: a draft matching the freshly-loaded head is nothing to
      // resume, so clear it silently.
      const uid = userIdRef.current;
      const draft = loadDraft(uid, draftKey);
      const head = useWorkflow.getState().workflowJson;
      if (draft && head && irContentKey(draft.ir) === irContentKey(head)) {
        clearDraft(uid, draftKey);
        setResumeDraft(null);
        return;
      }
      setResumeDraft(draft);
    });
    // Clear the deployed-edit state on the way out so it can't leak into the
    // generate pipeline, which renders from the same store.
    return () => {
      active = false;
      reset();
    };
  }, [id, branch, fromVersion, loadForEdit, reset]);

  const backToOverview = () =>
    router.push(`/workflows/${id}/overview${onMain ? "" : `?branch=${encodeURIComponent(branch)}`}`);

  const flushDraft = useDraftAutosave({
    userId,
    workflowId: draftId ?? null,
    ir: workflowJson,
    name: workflowName ?? "",
    enabled: dirty,
  });

  // Deploy gate: the same per-node required-field walk the compose page's
  // Create gate uses, so an incomplete node is caught here, not at run time.
  const missing = useMissingRequired(workflowJson);

  const [commitMessage, setCommitMessage] = useState("");
  const handleSave = async () => {
    if (missing.length > 0) {
      toast.error(
        "Some steps are missing required fields",
        "Fill the highlighted fields before saving a new version.",
      );
      return;
    }
    await saveDeployedEdits(commitMessage);
    // saveDeployedEdits clears `dirty` and toasts the minted version; the
    // editor stays on the canvas because a save is a checkpoint, not an exit.
    if (!useWorkflow.getState().dirty) {
      clearDraft(userId, draftId ?? null);
      setCommitMessage("");
      if (fromVersion) {
        // Strip ?v= without a router nav — the load effect's cleanup would
        // reset the store and blank the canvas.
        const query = onMain ? "" : `?branch=${encodeURIComponent(branch)}`;
        window.history.replaceState(null, "", `/workflows/${id}/edit${query}`);
        setSavedPastFromVersion(true);
      }
    }
  };

  const handleResume = () => {
    if (!resumeDraft) return;
    resumeDraftIr(resumeDraft.ir); // loads the draft IR, marks dirty
    setResumeDraft(null);
  };
  const handleStartFresh = () => {
    clearDraft(userId, draftId ?? null); // edit → the freshly-loaded head stays
    setResumeDraft(null);
  };

  // Back never asks: flush the draft synchronously (the debounce may not have
  // fired) and confirm with a toast.
  const handleBack = () => {
    if (dirty) {
      flushDraft();
      toast.success("Draft saved");
    }
    backToOverview();
  };

  return (
    <div
      className={`${composerHere ? "h-screen" : "min-h-screen"} flex flex-col`}
      style={{ background: "var(--orchestr-surface)" }}
    >
      <header
        className="shrink-0 h-14 flex items-center gap-3 px-6"
        style={{ borderBottom: "1px solid var(--orchestr-line)" }}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to workflow"
          title="Back to workflow"
          onClick={handleBack}
        >
          <ArrowLeft size={15} />
        </Button>
        <div className="w-px h-5 shrink-0" style={{ background: "var(--orchestr-line)" }} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <InlineRename
              workflowId={id}
              name={workflowName ?? "Edit workflow"}
              canRename={state === "ready"}
              onRenamed={(next) => {
                useWorkflow.setState({ workflowName: next });
                // Keep the doc's own name in sync so the next content save carries it.
                useWorkflow.getState().setWorkflowDocName(next);
              }}
            />
            {!onMain && (
              <span
                className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded"
                style={{ background: "var(--orchestr-accent-tint-strong)", color: "var(--orchestr-ink)" }}
                data-testid="editor-branch-chip"
              >
                <GitBranch size={10} />
                {branch}
              </span>
            )}
          </div>
          <p className="text-[11px] m-0 leading-tight" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {effectiveFromVersion
              ? `Continuing from v${effectiveFromVersion} · Save creates a new version, v${effectiveFromVersion} stays as it was`
              : !onMain
              ? `Editing branch ${branch} · saves commit to this branch, the live workflow is untouched`
              : "Editing the live workflow · saves commit a new version on Sarati"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {dirty && (
            <span className="text-[11px] flex items-center gap-1.5 shrink-0" style={{ color: "var(--orchestr-warning)" }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--orchestr-warning)" }} />
              Unsaved changes
            </span>
          )}
          {dirty && (
            <input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="What changed? (optional)"
              aria-label="Version comment"
              className="h-8 w-[220px] px-2.5 rounded-lg text-[12px] outline-none"
              style={{
                background: "var(--orchestr-surface-card)",
                border: "1px solid var(--orchestr-line)",
                color: "var(--orchestr-ink)",
              }}
            />
          )}
          {dirty && missing.length > 0 && (
            <span className="text-[11px] shrink-0" style={{ color: "var(--orchestr-warning)" }}>
              {missing.length} required field{missing.length !== 1 ? "s" : ""} missing
            </span>
          )}
          <Button size="sm" onClick={handleSave} disabled={!dirty || isLoading || missing.length > 0}>
            {isLoading ? (
              <>
                <SaratiLoader size={13} /> Saving…
              </>
            ) : (
              <>
                <Check size={13} />{" "}
                {!onMain ? `Save to ${branch}` : "Save new version"}
              </>
            )}
          </Button>
        </div>
      </header>

      {/* Body — composer-first when the composer serves this canvas, the classic editor otherwise. */}
      {composerHere && workflowJson ? (
        <div className="flex-1 min-h-0 flex">
          {/* Display-toggled, never unmounted — collapsing must not drop the composer stream or thread. */}
          <aside
            className="shrink-0 flex flex-col min-h-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none"
            style={{ width: panelOpen ? 452 : 0 }}
            aria-label="Composer"
          >
            <div className="w-[452px] flex-1 min-h-0 flex flex-col p-1.5">
              <div
                className="flex-1 min-h-0 flex flex-col rounded-2xl overflow-hidden"
                style={{
                  background: "var(--orchestr-surface-card, var(--orchestr-surface))",
                  border: "1px solid var(--orchestr-line)",
                  boxShadow: "0 10px 34px rgba(0,0,0,0.30)",
                }}
              >
                <ComposerPanelHeader onClose={() => setPanelOpen(false)} />
                <div className="flex-1 min-h-0 flex flex-col">
                  <ComposerBar panel workflowId={id} />
                </div>
              </div>
            </div>
          </aside>
          <ComposerOpener open={panelOpen} onOpen={() => setPanelOpen(true)} />
          <main className="flex-1 min-w-0 pt-4 px-2 pb-2 flex flex-col">
            <PreviewPanel bare />
          </main>
        </div>
      ) : (
        <main className="flex-1 min-h-0 w-full max-w-[1400px] mx-auto px-6 py-5 flex flex-col gap-3">
          {state === "loading" && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <SaratiLoader size={40} />
              <p className="text-[12.5px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Opening the editor…
              </p>
            </div>
          )}
          {state === "error" && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <p className="text-[13px] m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
                Couldn't open this workflow for editing.
              </p>
              <Button variant="secondary" size="sm" onClick={backToOverview}>
                Back to overview
              </Button>
            </div>
          )}
          {state === "ready" && workflowJson && (
            <div className="flex-1 min-h-0">
              <PreviewPanel />
            </div>
          )}
        </main>
      )}

      {state === "ready" && resumeDraft && (
        <ResumeDraftModal
          title="Resume your draft?"
          message={`You have unsaved edits from ${timeAgo(resumeDraft.savedAt)}. Continue where you left off, or start fresh from the live version.`}
          onContinue={handleResume}
          onStartFresh={handleStartFresh}
        />
      )}

      {/* Optimistic-concurrency guard (ADR 0034): a 409 from either save path surfaces the same
          rebase/discard dialog; resolving drops the now-stale autosaved draft. */}
      <BranchMovedDialog onResolved={() => clearDraft(userId, draftId ?? null)} />
    </div>
  );
}
