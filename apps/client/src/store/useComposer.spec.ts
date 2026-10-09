import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "@/api/agent";
import { useComposer } from "@/store/useComposer";
import { UNTITLED_WORKFLOW, useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  composerAttach: vi.fn(),
  composerStream: vi.fn(),
  refreshSessionToken: vi.fn(),
}));

const composerAttach = vi.mocked(agent.composerAttach);
const composerStream = vi.mocked(agent.composerStream);

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
  composerStream.mockReset();
  composerStream.mockImplementation(scripted([]));
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

describe("useComposer on any canvas", () => {
  it("sends the canvas's branch with each message, so the composer knows what a save there changes", async () => {
    useWorkflow.setState({ workflowJson: { name: "Digest", nodes: [], edges: [] }, editBranch: "lane" });

    await useComposer.getState().send("tighten the summary", "wf-1");

    expect(composerStream.mock.calls[0]![0]).toMatchObject({ workflowId: "wf-1", branch: "lane" });
  });

  it("after saving a branch canvas, tells the composer the save changes nothing that runs", async () => {
    const saveDeployedEdits = vi.fn(async () => {
      useWorkflow.setState({ dirty: false });
    });
    useWorkflow.setState({ workflowJson: { name: "Digest", nodes: [], edges: [] }, editBranch: "lane", saveDeployedEdits });

    await useComposer.getState().acceptOffer("live", "wf-1");

    expect(saveDeployedEdits).toHaveBeenCalled();
    expect(composerStream.mock.calls.at(-1)![0].message).toBe(
      "Saved a new version on lane. It reaches what runs only after a merge into main and a publish, or a promotion.",
    );
  });
});
