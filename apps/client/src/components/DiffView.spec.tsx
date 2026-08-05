import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffEntry, DiffResponse } from "@/api/client";
import * as api from "@/api/client";
import DiffView from "@/components/DiffView";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getVersionDiff: vi.fn(),
}));

const getVersionDiff = vi.mocked(api.getVersionDiff);

const entry = (over: Partial<DiffEntry> = {}): DiffEntry =>
  ({
    operation: "modify_node",
    target_id: "code",
    target_name: "Code",
    path: "parameters.code",
    old_value: "before",
    new_value: "after",
    ...over,
  }) as DiffEntry;

const response = (over: Partial<DiffResponse> = {}): DiffResponse =>
  ({
    from_version: 1,
    to_version: 2,
    entries: [entry()],
    renames: [],
    ...over,
  }) as DiffResponse;

const renderDiff = (props: Partial<React.ComponentProps<typeof DiffView>> = {}) =>
  render(<DiffView workflowId="wf" fromVersion={1} toVersion={2} {...props} />);

beforeEach(() => {
  getVersionDiff.mockResolvedValue(response());
});

describe("DiffView", () => {
  it("renders a field-level change as its path with the old and new values", async () => {
    renderDiff();
    expect(await screen.findByText("parameters.code")).toBeInTheDocument();
    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
    expect(screen.getByText("modify node")).toBeInTheDocument();
  });

  it("says No changes rather than rendering an empty shell", async () => {
    getVersionDiff.mockResolvedValue(response({ entries: [] }));
    renderDiff();
    expect(await screen.findByText("No changes")).toBeInTheDocument();
  });

  it("surfaces a failed fetch instead of an endless loader", async () => {
    getVersionDiff.mockRejectedValue(new Error("Diff unavailable"));
    renderDiff();
    expect(await screen.findByText("Diff unavailable")).toBeInTheDocument();
  });

  it("renders a pure position change as a quiet moved line, never a coordinate blob", async () => {
    getVersionDiff.mockResolvedValue(
      response({
        entries: [entry({ path: "position", old_value: { x: 0 }, new_value: { x: 90 } })],
      }),
    );
    renderDiff();
    expect(await screen.findByText("moved Code")).toBeInTheDocument();
    expect(screen.queryByText(/90/)).not.toBeInTheDocument();
    expect(screen.getByText("1 change — v1 → v2")).toBeInTheDocument();
  });

  it("folds a move into the node's card when something else changed too", async () => {
    getVersionDiff.mockResolvedValue(
      response({ entries: [entry(), entry({ path: "position.x", old_value: 0, new_value: 90 })] }),
    );
    renderDiff();
    expect(await screen.findByText("parameters.code")).toBeInTheDocument();
    expect(screen.getByText("moved")).toBeInTheDocument();
    // The move rides along, so it does not inflate the count.
    expect(screen.getByText("1 change — v1 → v2")).toBeInTheDocument();
  });

  it("labels each side with the branch the server resolved, not the branch passed in", async () => {
    getVersionDiff.mockResolvedValue(response({ from_branch: "main", to_branch: "lane" }));
    renderDiff({ fromBranch: "ignored", toBranch: "lane" });
    expect(await screen.findByText("1 change — main v1 → lane v2")).toBeInTheDocument();
  });

  it("truncates a long value behind show full rather than losing its tail", async () => {
    const long = "x".repeat(120);
    getVersionDiff.mockResolvedValue(response({ entries: [entry({ new_value: long })] }));
    renderDiff();
    const toggle = await screen.findByRole("button", { name: "show full" });
    expect(screen.queryByText(long)).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(screen.getByText(long)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "show less" })).toBeInTheDocument();
  });
});
