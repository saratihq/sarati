"use client";

import { useEffect } from "react";
import { useWorkflow } from "@/store/useWorkflow";

/** True when focus sits in a text field, so a canvas shortcut yields to it. */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable || el.closest('[contenteditable="true"]') !== null;
}

/**
 * Canvas undo/redo (Cmd/Ctrl+Z, +Shift+Z or +Y to redo) plus the toolbar's history state. Ignored
 * while focus is in a field, so native field-level undo keeps working; `enabled: false` unbinds it.
 */
export function useCanvasHistory(enabled = true): {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
} {
  const undo = useWorkflow((s) => s.undo);
  const redo = useWorkflow((s) => s.redo);
  const canUndo = useWorkflow((s) => s.history.past.length > 0);
  const canRedo = useWorkflow((s) => s.history.future.length > 0);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      // Typing in a field: let the browser's native field undo win.
      if (isEditableTarget(e.target)) return;
      if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      } else {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, undo, redo]);

  return { undo, redo, canUndo, canRedo };
}
