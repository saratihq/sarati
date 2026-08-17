"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Rocket } from "lucide-react";
import { useComposer } from "@/store/useComposer";
import { UNTITLED_WORKFLOW, useWorkflow } from "@/store/useWorkflow";
import { adoptSessionForWorkflow } from "@/store/useComposer";
import { Button } from "@/components/ui/button";
import ComposerBar from "@/components/ComposerBar";
import ComposerPanelHeader from "@/components/ComposerPanelHeader";
import ComposerOpener from "@/components/ComposerOpener";
import InlineRename from "@/components/InlineRename";
import PreviewPanel from "@/components/PreviewPanel";
import { ResumeDraftModal } from "@/components/ResumeDraftModal";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useDraftAutosave } from "@/lib/useDraftAutosave";
import { useSessionUserId } from "@/lib/useSessionUserId";
import { clearDraft, loadDraft, type WorkflowDraft } from "@/lib/drafts";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useMissingRequired } from "@/lib/workflow-validation";
import { useComposerAvailable } from "@/lib/useComposerAvailable";

/**
 * Composer-first new workflow: the conversation IS the builder. Shares the seeded scratch document and
 * scratch draft slot with /workflows/build; the composer's own save creates the workflow.
 *
 * This is also the ONLY route that creates a workflow, so an instance without the composer must still
 * land here — it drops the panel and leaves the canvas, which is already a full manual editor.
 */
