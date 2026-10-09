import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "@/api/agent";
import ComposerBar from "@/components/ComposerBar";
import { refreshComposerAvailability } from "@/lib/useComposerAvailable";
import { useComposer } from "@/store/useComposer";
import { useOrgs } from "@/store/useOrgs";

vi.mock("@/api/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  composerStatus: vi.fn(),
  composerAttach: vi.fn(),
  refreshSessionToken: vi.fn(),
}));

const composerStatus = vi.mocked(agent.composerStatus);
const composerAttach = vi.mocked(agent.composerAttach);

beforeEach(() => {
  refreshComposerAvailability();
  useComposer.getState().reset();
  composerAttach.mockImplementation(async function* () {});
});

describe("ComposerBar reattach", () => {
  it("never asks an instance without the composer for a thread", async () => {
    composerStatus.mockResolvedValue({ available: false, reason: "anthropic_api_key_missing" });
    render(<ComposerBar workflowId="wf-1" />);

    await waitFor(() => expect(composerStatus).toHaveBeenCalledTimes(1));
    await composerStatus.mock.results[0]!.value;
    expect(composerAttach).not.toHaveBeenCalled();
    expect(useComposer.getState().failure).toBeNull();
  });

  it("reattaches to the workflow's thread once the probe says the composer is here", async () => {
    composerStatus.mockResolvedValue({ available: true });
    render(<ComposerBar workflowId="wf-1" />);

    await waitFor(() => expect(composerAttach).toHaveBeenCalledTimes(1));
    expect(composerAttach.mock.calls[0]![0]).toMatchObject({ workflowId: "wf-1", scratch: false });
  });
});

describe("ComposerBar save offer", () => {
  const offerFor = async (role: "member" | "owner"): Promise<string> => {
    composerStatus.mockResolvedValue({ available: true });
    useOrgs.setState({ orgs: [{ id: "o1", name: "Team", is_personal: false, role }], activeOrgId: "o1" });
    useComposer.setState({ offerPending: true });
    render(<ComposerBar />);
    return (await screen.findByTestId("offer-save-live")).textContent?.trim() ?? "";
  };

  it("offers to save and turn on a new workflow to someone who may publish", async () => {
    expect(await offerFor("owner")).toBe("Save and turn on");
  });

  it("offers only to save it to a member, whose new workflow an owner or admin turns on", async () => {
    expect(await offerFor("member")).toBe("Save");
  });
});

describe("ComposerBar on a canvas that can't be saved", () => {
  it("holds the save chip and says why, as the editor's own Save does", async () => {
    composerStatus.mockResolvedValue({ available: true });
    useComposer.setState({ offerPending: true });
    render(<ComposerBar workflowId="wf-1" saveBlocked="main is protected — changes come in through a review" />);

    expect(await screen.findByTestId("offer-save-live")).toBeDisabled();
    expect(screen.getByText("main is protected — changes come in through a review")).toBeInTheDocument();
    expect(screen.getByTestId("offer-tweak")).toBeEnabled();
  });
});
