import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import { useToasts } from "@/lib/toast";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  deployWorkflow: vi.fn(),
}));

const deployWorkflow = vi.mocked(api.deployWorkflow);

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
