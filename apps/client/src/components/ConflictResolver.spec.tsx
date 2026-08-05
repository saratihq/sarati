import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConflictInfo, MergeResultResponse } from "@/api/client";
import ConflictResolver from "@/components/ConflictResolver";

const fieldConflict = (over: Partial<ConflictInfo> = {}): ConflictInfo =>
  ({
    node_id: "code",
    node_name: "Code",
    kind: "field",
    field_path: "parameters.code",
    deleted_on: null,
    source_value: "theirs",
    target_value: "ours",
    ancestor_value: "original",
    ...over,
  }) as ConflictInfo;

const merged: MergeResultResponse = { status: "merged", merged_version_id: "v9" } as MergeResultResponse;

function setup(conflicts: ConflictInfo[], onResolve = vi.fn().mockResolvedValue(merged)) {
  const onMerged = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConflictResolver
      conflicts={conflicts}
      sourceBranch="lane"
      targetBranch="main"
      onResolve={onResolve}
      onMerged={onMerged}
      onCancel={onCancel}
    />,
  );
  return { onResolve, onMerged, onCancel };
}

const completeButton = () => screen.getByRole("button", { name: /Complete merge/ });

describe("ConflictResolver", () => {
  it("states nothing has merged yet and blocks completing until every conflict is decided", async () => {
    setup([fieldConflict(), fieldConflict({ node_id: "http", node_name: "HTTP", field_path: "parameters.url" })]);
    expect(screen.getByText(/Nothing has merged yet/)).toBeInTheDocument();
    expect(screen.getByText("0 of 2 resolved")).toBeInTheDocument();
    expect(completeButton()).toBeDisabled();
    expect(completeButton()).toHaveAttribute("title", "Choose how to resolve every conflict first");

    await userEvent.click(screen.getAllByRole("radio", { name: /Use theirs/ })[0]);
    expect(screen.getByText("1 of 2 resolved")).toBeInTheDocument();
    expect(completeButton()).toBeDisabled();

    await userEvent.click(screen.getAllByRole("radio", { name: /Use current/ })[1]);
    expect(screen.getByText("2 of 2 resolved")).toBeInTheDocument();
    expect(completeButton()).toBeEnabled();
  });

  it("sends one resolution per conflict, keyed by node and field", async () => {
    const { onResolve, onMerged } = setup([fieldConflict()]);
    await userEvent.click(screen.getByRole("radio", { name: /Use theirs/ }));
    await userEvent.click(completeButton());

    expect(onResolve).toHaveBeenCalledWith([
      { node_id: "code", field_path: "parameters.code", choice: "source" },
    ]);
    expect(onMerged).toHaveBeenCalledWith("v9");
  });

  it("keeps a custom value's type by round-tripping it through JSON", async () => {
    const { onResolve } = setup([fieldConflict()]);
    await userEvent.click(screen.getByRole("radio", { name: /Edit/ }));
    const box = screen.getByRole("textbox", { name: "Custom value (JSON)" });
    await userEvent.clear(box);
    await userEvent.type(box, "{{ \"retries\": 3 }");
    await userEvent.click(completeButton());

    expect(onResolve).toHaveBeenCalledWith([
      { node_id: "code", field_path: "parameters.code", choice: "custom", value: { retries: 3 } },
    ]);
  });

  it("refuses to complete while a custom value is not valid JSON", async () => {
    setup([fieldConflict()]);
    await userEvent.click(screen.getByRole("radio", { name: /Edit/ }));
    const box = screen.getByRole("textbox", { name: "Custom value (JSON)" });
    await userEvent.clear(box);
    await userEvent.type(box, "hello");

    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Not valid JSON/)).toBeInTheDocument();
    expect(screen.getByText("0 of 1 resolved")).toBeInTheDocument();
    expect(completeButton()).toBeDisabled();
  });

  it("names which branch edited and which deleted, from deleted_on", () => {
    setup([
      fieldConflict({ kind: "edit_delete", field_path: null, deleted_on: "source", ancestor_value: undefined }),
    ]);
    expect(screen.getByText(/was edited on/)).toHaveTextContent("was edited on main and deleted on lane");
    expect(screen.getByRole("radio", { name: /Keep the edited node/ })).toBeInTheDocument();
  });

  it("does not report a merge when the server still returns conflicts", async () => {
    const stillConflicting = vi.fn().mockResolvedValue({ status: "conflicts", conflicts: [] } as MergeResultResponse);
    const { onMerged } = setup([fieldConflict()], stillConflicting);
    await userEvent.click(screen.getByRole("radio", { name: /Use theirs/ }));
    await userEvent.click(completeButton());

    expect(onMerged).not.toHaveBeenCalled();
    expect(screen.getByText(/still reports conflicts/)).toBeInTheDocument();
  });

  it("attributes a rejection that names a node to that node's card", async () => {
    const rejects = vi.fn().mockRejectedValue(new Error("Code cannot take a custom value"));
    setup([fieldConflict()], rejects);
    await userEvent.click(screen.getByRole("radio", { name: /Use theirs/ }));
    await userEvent.click(completeButton());

    expect(await screen.findByText("Code cannot take a custom value")).toBeInTheDocument();
  });

  it("escape cancels without merging", async () => {
    const { onCancel, onResolve } = setup([fieldConflict()]);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });
});
