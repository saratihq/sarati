import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToasts } from "@/lib/toast";

const AUTO_DISMISS_MS = 5_000;
const toasts = () => useToasts.getState().toasts;

beforeEach(() => {
  vi.useFakeTimers();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toast: auto-dismiss", () => {
  it.each(["success", "info"] as const)("dismisses a %s toast on its own", (kind) => {
    toast[kind]("Saved");
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(toasts()).toEqual([]);
  });

  it.each(["error", "warning"] as const)("keeps a %s toast until the user closes it", (kind) => {
    toast[kind]("Something broke");
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 10);
    expect(toasts()).toHaveLength(1);

    useToasts.getState().dismiss(toasts()[0].id);
    expect(toasts()).toEqual([]);
  });

  it("carries the title and description through", () => {
    toast.error("Publish failed", "The branch head moved.");
    expect(toasts()[0]).toMatchObject({ kind: "error", title: "Publish failed", description: "The branch head moved." });
  });

  it("stacks several toasts under distinct ids", () => {
    toast.info("One");
    toast.info("Two");
    expect(new Set(toasts().map((t) => t.id)).size).toBe(2);
  });

  it("dismisses only the named toast", () => {
    toast.error("One");
    toast.error("Two");
    useToasts.getState().dismiss(toasts()[0].id);
    expect(toasts().map((t) => t.title)).toEqual(["Two"]);
  });

  it("ignores a dismiss for a toast that is already gone", () => {
    toast.error("One");
    const { id } = toasts()[0];
    useToasts.getState().dismiss(id);
    expect(() => useToasts.getState().dismiss(id)).not.toThrow();
  });
});

/** The undo window's contract: EXACTLY one of onCommit / onUndo runs, exactly once. */
describe("toast.undoable", () => {
  const handlers = () => ({ onCommit: vi.fn(), onUndo: vi.fn() });

  it("commits when the window closes untouched", () => {
    const h = handlers();
    toast.undoable("Step deleted", undefined, h);
    expect(h.onCommit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onUndo).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it("undoes instead of committing when the action is clicked", () => {
    const h = handlers();
    toast.undoable("Step deleted", undefined, h);
    toasts()[0].action?.onClick();

    expect(h.onUndo).toHaveBeenCalledTimes(1);
    expect(h.onCommit).not.toHaveBeenCalled();

    // The pending timer must not resurrect the commit after the undo.
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 2);
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it("commits immediately when the user closes the toast early", () => {
    const h = handlers();
    toast.undoable("Step deleted", undefined, h);
    useToasts.getState().dismiss(toasts()[0].id);

    expect(h.onCommit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 2);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
  });

  it("offers an Undo action, since a silent destructive commit is not acceptable", () => {
    toast.undoable("Step deleted", "Removed “Send email”.", handlers());
    expect(toasts()[0].action?.label).toBe("Undo");
    expect(toasts()[0].description).toBe("Removed “Send email”.");
  });

  it("keeps two undo windows independent", () => {
    const first = handlers();
    const second = handlers();
    toast.undoable("First", undefined, first);
    toast.undoable("Second", undefined, second);

    toasts().find((t) => t.title === "First")?.action?.onClick();
    vi.advanceTimersByTime(AUTO_DISMISS_MS);

    expect(first.onUndo).toHaveBeenCalledTimes(1);
    expect(first.onCommit).not.toHaveBeenCalled();
    expect(second.onCommit).toHaveBeenCalledTimes(1);
    expect(second.onUndo).not.toHaveBeenCalled();
  });
});
