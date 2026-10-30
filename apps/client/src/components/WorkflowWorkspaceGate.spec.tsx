import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import WorkflowWorkspaceGate from "@/components/WorkflowWorkspaceGate";
import { toast } from "@/lib/toast";
import { useOrgs } from "@/store/useOrgs";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listOrgs: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

const P: api.OrgSummary = { id: "org-p", name: "Huzefa", is_personal: true, role: "owner" };
const A: api.OrgSummary = { id: "org-a", name: "Acme", is_personal: false, role: "owner" };
const B: api.OrgSummary = { id: "org-b", name: "Beta", is_personal: false, role: "member" };

const listOrgs = vi.mocked(api.listOrgs);
const getWorkflow = vi.mocked(api.getWorkflow);
const realLocation = window.location;
const reload = vi.fn();
const assign = vi.fn();

function workflowIn(orgId: string | null) {
  getWorkflow.mockResolvedValue({ id: "wf", org_id: orgId } as api.WorkflowDetailResponse);
}

function reloadAs(stored: string | null) {
  cleanup();
  api.setActiveOrgId(stored);
  useOrgs.setState({ orgs: [], loaded: false, activeOrgId: stored });
}

function open(workflowId = "wf-b") {
  return render(
    <WorkflowWorkspaceGate workflowId={workflowId}>
      <p>Workflow page</p>
    </WorkflowWorkspaceGate>,
  );
}

function openStrict(workflowId = "wf-b") {
  return render(
    <StrictMode>
      <WorkflowWorkspaceGate workflowId={workflowId}>
        <p>Workflow page</p>
      </WorkflowWorkspaceGate>
    </StrictMode>,
  );
}

const saved = () => window.localStorage.getItem("orchestr:active-org");
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: { reload, assign } });
  listOrgs.mockReset().mockResolvedValue({ orgs: [P, A, B] });
  getWorkflow.mockReset();
  reloadAs("org-a");
});

afterEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: realLocation });
  api.setActiveOrgId(null);
});

