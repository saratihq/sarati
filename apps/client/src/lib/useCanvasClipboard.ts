"use client";

import { useEffect } from "react";
import { useWorkflow } from "@/store/useWorkflow";
import * as irGraph from "@/lib/irGraph";
import { isEditableTarget } from "@/lib/useCanvasHistory";

// Module-level so it survives re-renders and works across both editor hosts. Never touches the OS
// clipboard, so text copy/paste in fields is unaffected.
let canvasClipboard: {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
} | null = null;

/**
 * Cmd/Ctrl+C/V for canvas nodes; ignored while focus is in a text field or a text selection is live,
 * so copying text is never hijacked. `onPaste` receives the new node ids so the host can select them.
 */
export function useCanvasClipboard(
  enabled: boolean,
  selectedNodeIds: string[],
  onPaste: (newNodeIds: string[]) => void,
): void {
  const pasteNodes = useWorkflow((s) => s.pasteNodes);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "v") return;
      if (isEditableTarget(e.target)) return;

      if (key === "c") {
        if (selectedNodeIds.length === 0) return;
        // A live text selection means the user is copying text — defer to it.
        const textSelection = window.getSelection?.()?.toString() ?? "";
        if (textSelection.length > 0) return;
        const doc = useWorkflow.getState().workflowJson;
        if (!irGraph.isIrDocument(doc)) return;
        const picked = new Set(selectedNodeIds);
        const nodes = irGraph
          .getIrNodes(doc!)
          .filter((n) => picked.has(n.id));
        if (nodes.length === 0) return;
        const edges = irGraph
          .getIrEdges(doc!)
          .filter(
            (edge) =>
              picked.has(edge.source_node_id) && picked.has(edge.target_node_id),
          );
        e.preventDefault();
        canvasClipboard = { nodes, edges: edges };
        return;
      }

      if (!canvasClipboard) return;
      e.preventDefault();
      const newIds = pasteNodes(canvasClipboard.nodes, canvasClipboard.edges);
      if (newIds.length > 0) onPaste(newIds);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, selectedNodeIds, pasteNodes, onPaste]);
}
