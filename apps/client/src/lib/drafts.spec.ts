import { afterEach, describe, expect, it } from "vitest";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts";
import type { WorkflowDraft } from "@/lib/drafts";

const draft = (name = "My flow"): WorkflowDraft => ({
  ir: { nodes: [{ id: "n1" }], edges: [] },
  name,
  savedAt: "2026-03-10T12:00:00.000Z",
});

const realStorage = window.localStorage;

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: realStorage });
});

describe("drafts: per-user keying", () => {
  it("round-trips a draft for one user and workflow", () => {
    saveDraft("user_1", "wf_1", draft());
    expect(loadDraft("user_1", "wf_1")).toEqual(draft());
  });

  it("keeps the build-from-scratch draft separate from a workflow's", () => {
    saveDraft("user_1", null, draft("Scratch"));
    saveDraft("user_1", "wf_1", draft("Workflow"));
    expect(loadDraft("user_1", null)?.name).toBe("Scratch");
    expect(loadDraft("user_1", "wf_1")?.name).toBe("Workflow");
  });

  it("never lets one account read another's draft on a shared browser", () => {
    saveDraft("user_1", "wf_1", draft("Mine"));
    expect(loadDraft("user_2", "wf_1")).toBeNull();
  });

  it("stores under the persisted key namespace", () => {
    saveDraft("user_1", "wf_1", draft());
    expect(window.localStorage.getItem("orchestr:draft:user_1:wf_1")).toBeTruthy();
    saveDraft("user_1", null, draft());
    expect(window.localStorage.getItem("orchestr:draft:user_1:scratch")).toBeTruthy();
  });

  it("clears one draft without touching the others", () => {
    saveDraft("user_1", "wf_1", draft());
    saveDraft("user_1", "wf_2", draft());
    clearDraft("user_1", "wf_1");
    expect(loadDraft("user_1", "wf_1")).toBeNull();
    expect(loadDraft("user_1", "wf_2")).not.toBeNull();
  });
});

describe("drafts: no user", () => {
  it.each([null, undefined, ""])("is a no-op for the signed-out id %s", (userId) => {
    expect(() => saveDraft(userId, "wf_1", draft())).not.toThrow();
    expect(loadDraft(userId, "wf_1")).toBeNull();
    expect(() => clearDraft(userId, "wf_1")).not.toThrow();
  });
});

describe("drafts: hostile storage", () => {
  it("reads a hand-edited or stale-schema entry as NO draft", () => {
    const key = "orchestr:draft:user_1:wf_1";
    for (const raw of ["not json", "null", '"a string"', "{}", '{"ir":null,"savedAt":"x"}', '{"ir":{},"savedAt":1}']) {
      window.localStorage.setItem(key, raw);
      expect(loadDraft("user_1", "wf_1"), `for ${raw}`).toBeNull();
    }
  });

  it("repairs a missing name instead of surfacing undefined in the UI", () => {
    window.localStorage.setItem(
      "orchestr:draft:user_1:wf_1",
      JSON.stringify({ ir: { nodes: [] }, savedAt: "2026-03-10T12:00:00.000Z" }),
    );
    expect(loadDraft("user_1", "wf_1")).toEqual({ ir: { nodes: [] }, name: "", savedAt: "2026-03-10T12:00:00.000Z" });
  });

  it("no-ops when the browser blocks storage entirely (private mode)", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(() => saveDraft("user_1", "wf_1", draft())).not.toThrow();
    expect(loadDraft("user_1", "wf_1")).toBeNull();
    expect(() => clearDraft("user_1", "wf_1")).not.toThrow();
  });

  it("swallows a quota failure — a lost autosave must never break the editor", () => {
    const quotaExceeded = {
      ...window.localStorage,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    } as unknown as Storage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: quotaExceeded });
    expect(() => saveDraft("user_1", "wf_1", draft())).not.toThrow();
  });
});
