"use client";

import { create } from "zustand";

// App-wide feedback store, rendered by <Toaster />. Success/info auto-dismiss; errors stick until closed.

const AUTO_DISMISS_MS = 5000;

export type ToastKind = "success" | "error" | "info" | "warning";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Inline action button (e.g. Undo) rendered beside the text. */
  action?: { label: string; onClick: () => void };
  /** Fires exactly once, when the toast leaves the stack (timeout or ✕). */
  onDismiss?: () => void;
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, title: string, description?: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, title, description) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, title, description }] }));
    if (kind !== "error" && kind !== "warning") {
      setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
    }
  },
  dismiss: (id) => {
    const item = get().toasts.find((t) => t.id === id);
    if (!item) return;
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    item.onDismiss?.();
  },
}));

export const toast = {
  success: (title: string, description?: string) => useToasts.getState().push("success", title, description),
  error: (title: string, description?: string) => useToasts.getState().push("error", title, description),
  info: (title: string, description?: string) => useToasts.getState().push("info", title, description),
  warning: (title: string, description?: string) => useToasts.getState().push("warning", title, description),
  /** Undo window: commits only when the toast leaves un-undone. Exactly one of onCommit/onUndo runs. */
  undoable: (title: string, description: string | undefined, handlers: { onCommit: () => void; onUndo: () => void }) => {
    const id = nextId++;
    let undone = false;
    const timer = setTimeout(() => useToasts.getState().dismiss(id), AUTO_DISMISS_MS);
    const item: ToastItem = {
      id,
      kind: "info",
      title,
      description,
      action: {
        label: "Undo",
        onClick: () => {
          undone = true; // before dismiss, so onDismiss skips the commit
          useToasts.getState().dismiss(id);
          handlers.onUndo();
        },
      },
      onDismiss: () => {
        clearTimeout(timer);
        if (!undone) handlers.onCommit();
      },
    };
    useToasts.setState((s) => ({ toasts: [...s.toasts, item] }));
  },
};