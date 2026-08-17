import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "@/api/agent";
import { useComposer } from "@/store/useComposer";
import { UNTITLED_WORKFLOW, useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  composerAttach: vi.fn(),
  refreshSessionToken: vi.fn(),
}));

const composerAttach = vi.mocked(agent.composerAttach);

/** Replay a scripted event stream through the store's one reducer. */
function scripted(events: agent.SequencedComposerEvent[]) {
  return async function* () {
    for (const evt of events) yield evt;
  };
}

const brief = (over: Partial<agent.BriefData> = {}): agent.BriefData => ({
  name: "Hacker News mentions → Slack",
  goal: "Surface new Hacker News stories about workflow automation into Slack.",
  trigger: "Every hour",
  steps: ["Fetch top stories", "Post the matches"],
  needs: [],
  ...over,
});

beforeEach(() => {
  useComposer.getState().reset();
  composerAttach.mockReset();
});

describe("useComposer suggestedName", () => {
  it("takes the workflow name from the plan card the composer posted", async () => {
    composerAttach.mockImplementation(scripted([{ event: "brief", data: brief(), seq: 1 }]));
    await useComposer.getState().attach();
    expect(useComposer.getState().suggestedName).toBe("Hacker News mentions → Slack");
  });

  it("follows a re-posted plan, and keeps the last name when a brief carries none", async () => {
    composerAttach.mockImplementation(
      scripted([
        { event: "brief", data: brief(), seq: 1 },
        { event: "brief", data: brief({ name: "HN mentions → #growth" }), seq: 2 },
        { event: "brief", data: brief({ name: undefined }), seq: 3 },
      ]),
    );
    await useComposer.getState().attach();
    expect(useComposer.getState().suggestedName).toBe("HN mentions → #growth");
  });

  it("hydrates the name from a reattach snapshot, so a refresh keeps it", async () => {
    composerAttach.mockImplementation(
      scripted([
        {
          event: "snapshot",
          seq: 1,
          data: {
            brief: brief(),
            questions: [],
            assumptions: [],
            step_results: [],
            connection_needs: [],
            ir: null,
            offer_pending: false,
            busy: false,
          },
        },
      ]),
    );
    await useComposer.getState().attach();
    expect(useComposer.getState().suggestedName).toBe("Hacker News mentions → Slack");
  });

  /**
   * The agent's own document carries the seeded name and every op_applied replaces the canvas with
   * it, so the create path stamps the plan's name rather than trusting an earlier one to survive.
   */
  it("stamps the plan's name on the document the save chip creates", async () => {
    const deploy = vi.fn().mockResolvedValue(undefined);
    useWorkflow.setState({ workflowJson: { name: UNTITLED_WORKFLOW, nodes: [], edges: [] }, deploy });
    composerAttach.mockImplementation(scripted([{ event: "brief", data: brief(), seq: 1 }]));
    await useComposer.getState().attach();

    await useComposer.getState().acceptOffer("live");

    expect(deploy).toHaveBeenCalled();
    expect((useWorkflow.getState().workflowJson as { name: string }).name).toBe(
      "Hacker News mentions → Slack",
    );
  });

  it("never renames a workflow a person already named", async () => {
    const deploy = vi.fn().mockResolvedValue(undefined);
    useWorkflow.setState({ workflowJson: { name: "My own name", nodes: [], edges: [] }, deploy });
    composerAttach.mockImplementation(scripted([{ event: "brief", data: brief(), seq: 1 }]));
    await useComposer.getState().attach();

    await useComposer.getState().acceptOffer("live");

    expect((useWorkflow.getState().workflowJson as { name: string }).name).toBe("My own name");
  });

  it("starts with no name, and forgets it on reset", async () => {
    expect(useComposer.getState().suggestedName).toBeNull();
    composerAttach.mockImplementation(scripted([{ event: "brief", data: brief(), seq: 1 }]));
    await useComposer.getState().attach();
    useComposer.getState().reset();
    expect(useComposer.getState().suggestedName).toBeNull();
  });
});