describe("WorkflowWorkspaceGate: the workflow is in the active workspace", () => {
  it("keeps the page behind a loader until it knows the workflow's workspace", async () => {
    const wf = Promise.withResolvers<api.WorkflowDetailResponse>();
    getWorkflow.mockReturnValue(wf.promise);
    open("wf-a");

    expect(screen.getByRole("status", { name: "Opening workflow" })).toBeInTheDocument();
    await waitFor(() => expect(getWorkflow).toHaveBeenCalledWith("wf-a"));
    expect(screen.queryByText("Workflow page")).not.toBeInTheDocument();

    wf.resolve({ id: "wf-a", org_id: "org-a" } as api.WorkflowDetailResponse);
    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Opening workflow" })).not.toBeInTheDocument();
  });

  it("opens a workflow of the workspace already active in place: no reload, no notice", async () => {
    workflowIn("org-a");
    open("wf-a");

    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("counts the personal workspace, stored as no selection, as active", async () => {
    reloadAs(null);
    workflowIn("org-p");
    open("wf-p");

    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("WorkflowWorkspaceGate: the workflow is in another of your workspaces", () => {
  it("switches to the workflow's workspace by reloading the same address", async () => {
    workflowIn("org-b");
    open();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(saved()).toBe("org-b");
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Opening workflow" })).toBeInTheDocument();
    expect(screen.queryByText("Workflow page")).not.toBeInTheDocument();
  });

  it("switches to the personal workspace by clearing the selection", async () => {
    workflowIn("org-p");
    open("wf-p");

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(saved()).toBeNull();
  });

  it("after the reload, says which workspace it switched to, once", async () => {
    workflowIn("org-b");
    open();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    reloadAs("org-b");
    open();
    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith("Switched to Beta");

    reloadAs("org-b");
    open();
    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("calls the personal workspace Personal in the notice", async () => {
    reloadAs("org-b");
    workflowIn("org-p");
    open("wf-p");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    reloadAs(null);
    open("wf-p");
    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith("Switched to Personal");
  });

  it("drops a notice left for another workflow", async () => {
    workflowIn("org-b");
    open("wf-b");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    reloadAs("org-b");
    open("wf-b2");
    expect(await screen.findByText("Workflow page")).toBeInTheDocument();

    reloadAs("org-b");
    open("wf-b");
    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("reloads only once when the switch did not take, and offers to try again", async () => {
    workflowIn("org-b");
    open();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    reloadAs("org-a");
    open();
    expect(await screen.findByRole("heading", { name: "Couldn't switch to Beta" })).toBeInTheDocument();
    expect(screen.getByText("This workflow belongs to that workspace.")).toBeInTheDocument();
    expect(screen.queryByText("Workflow page")).not.toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("stays put, in one workspace, when saving the switch fails, and lets Try again switch for real", async () => {
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "orchestr:active-org") throw new Error("The quota has been exceeded.");
      setItem(key, value);
    });
    workflowIn("org-b");
    open();

    expect(await screen.findByRole("heading", { name: "Couldn't switch to Beta" })).toBeInTheDocument();
    expect(screen.queryByText("Workflow page")).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(saved()).toBe("org-a");
    expect(api.getActiveOrgId()).toBe("org-a");
    expect(window.sessionStorage.getItem("sarati:workspace-switch")).toBeNull();
  });

  it("does not reload when it can't leave itself a note", async () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("The quota has been exceeded.");
    });
    workflowIn("org-b");
    open();

    expect(await screen.findByRole("heading", { name: "Couldn't switch to Beta" })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(saved()).toBe("org-a");
  });
});

describe("WorkflowWorkspaceGate: nothing to switch to", () => {
  it("leaves a workflow it can't read to the page's own not-found handling", async () => {
    getWorkflow.mockRejectedValue(new api.ApiError("Workflow not found", 404));
    open();

    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(saved()).toBe("org-a");
  });

  it("opens a workflow made before workspaces in the active workspace", async () => {
    workflowIn(null);
    open("wf-old");

    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(saved()).toBe("org-a");
  });

  it("fetches the list once more for a workspace it doesn't show yet, then switches", async () => {
    listOrgs.mockResolvedValueOnce({ orgs: [P, A] }).mockResolvedValueOnce({ orgs: [P, A, B] });
    workflowIn("org-b");
    open();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(saved()).toBe("org-b");
  });

  it("never switches to a workspace missing from the list", async () => {
    listOrgs.mockResolvedValue({ orgs: [P, A] });
    workflowIn("org-c");
    open();

    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    expect(saved()).toBe("org-a");
  });

  it("opens the page as before when the workspace list can't load", async () => {
    listOrgs.mockRejectedValue(new api.ApiError("Internal server error", 500));
    workflowIn("org-b");
    open();

    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(getWorkflow).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("heals a stale selection before asking for the workflow", async () => {
    reloadAs("org-gone");
    listOrgs
      .mockRejectedValueOnce(new api.ApiError("Not a member of this organization", 403))
      .mockResolvedValueOnce({ orgs: [P, A, B] });
    workflowIn("org-p");
    open("wf-p");

    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(getWorkflow.mock.invocationCallOrder[0]).toBeGreaterThan(listOrgs.mock.invocationCallOrder[1]);
    expect(saved()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("WorkflowWorkspaceGate: React's development double run", () => {
  it("still says which workspace it switched to", async () => {
    workflowIn("org-b");
    openStrict();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    reloadAs("org-b");
    openStrict();
    expect(await screen.findByText("Workflow page")).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("Switched to Beta");
  });

  it("still reloads only once when the switch did not take", async () => {
    workflowIn("org-b");
    openStrict();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    reloadAs("org-a");
    openStrict();
    expect(await screen.findByRole("heading", { name: "Couldn't switch to Beta" })).toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("WorkflowWorkspaceGate: the workflow changes while it decides", () => {
  it("ignores the answer for a workflow it has already left", async () => {
    const left = Promise.withResolvers<api.WorkflowDetailResponse>();
    getWorkflow.mockReturnValueOnce(left.promise);
    open();
    await waitFor(() => expect(getWorkflow).toHaveBeenCalled());
    cleanup();
    left.resolve({ id: "wf-b", org_id: "org-b" } as api.WorkflowDetailResponse);
    await settle();
    expect(reload).not.toHaveBeenCalled();

    workflowIn("org-b");
    open();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    reloadAs("org-b");
    const leftAgain = Promise.withResolvers<api.WorkflowDetailResponse>();
    getWorkflow.mockReturnValueOnce(leftAgain.promise);
    open();
    await waitFor(() => expect(getWorkflow).toHaveBeenCalledTimes(3));
    cleanup();
    leftAgain.resolve({ id: "wf-b", org_id: "org-b" } as api.WorkflowDetailResponse);
    await settle();
    expect(toast.info).not.toHaveBeenCalled();

    reloadAs("org-a");
    workflowIn("org-b");
    open();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "Couldn't switch to Beta" })).not.toBeInTheDocument();
  });

  it("checks again when the workflow changes under the same gate", async () => {
    getWorkflow.mockImplementation(
      async (id) => ({ id, org_id: id === "wf-a" ? "org-a" : "org-b" }) as api.WorkflowDetailResponse,
    );
    const { rerender } = open("wf-a");
    expect(await screen.findByText("Workflow page")).toBeInTheDocument();

    rerender(
      <WorkflowWorkspaceGate workflowId="wf-b">
        <p>Workflow page</p>
      </WorkflowWorkspaceGate>,
    );
    expect(screen.queryByText("Workflow page")).not.toBeInTheDocument();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(saved()).toBe("org-b");
  });
});
