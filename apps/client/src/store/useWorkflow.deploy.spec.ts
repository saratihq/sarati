import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import { useToasts } from "@/lib/toast";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  deployWorkflow: vi.fn(),
  commitVersion: vi.fn(),
}));

const deployWorkflow = vi.mocked(api.deployWorkflow);
const commitVersion = vi.mocked(api.commitVersion);

const result = (over: Partial<api.DeployResult> = {}): api.DeployResult => ({
  workflow_id: "wf-1",
  workflow_url: "",
  name: "Blog watcher",
  version_number: 1,
  activated: true,
  activation_error: null,
  ...over,
});

const warnings = () => useToasts.getState().toasts.filter((t) => t.kind === "warning");

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  useWorkflow.setState({ workflowJson: { nodes: [], edges: [] }, workflowId: null });
});

describe("deploy: the activation the service reports", () => {
  it("warns, and says why, when the trigger did not come up", async () => {
    deployWorkflow.mockResolvedValue(
      result({ activated: false, activation_error: "TypeError: fetch failed" }),
    );
    await useWorkflow.getState().deploy();

    expect(warnings()).toMatchObject([
      { title: "Created, but the trigger is not live yet", description: "TypeError: fetch failed" },
    ]);
  });

  it("still warns when the service gives no reason", async () => {
    deployWorkflow.mockResolvedValue(result({ activated: false, activation_error: null }));
    await useWorkflow.getState().deploy();

    expect(warnings()).toMatchObject([{ description: undefined }]);
  });

  it("stays quiet when the trigger is live", async () => {
    deployWorkflow.mockResolvedValue(result());
    await useWorkflow.getState().deploy();

    expect(warnings()).toEqual([]);
  });

  it("stays quiet for a service that does not report activation at all", async () => {
    deployWorkflow.mockResolvedValue(result({ activated: undefined, activation_error: undefined }));
    await useWorkflow.getState().deploy();

    expect(warnings()).toEqual([]);
  });
});

describe("deploy: what the service flagged about the document it saved", () => {
  const unchecked = {
    code: "trigger_type_unverified",
    message: 'Node "start" is this workflow\'s trigger, "gmail.new_mail", an app trigger only Composio can fire, and this workspace has no Composio key.',
    node_id: "start",
  };

  it("says what it flagged, and how many more", async () => {
    deployWorkflow.mockResolvedValue(result({ warnings: [unchecked] }));
    await useWorkflow.getState().deploy();
    expect(warnings()).toMatchObject([{ title: "Saved, with a warning", description: unchecked.message }]);

    useToasts.setState({ toasts: [] });
    deployWorkflow.mockResolvedValue(result({ warnings: [unchecked, { ...unchecked, node_id: "other" }] }));
    await useWorkflow.getState().deploy();
    expect(warnings()).toMatchObject([{ description: `${unchecked.message} (+1 more)` }]);
  });

  it("stays quiet when it flagged nothing", async () => {
    deployWorkflow.mockResolvedValue(result({ warnings: [] }));
    await useWorkflow.getState().deploy();
    expect(warnings()).toEqual([]);
  });

  it("says what it flagged on a save of an edit, too", async () => {
    useWorkflow.setState({
      workflowId: "wf-1",
      workflowJson: { nodes: [{ id: "start" }], edges: [] },
      lastGeneratedJson: { nodes: [], edges: [] },
      editBranch: "lane",
      baseVersionId: "v1",
    });
    commitVersion.mockResolvedValue({
      id: "v2",
      version_number: 2,
      warnings: [unchecked],
    } as Awaited<ReturnType<typeof api.commitVersion>>);

    expect(await useWorkflow.getState().saveDeployedEdits()).toMatchObject({ kind: "committed" });
    expect(warnings()).toMatchObject([{ title: "Saved, with a warning", description: unchecked.message }]);
  });
});

describe("deploy: a member's new workflow is saved, not live", () => {
  it("says it is saved for an owner or admin to turn on, and does not warn about the trigger", async () => {
    deployWorkflow.mockResolvedValue(result({ is_live: false, activated: false, activation_error: null }));
    await useWorkflow.getState().deploy();

    const toasts = useToasts.getState().toasts;
    expect(toasts).toMatchObject([
      { kind: "success", title: "Saved on Sarati", description: '"Blog watcher" v1 is saved on main — an owner or admin turns it on' },
    ]);
    expect(useWorkflow.getState().createdLive).toBe(false);
  });

  it("records a live create as live", async () => {
    deployWorkflow.mockResolvedValue(result({ is_live: true }));
    await useWorkflow.getState().deploy();

    expect(useWorkflow.getState().createdLive).toBe(true);
    expect(useToasts.getState().toasts[0]).toMatchObject({ title: "Created on Sarati" });
  });
});