export default function ComposeNewWorkflowPage() {
  const router = useRouter();
  const startScratch = useWorkflow((s) => s.startScratch);
  const resumeDraftIr = useWorkflow((s) => s.resumeDraftIr);
  const setWorkflowDocName = useWorkflow((s) => s.setWorkflowDocName);
  const reset = useWorkflow((s) => s.reset);
  const workflowJson = useWorkflow((s) => s.workflowJson);
  const createdId = useWorkflow((s) => s.workflowId);
  const deploy = useWorkflow((s) => s.deploy);
  const isLoading = useWorkflow((s) => s.isLoading);
  const error = useWorkflow((s) => s.error);
  const streaming = useComposer((s) => s.streaming);
  const clearThread = useComposer((s) => s.clearThread);
  const suggestedName = useComposer((s) => s.suggestedName);
  const userId = useSessionUserId();
  useDocumentTitle("New workflow");

  const [name, setName] = useState("");
  // A person's own rename is final: the composer may re-plan, but it never renames over them.
  const renamedByHand = useRef(false);
  // Collapsed, never unmounted — unmounting would kill the composer's SSE stream and thread.
  const [panelOpen, setPanelOpen] = useState(true);
  // Assume present while the probe is out: this page opens with the panel expanded, and flashing it
  // shut on every normal install is worse than the brief opener on one that has no composer.
  const composer = useComposerAvailable();
  const composerHere = composer?.available !== false;
  useEffect(() => {
    startScratch();
    return () => reset();
  }, [startScratch, reset]);
  const seeded = workflowJson !== null;

  // The composer names the plan it just described, so a save never files it as "Untitled workflow".
  useEffect(() => {
    if (!suggestedName || renamedByHand.current) return;
    setName(suggestedName);
  }, [suggestedName]);

  // Every op_applied replaces the canvas document with the agent's, which carries the seeded name —
  // so the chosen name is re-asserted onto it rather than set once.
  const docName = typeof workflowJson?.name === "string" ? workflowJson.name : "";
  useEffect(() => {
    if (!seeded || !name || docName === name) return;
    setWorkflowDocName(name);
  }, [seeded, name, docName, setWorkflowDocName]);

  const nodeCount = Array.isArray(workflowJson?.nodes) ? (workflowJson.nodes as unknown[]).length : 0;
  const hasSteps = nodeCount > 1; // more than the trigger
  // The create gate: nothing incomplete deploys straight to LIVE.
  const missing = useMissingRequired(workflowJson);
  // Once the agent's save created the workflow, Save MUST disarm — clicking again would duplicate it.
  const canCreate = !isLoading && !streaming && hasSteps && missing.length === 0 && !createdId;

  // The same per-user scratch slot /workflows/build uses, so autosave here must never clobber its draft.
  const [resumeDraft, setResumeDraft] = useState<WorkflowDraft | null>(null);
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || !userId) return;
    decided.current = true;
    Promise.resolve().then(() => setResumeDraft(loadDraft(userId, null)));
  }, [userId]);

  const flushDraft = useDraftAutosave({ userId, workflowId: null, ir: workflowJson, name, enabled: hasSteps });

  // Follow a composer-driven save to the editor, where it reattaches. A manual Save navigates itself,
  // so the ref keeps this effect from racing it.
  const manualNav = useRef(false);
  useEffect(() => {
    if (createdId && !streaming && !manualNav.current) {
      clearDraft(userId, null); // the version now exists — consume the draft
      router.replace(`/workflows/${createdId}/edit`);
    }
  }, [createdId, streaming, router, userId]);

  const handleBack = () => {
    if (hasSteps) {
      flushDraft();
      toast.success("Draft saved");
    }
    router.push("/");
  };

  // Manual create — the composer is optional here, not a gate. Lands on the workflow's EDITOR.
  const handleCreate = async () => {
    if (missing.length > 0) {
      toast.error(
        "Some steps are missing required fields",
        "Fill the highlighted fields before creating this workflow.",
      );
      return;
    }
    manualNav.current = true;
    setWorkflowDocName(name.trim() || UNTITLED_WORKFLOW);
    await deploy();
    const created = useWorkflow.getState().workflowId;
    if (created) {
      clearDraft(userId, null); // the version now exists — consume the draft
      adoptSessionForWorkflow(created); // the conversation follows the workflow
      router.replace(`/workflows/${created}/edit`);
    } else {
      manualNav.current = false; // deploy failed — the composer path stays armed
    }
  };

  return (
    <div className="h-screen flex flex-col" style={{ background: "var(--orchestr-surface)" }}>
      <header
        className="shrink-0 h-14 flex items-center gap-3 px-6"
        style={{ borderBottom: "1px solid var(--orchestr-line)" }}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to dashboard"
          title="Back to dashboard"
          onClick={handleBack}
        >
          <ArrowLeft size={15} />
        </Button>
        <div className="w-px h-5 shrink-0" style={{ background: "var(--orchestr-line)" }} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {/* Local-only until the first Save creates the workflow row. */}
            <InlineRename
              name={name || UNTITLED_WORKFLOW}
              onRenamed={(next) => {
                renamedByHand.current = true;
                setName(next);
                setWorkflowDocName(next);
              }}
            />
          </div>
          <p className="text-[11px] m-0 leading-tight" style={{ color: "var(--orchestr-ink-subtle)" }}>
            New workflow · Save creates the first version on Sarati
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {error && (
            <span className="text-[12px] truncate max-w-[360px]" style={{ color: "var(--orchestr-danger)" }}>
              {error}
            </span>
          )}
          {!hasSteps && !error && (
            <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
              Add at least one step to save
            </span>
          )}
          {hasSteps && missing.length > 0 && !error && (
            <span className="text-[11px]" style={{ color: "var(--orchestr-warning)" }}>
              {missing.length} required field{missing.length !== 1 ? "s" : ""} missing
            </span>
          )}
          <Button size="sm" onClick={() => void handleCreate()} disabled={!canCreate}>
            <Rocket size={13} />
            {isLoading ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>
      <div className="flex-1 min-h-0 flex">
        {/* Width-animated, never unmounted — collapsing must not drop the composer stream or thread. */}
        <aside
          className="shrink-0 flex flex-col min-h-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: composerHere && panelOpen ? 452 : 0 }}
          aria-label="Composer"
          hidden={!composerHere}
        >
          {/* A detached card, inset just enough that the header stays anchored to the opener. */}
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
                <ComposerBar panel />
              </div>
            </div>
          </div>
        </aside>
        {composerHere && <ComposerOpener open={panelOpen} onOpen={() => setPanelOpen(true)} />}
        <main className="flex-1 min-w-0 pt-4 px-2 pb-2 flex flex-col">
          {seeded && <PreviewPanel scratch bare />}
        </main>
      </div>

      {resumeDraft !== null && (
        <ResumeDraftModal
          title="Resume your draft?"
          message={`You have an unsaved workflow from ${timeAgo(resumeDraft.savedAt)}. Continue where you left off, or start fresh on a blank canvas.`}
          onContinue={() => {
            resumeDraftIr(resumeDraft.ir);
            setName(resumeDraft.name);
            setResumeDraft(null);
          }}
          onStartFresh={() => {
            // Two layers hold unsaved work: the canvas draft AND the durable composer session, which
            // rebuilds both conversation and canvas on reattach. A fresh start must clear both.
            clearDraft(userId, null);
            void clearThread(undefined);
            startScratch();
            setName("");
            setResumeDraft(null);
          }}
        />
      )}
    </div>
  );
}
