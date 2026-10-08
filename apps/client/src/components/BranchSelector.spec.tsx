import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import BranchSelector from "@/components/BranchSelector";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  setBranchProtection: vi.fn(),
}));

const listBranches = vi.mocked(api.listBranches);
const createBranch = vi.mocked(api.createBranch);
const setBranchProtection = vi.mocked(api.setBranchProtection);

const branch = (name: string, over: Partial<api.BranchSummary> = {}): api.BranchSummary => ({
  id: `b-${name}`,
  name,
  is_default: false,
  is_protected: false,
  ...over,
});

beforeEach(() => {
  listBranches.mockResolvedValue({ workflow_id: "wf-1", branches: [branch("main", { is_default: true })] });
});

describe("BranchSelector", () => {
  it("switches to a branch it just created and closes, the way picking one does", async () => {
    createBranch.mockResolvedValue(branch("fewer-stories"));
    const onBranchChange = vi.fn();
    const user = userEvent.setup();
    render(<BranchSelector workflowId="wf-1" currentBranch="main" onBranchChange={onBranchChange} />);

    await user.click(screen.getByRole("button", { name: /main/ }));
    await user.click(screen.getByRole("button", { name: "New branch" }));
    await user.type(screen.getByPlaceholderText("branch-name"), "fewer-stories{Enter}");

    await waitFor(() => expect(onBranchChange).toHaveBeenCalledWith("fewer-stories"));
    expect(createBranch).toHaveBeenCalledWith("wf-1", "fewer-stories");
    expect(screen.queryByPlaceholderText("branch-name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New branch" })).not.toBeInTheDocument();
  });

  it("tells the page its branches changed once protecting one succeeds, so open reviews re-read the merge gate", async () => {
    setBranchProtection.mockResolvedValue(branch("main", { is_default: true, is_protected: true }));
    const onBranchesChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <BranchSelector
        workflowId="wf-1"
        currentBranch="main"
        onBranchChange={vi.fn()}
        onBranchesChanged={onBranchesChanged}
      />,
    );

    await user.click(screen.getByRole("button", { name: /main/ }));
    await user.click(screen.getByRole("button", { name: "Protect main" }));

    await waitFor(() => expect(onBranchesChanged).toHaveBeenCalledTimes(1));
    expect(setBranchProtection).toHaveBeenCalledWith("wf-1", "main", true);
  });

  it("says what deleting a branch removes and what keeps running before it asks", async () => {
    listBranches.mockResolvedValue({
      workflow_id: "wf-1",
      branches: [branch("main", { is_default: true }), branch("lane")],
    });
    const user = userEvent.setup();
    render(<BranchSelector workflowId="wf-1" currentBranch="main" onBranchChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /main/ }));
    const trash = await screen.findByRole("button", { name: "Delete lane" });
    expect(trash).toHaveAttribute("title", expect.stringContaining("its versions keep running"));
    await user.click(trash);

    const confirm = await screen.findByRole("dialog");
    expect(confirm).toHaveTextContent("every review into or out of it");
    expect(confirm).toHaveTextContent("an environment running one keeps running it");
    expect(confirm).not.toHaveTextContent("tears down");
  });

  it("stays open with the reason when the branch cannot be created", async () => {
    createBranch.mockRejectedValue(new Error('A branch named "main" already exists'));
    const onBranchChange = vi.fn();
    const user = userEvent.setup();
    render(<BranchSelector workflowId="wf-1" currentBranch="main" onBranchChange={onBranchChange} />);

    await user.click(screen.getByRole("button", { name: /main/ }));
    await user.click(screen.getByRole("button", { name: "New branch" }));
    await user.type(screen.getByPlaceholderText("branch-name"), "main{Enter}");

    expect(await screen.findByText('A branch named "main" already exists')).toBeInTheDocument();
    expect(onBranchChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("branch-name")).toBeInTheDocument();
  });
});
