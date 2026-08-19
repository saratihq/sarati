"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Undo2, Redo2 } from "lucide-react";
import { useWorkflow } from "@/store/useWorkflow";
import { useCanvasHistory } from "@/lib/useCanvasHistory";
import { useCanvasClipboard } from "@/lib/useCanvasClipboard";
import { Button } from "@/components/ui/button";
import ConnectCaptureBanner from "./ConnectCaptureBanner";
import FlowCanvas from "./FlowCanvas";
import IrNodeInspector from "./IrNodeInspector";
import NodeCatalogPanel from "./NodeCatalogPanel";
import EditorRunButton from "./EditorRunButton";

/** Undo/redo pair for the editor chrome — recognition over recall beside Run. */
function HistoryButtons({
  undo,
  redo,
  canUndo,
  canRedo,
}: {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={undo}
        disabled={!canUndo}
        aria-label="Undo"
        title="Undo (⌘Z)"
      >
        <Undo2 size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={redo}
        disabled={!canRedo}
        aria-label="Redo"
        title="Redo (⇧⌘Z)"
      >
        <Redo2 size={15} />
      </Button>
    </div>
  );
}

/** The Review workspace — a real editor: drag, wire ports, add steps, configure in the inspector. */
// `scratch` (build page) speaks building rather than editing; `bare` (compose)
// drops the AI chrome but keeps the manual editing tools.
export default function PreviewPanel({
  scratch = false,
  bare = false,
}: {
  scratch?: boolean;
  bare?: boolean;
}) {
  const workflowJson = useWorkflow((s) => s.workflowJson);
  const workflowIr = useWorkflow((s) => s.workflowIr);
  const editorMode = useWorkflow((s) => s.editorMode);
  const setStripReady = useWorkflow((s) => s.setStripReady);
  const updateNodePosition = useWorkflow((s) => s.updateNodePosition);
  const addIrNodeFromCatalog = useWorkflow((s) => s.addIrNodeFromCatalog);
  const addWorkflowConnection = useWorkflow((s) => s.addWorkflowConnection);
  const removeWorkflowConnection = useWorkflow(
    (s) => s.removeWorkflowConnection,
  );
  const deleteWorkflowNode = useWorkflow((s) => s.deleteWorkflowNode);

  const [selectedName, setSelectedName] = useState<string | null>(null);

  useEffect(() => {
    setStripReady(true);
  }, [setStripReady]);

  // The canvas edits the IR document directly (workflowJson IS the IR);
  // non-IR documents — empty or loading — stay drag-only.
  const irBacked = useMemo(() => {
    const n = (workflowIr as { nodes?: unknown[] } | null)?.nodes;
    return Array.isArray(n) && n.length > 0;
  }, [workflowIr]);
  const canEditIr =
    irBacked &&
    Array.isArray((workflowJson as { edges?: unknown[] } | null)?.edges);

  // Undo/redo is live only while the canvas is editable, so the shortcut never
  // intercepts ⌘Z on a loading or preview-only surface.
  const { undo, redo, canUndo, canRedo } = useCanvasHistory(canEditIr);

  // Bumping pasteSelection's nonce tells the canvas to select the freshly-pasted clones.
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [pasteSelection, setPasteSelection] = useState<{
    ids: string[];
    nonce: number;
  }>({ ids: [], nonce: 0 });
  const handleSelectionChange = useCallback(
    (ids: string[]) => setSelectedNodeIds(ids),
    [],
  );
  const handlePasted = useCallback((newIds: string[]) => {
    setSelectedNodeIds(newIds);
    setPasteSelection((p) => ({ ids: newIds, nonce: p.nonce + 1 }));
  }, []);
  useCanvasClipboard(canEditIr, selectedNodeIds, handlePasted);

  // The inspector and the catalog panel share the right-hand slot.
  const [catalogOpen, setCatalogOpen] = useState(false);
  const irNodeIds = useMemo(() => {
    const nodes = (workflowJson?.nodes as Array<{ id?: string }>) ?? [];
    // The trigger node is included — it carries its own inspector config as a
    // version-doc node.
    return new Set(nodes.filter((n) => n.id).map((n) => n.id as string));
  }, [workflowJson]);
  const irActiveSelection =
    canEditIr && selectedName && irNodeIds.has(selectedName)
      ? selectedName
      : null;

  const handleNodeClick = useCallback((id: string) => {
    setSelectedName(id);
  }, []);
  const handleCanvasClick = useCallback(() => setSelectedName(null), []);
  const handleDeleteNodes = useCallback(
    (names: string[]) => {
      names.forEach(deleteWorkflowNode);
    },
    [deleteWorkflowNode],
  );
  const handleDeleteEdges = useCallback(
    (
      edges: {
        source: string;
        target: string;
        port?: number;
        portType?: "main" | "error" | "tool";
      }[],
    ) => {
      edges.forEach((e) =>
        removeWorkflowConnection(e.source, e.target, e.port, e.portType),
      );
    },
    [removeWorkflowConnection],
  );

  if (!workflowJson) return null;

  const helper = canEditIr
    ? "Drag cards to rearrange · drag port → port to wire steps · Delete removes a selected step or wire"
    : irBacked
      ? "Preview of your workflow — create it on the engine when it looks right."
      : "Click a node to configure it · drag cards to rearrange · drag port → port to wire steps";

  return (
    <div className="flex flex-col h-full min-h-0">
      {bare && canEditIr && (
        // pr-3 keeps the toolbar off the edge while the canvas below runs edge-to-edge.
        <div className="flex justify-end items-center gap-2 mb-2 pr-3">
          <HistoryButtons
            undo={undo}
            redo={redo}
            canUndo={canUndo}
            canRedo={canRedo}
          />
          <EditorRunButton />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCatalogOpen((o) => !o)}
          >
            {catalogOpen ? "Close catalog" : "+ Add step"}
          </Button>
        </div>
      )}
      {/* Canvas state, not AI chrome — it stays in bare mode. */}
      {bare && canEditIr && <ConnectCaptureBanner />}
      {!bare && (
        <>
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <div className="min-w-0">
              <h3
                className="text-[17px] font-semibold m-0"
                style={{ color: "var(--orchestr-ink)" }}
              >
                {scratch
                  ? "Build your workflow"
                  : editorMode === "deployed"
                    ? "Edit workflow"
                    : "Review & refine"}
              </h3>
              <p
                className="text-[12px] m-0 mt-1"
                style={{ color: "var(--orchestr-ink-muted)" }}
              >
                {helper}
              </p>
            </div>
            {canEditIr && (
              <div className="shrink-0 flex items-center gap-2">
                <HistoryButtons
                  undo={undo}
                  redo={redo}
                  canUndo={canUndo}
                  canRedo={canRedo}
                />
                <EditorRunButton />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setCatalogOpen((o) => !o)}
                >
                  {catalogOpen ? "Close catalog" : "+ Add step"}
                </Button>
              </div>
            )}
          </div>

          {/* Post-generation capture — purely additive; Create/Deploy never gate on it. */}
          {canEditIr && <ConnectCaptureBanner />}
        </>
      )}

      {/* Non-bare hosts don't bound their flex chain, so the row needs a fixed height —
          otherwise a long panel grows the row and the page scrolls instead of the panel.
          Panels float over the canvas's right edge so opening one doesn't shrink it. */}
      <div
        className={`relative ${bare ? "flex-1 min-h-0" : "mt-3"}`}
        style={
          bare
            ? undefined
            : {
                height: Math.max(
                  440,
                  Math.min(
                    620,
                    typeof window !== "undefined"
                      ? window.innerHeight - 300
                      : 500,
                  ),
                ),
              }
        }
      >
        <FlowCanvas
          refitKey={0}
          workflowJson={workflowJson}
          workflowIr={workflowIr}
          editable={canEditIr}
          movable={irBacked && !canEditIr}
          staticEntrance
          fill
          transparent
          onNodeClick={canEditIr ? handleNodeClick : undefined}
          onCanvasClick={handleCanvasClick}
          onNodeMoved={updateNodePosition}
          onConnectNodes={addWorkflowConnection}
          onDeleteNodes={handleDeleteNodes}
          onDeleteEdges={handleDeleteEdges}
          onSelectionChange={handleSelectionChange}
          selectNodeIds={pasteSelection.ids}
          selectNonce={pasteSelection.nonce}
        />
        {(irActiveSelection || (catalogOpen && canEditIr)) && (
          <div className="absolute top-0 right-0 h-full flex z-20">
            {irActiveSelection ? (
              <IrNodeInspector
                key={irActiveSelection}
                nodeId={irActiveSelection}
                onClose={() => setSelectedName(null)}
              />
            ) : catalogOpen && canEditIr ? (
              <NodeCatalogPanel
                onAdd={addIrNodeFromCatalog}
                onClose={() => setCatalogOpen(false)}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
