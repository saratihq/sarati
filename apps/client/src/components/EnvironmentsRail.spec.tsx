import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import EnvironmentsRail from "@/components/EnvironmentsRail";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listVersions: vi.fn(),
}));

const listVersions = vi.mocked(api.listVersions);

const v1: api.WorkflowVersionSummary = { id: "v1", version_number: 1, workflow_json: { nodes: [] } };

beforeEach(() => {
  listVersions.mockReset();
});

describe("EnvironmentsRail", () => {
  it("says a never-published workflow is not live, and offers to publish it", async () => {
    listVersions.mockResolvedValue({ workflow_id: "wf", active_version_id: null, env_pointers: [], versions: [v1] });
    const onRequestPublish = vi.fn();
    render(<EnvironmentsRail workflowId="wf" refreshKey={0} onRequestPublish={onRequestPublish} />);

    expect(await screen.findByText("Not live yet")).toBeInTheDocument();
    expect(screen.queryByText("Live on Sarati")).not.toBeInTheDocument();
    expect(screen.getByText("latest: v1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Publish/ }));
    expect(onRequestPublish).toHaveBeenCalledTimes(1);
  });

  it("names the live version when production runs main's head", async () => {
    listVersions.mockResolvedValue({ workflow_id: "wf", active_version_id: "v1", env_pointers: [], versions: [v1] });
    render(<EnvironmentsRail workflowId="wf" refreshKey={0} onRequestPublish={vi.fn()} />);

    expect(await screen.findByText("Live on Sarati")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish/ })).not.toBeInTheDocument();
  });

  it("claims neither live nor not-live when the versions can't be loaded", async () => {
    listVersions.mockRejectedValue(new Error("offline"));
    render(<EnvironmentsRail workflowId="wf" refreshKey={0} />);

    expect(await screen.findByText(/Couldn't load what runs/)).toBeInTheDocument();
    expect(screen.queryByText("Live on Sarati")).not.toBeInTheDocument();
    expect(screen.queryByText("Not live yet")).not.toBeInTheDocument();
  });
});
