import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "@/api/agent";
import * as api from "@/api/client";
import { irContentKey } from "@/lib/irCompare";
import { toast } from "@/lib/toast";
import { useComposer } from "@/store/useComposer";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  composerAttach: vi.fn(),
  composerStream: vi.fn(),
  refreshSessionToken: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  deployWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  listVersions: vi.fn(),
  commitVersion: vi.fn(),
  listConnections: vi.fn(),
  composeMerge: vi.fn(),
  listNodeTypes: vi.fn(),
}));

const composerAttach = vi.mocked(agent.composerAttach);
const composerStream = vi.mocked(agent.composerStream);
const deployWorkflow = vi.mocked(api.deployWorkflow);
const getWorkflow = vi.mocked(api.getWorkflow);
const listVersions = vi.mocked(api.listVersions);
const commitVersion = vi.mocked(api.commitVersion);
const listConnections = vi.mocked(api.listConnections);
const composeMerge = vi.mocked(api.composeMerge);
const listNodeTypes = vi.mocked(api.listNodeTypes);

type Doc = Record<string, unknown>;
type Node = { id: string; name?: string; parameters?: Record<string, unknown> };
type Edge = { source_node_id: string; target_node_id: string };

function scripted(events: agent.SequencedComposerEvent[]) {
  return async function* () {
    for (const evt of events) yield evt;
  };
}

const node = (id: string, name: string, nodeType: string, parameters: Record<string, unknown>, x: number) => ({
  id,
  name,
  node_type: nodeType,
  type_version: 1,
  parameters,
  position: { x, y: 300 },
  metadata: {},
});
const edge = (from: string, to: string) => ({
  id: `e-${from}-${to}`,
  source_node_id: from,
  source_port: 0,
  target_node_id: to,
  target_port: 0,
  port_type: "main",
});
const docOf = (nodes: unknown[], edges: unknown[]): Doc => ({
  version: "1",
  name: "Daily digest",
  description: "",
  nodes,
  edges,
  settings: { timezone: null, error_workflow: null, execution_timeout: null },
  metadata: { engine: "orchestr" },
});

const trigger = node("trigger", "Trigger", "orchestr:trigger", {}, 60);
const digest = node("build_digest", "Build the digest", "orchestr:code", { language: "js", code: "return 1;" }, 360);
const report = node(
  "send_report",
  "Email me the report",
  "gmail.send_email",
  { to: "{{$account.email}}", subject: "Digest", body: "{{steps.build_digest}}" },
  660,
);
const summarize = node("summarize", "Summarize", "text.concat", { texts: ["a"] }, 960);
const withDigest = docOf([trigger, digest], [edge("trigger", "build_digest")]);
const withReport = docOf([trigger, digest, report], [edge("trigger", "build_digest"), edge("build_digest", "send_report")]);

const canvas = (): Doc => useWorkflow.getState().workflowJson as Doc;
const idsOf = (doc: unknown): string[] => (doc as { nodes: Node[] }).nodes.map((n) => n.id);
const paramsOf = (doc: unknown, id: string) => (doc as { nodes: Node[] }).nodes.find((n) => n.id === id)?.parameters;
const lastSent = () => composerStream.mock.calls.at(-1)![0];

// The service's composer merge at step grain: a step edited on one side and removed on the other is kept and reported, and an edge either side added lands whether or not its steps did.
async function serviceMerge(base: Doc, ours: Doc, theirs: Doc) {
  const stepsOf = (doc: Doc) => new Map((doc.nodes as Node[]).map((n) => [n.id, n]));
  const edgesOf = (doc: Doc) => new Map((doc.edges as Edge[]).map((e) => [`${e.source_node_id}>${e.target_node_id}`, e]));
  const changed = (now: Node, before: Node) => irContentKey(now) !== irContentKey(before);
  const [was, mine, agents] = [stepsOf(base), stepsOf(ours), stepsOf(theirs)];
  const nodes: Node[] = [];
  const conflicts: api.ComposerMergeConflict[] = [];
  for (const id of new Set([...was.keys(), ...mine.keys(), ...agents.keys()])) {
    const before = was.get(id);
    const mineNow = mine.get(id);
    const agentsNow = agents.get(id);
    if (!before) {
      nodes.push((mineNow ?? agentsNow)!);
    } else if (mineNow && agentsNow) {
      nodes.push(changed(mineNow, before) ? mineNow : agentsNow);
    } else if (mineNow ?? agentsNow) {
      const edited = (mineNow ?? agentsNow)!;
      if (!changed(edited, before)) continue;
      nodes.push(edited);
      conflicts.push({
        node_id: id,
        node_name: edited.name ?? id,
        kind: "edit_delete",
        field_path: null,
        ours: mineNow ?? null,
        theirs: agentsNow ?? null,
        base: before,
      });
    }
  }
  const [wasEdges, mineEdges, agentsEdges] = [edgesOf(base), edgesOf(ours), edgesOf(theirs)];
  const edges = new Map([...wasEdges].filter(([key]) => mineEdges.has(key) && agentsEdges.has(key)));
  for (const [key, e] of [...mineEdges, ...agentsEdges]) if (!wasEdges.has(key)) edges.set(key, e);
  return { merged: { ...theirs, nodes, edges: [...edges.values()] }, conflicts };
}

// The build turn on the compose page, as the agent streams it live.
const buildTurn = () =>
  scripted([
    { event: "session", data: { session_id: "s-1" }, seq: 0 },
    { event: "assistant_text", data: { text: "Building it." }, seq: 2 },
    { event: "op_applied", data: { ops: [], ir: withDigest }, seq: 3 },
    { event: "op_applied", data: { ops: [], ir: withReport }, seq: 4 },
    { event: "connection_needed", data: { node_id: "send_report", provider: "gmail", provider_label: "Gmail" }, seq: 5 },
    { event: "offer", data: { offer_id: "o1" }, seq: 6 },
    { event: "done", data: { session_id: "s-1", duration_ms: 1 }, seq: 7 },
  ]);

// The durable log the agent replays on attach: that build turn, then the hand-off turn the save chip sent.
const buildLog = (): agent.SequencedComposerEvent[] => [
  { event: "user_message", data: { text: "Email me a daily digest" }, seq: 1 },
  { event: "assistant_text", data: { text: "Building it." }, seq: 2 },
  { event: "op_applied", data: { ops: [], ir: withDigest }, seq: 3 },
  { event: "op_applied", data: { ops: [], ir: withReport }, seq: 4 },
  { event: "connection_needed", data: { node_id: "send_report", provider: "gmail", provider_label: "Gmail" }, seq: 5 },
  { event: "offer", data: { offer_id: "o1" }, seq: 6 },
  { event: "done", data: { session_id: "s-1", duration_ms: 1 }, seq: 7 },
  { event: "user_message", data: { text: "Created it." }, seq: 8 },
  { event: "assistant_text", data: { text: "It's saved." }, seq: 9 },
  { event: "done", data: { session_id: "s-1", duration_ms: 1 }, seq: 10 },
];

interface Reattach {
  /** The durable log the agent replays. */
  log?: agent.SequencedComposerEvent[];
  /** A running turn's batches after the replay. */
  live?: agent.SequencedComposerEvent[];
  /** The canvas a running turn started from, as the agent's replayed marker carries it. */
  turnBase?: Doc;
  /** The person's edits between the replay and the turn's next batch. */
  meanwhile?: () => void;
  branch?: string;
}

// Open the editor on a saved head, as a navigation or reload does: both stores start over, the head loads, the composer reattaches.
async function openEditor(
  head: Doc,
  { log = buildLog(), live = [], turnBase, meanwhile = () => undefined, branch = "main" }: Reattach = {},
): Promise<void> {
  useComposer.getState().reset();
  useWorkflow.getState().reset();
  getWorkflow.mockResolvedValue({ name: "Daily digest" } as Awaited<ReturnType<typeof api.getWorkflow>>);
  listVersions.mockResolvedValue({
    workflow_id: "wf-1",
    versions: [{ id: "v1", version_number: 1, workflow_json: head }],
  } as Awaited<ReturnType<typeof api.listVersions>>);
  expect(await useWorkflow.getState().loadForEdit("wf-1", branch)).toBe(true);
  const lastSeq = log.at(-1)?.seq ?? 0;
  composerAttach.mockImplementationOnce(async function* () {
    yield { event: "session", data: { session_id: "s-1" }, seq: lastSeq } as agent.SequencedComposerEvent;
    yield* log;
    yield { event: "replayed", data: turnBase ? { turn_base: turnBase } : {}, seq: lastSeq } as agent.SequencedComposerEvent;
    meanwhile();
    yield* live;
  });
  await useComposer.getState().attach("wf-1");
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  useComposer.getState().reset();
  useWorkflow.getState().reset();
  composerStream.mockImplementation(scripted([]));
  composeMerge.mockImplementation(serviceMerge);
  listNodeTypes.mockResolvedValue({ node_types: [] });
});

describe("the owner's sequence: compose, remove the Gmail step on the canvas, Save", () => {
  it("the editor shows no Gmail step after the reattach, and saving again is an honest no changes", async () => {
    useWorkflow.getState().startScratch();
    composerStream.mockImplementationOnce(buildTurn());
    await useComposer.getState().send("Email me a daily digest");
    expect(idsOf(canvas())).toEqual(["trigger", "build_digest", "send_report"]);

    useWorkflow.getState().deleteWorkflowNode("send_report");
    deployWorkflow.mockResolvedValue({ workflow_id: "wf-1", workflow_url: "", name: "Daily digest", is_live: true });
    await useComposer.getState().acceptOffer("live");

    const v1 = deployWorkflow.mock.calls[0]![0];
    expect(idsOf(v1)).toEqual(["trigger", "build_digest"]);
    // The hand-off turn carries the canvas, so the composer sees the step isn't there.
    expect(lastSent()).toMatchObject({ message: "Created it.", workflowId: "wf-1", branch: "main" });
    expect(idsOf(lastSent().ir)).toEqual(["trigger", "build_digest"]);

    await openEditor(v1);
    expect(idsOf(canvas())).toEqual(["trigger", "build_digest"]);
    expect(irContentKey(canvas())).toBe(irContentKey(v1));
    expect(useWorkflow.getState().dirty).toBe(false);
    const said = useComposer.getState().thread.flatMap((e) => (e.kind === "user" ? [e.text] : []));
    expect(said).toEqual(["Email me a daily digest", "Created it."]);

    // A reload replays the same thread, and the canvas still holds v1.
    await openEditor(v1);
    expect(irContentKey(canvas())).toBe(irContentKey(v1));
    expect(useWorkflow.getState().dirty).toBe(false);

    expect(await useWorkflow.getState().saveDeployedEdits()).toEqual({ kind: "unchanged", matches: null, branch: "main" });
    await useComposer.getState().acceptOffer("live", "wf-1");
    expect(commitVersion).not.toHaveBeenCalled();
    expect(lastSent().message).toBe(
      "(canvas note) Nothing was saved — the canvas is unchanged since it was last opened or saved, so no new version was made.",
    );
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});

describe("a reattach restores the conversation, never the canvas", () => {
  it("a turn that finished while the editor was closed never lands on it", async () => {
    await openEditor(withDigest, {
      log: [
        { event: "user_message", data: { text: "Email me the report" }, seq: 1 },
        { event: "op_applied", data: { ops: [], ir: withReport }, seq: 2 },
        { event: "offer", data: { offer_id: "o1" }, seq: 3 },
        { event: "done", data: { session_id: "s-1", duration_ms: 1 }, seq: 4 },
      ],
    });
    expect(irContentKey(canvas())).toBe(irContentKey(withDigest));
    expect(useWorkflow.getState().dirty).toBe(false);
    expect(useComposer.getState().offerPending).toBe(true);
  });

  it("a memory-only snapshot restores the conversation and leaves the canvas alone", async () => {
    await openEditor(withDigest, { log: [] });
    useComposer.getState().reset();
    composerAttach.mockImplementationOnce(
      scripted([
        { event: "session", data: { session_id: "s-1" }, seq: 4 },
        {
          event: "snapshot",
          seq: 4,
          data: {
            brief: null,
            questions: [],
            assumptions: [],
            step_results: [],
            connection_needs: [],
            offer_pending: true,
            busy: false,
          },
        },
        { event: "replayed", data: {}, seq: 4 },
      ]),
    );
    await useComposer.getState().attach("wf-1");

    expect(useComposer.getState().offerPending).toBe(true);
    expect(irContentKey(canvas())).toBe(irContentKey(withDigest));
    expect(useWorkflow.getState().dirty).toBe(false);
  });

  // A turn still running when the editor reopens: its earlier batch is only in the replay, never on the canvas.
  const joinedTurn: agent.SequencedComposerEvent[] = [
    { event: "user_message", data: { text: "Email me the report" }, seq: 1 },
    { event: "op_applied", data: { ops: [], ir: withReport }, seq: 2 },
  ];
  const editTheDigest = () =>
    useWorkflow.getState().updateIrNode("build_digest", { parameters: { language: "js", code: "return 42;" } });

  it("a live batch that fills in a step only the replay held lands it, and says nothing in the person's name", async () => {
    const filled = docOf(
      [trigger, digest, { ...report, parameters: { ...report.parameters, subject: "Weekly digest" } }],
      withReport.edges as unknown[],
    );
    await openEditor(withDigest, {
      log: joinedTurn,
      turnBase: withDigest,
      live: [{ event: "op_applied", data: { ops: [], ir: filled }, seq: 3 }],
    });

    expect(idsOf(canvas())).toEqual(["trigger", "build_digest", "send_report"]);
    expect(paramsOf(canvas(), "send_report")?.subject).toBe("Weekly digest");
    expect(composerStream).not.toHaveBeenCalled();
  });

  it("a live batch wiring a new step after one only the replay held lands both, with every edge between steps on the canvas", async () => {
    const live = docOf(
      [trigger, digest, report, summarize],
      [edge("trigger", "build_digest"), edge("build_digest", "send_report"), edge("send_report", "summarize")],
    );
    await openEditor(withDigest, {
      log: joinedTurn,
      turnBase: withDigest,
      meanwhile: editTheDigest,
      live: [{ event: "op_applied", data: { ops: [], ir: live }, seq: 3 }],
    });

    expect(idsOf(canvas())).toEqual(["trigger", "build_digest", "send_report", "summarize"]);
    expect(paramsOf(canvas(), "build_digest")?.code).toBe("return 42;");
    const steps = new Set(idsOf(canvas()));
    for (const e of canvas().edges as Edge[]) {
      expect([steps.has(e.source_node_id), steps.has(e.target_node_id)]).toEqual([true, true]);
    }
    expect(composerStream).not.toHaveBeenCalled();
  });

  it("a step the person removes while a joined turn fills it in is reported as their removal, not the composer's", async () => {
    const filled = docOf(
      [trigger, digest, { ...report, parameters: { ...report.parameters, subject: "Weekly digest" } }],
      withReport.edges as unknown[],
    );
    await openEditor(withReport, {
      log: joinedTurn,
      turnBase: withReport,
      meanwhile: () => useWorkflow.getState().deleteWorkflowNode("send_report"),
      live: [{ event: "op_applied", data: { ops: [], ir: filled }, seq: 3 }],
    });

    expect(paramsOf(canvas(), "send_report")?.subject).toBe("Weekly digest");
    expect(lastSent().message).toBe(
      '(canvas note) While you were building I made my own edits. We collided: I removed step "Email me the report" but you had edited it — yours is back on the canvas. Ask me which to keep where we disagree.',
    );
  });

  const addSummary = docOf([trigger, digest, summarize], [edge("trigger", "build_digest"), edge("build_digest", "summarize")]);

  it("joined before its first batch, the live batch merges from the canvas the turn started on, keeping an edit made since", async () => {
    await openEditor(withDigest, {
      log: [{ event: "user_message", data: { text: "Add a summary" }, seq: 1 }],
      turnBase: withDigest,
      meanwhile: editTheDigest,
      live: [{ event: "op_applied", data: { ops: [], ir: addSummary }, seq: 2 }],
    });

    expect(idsOf(canvas())).toEqual(["trigger", "build_digest", "summarize"]);
    expect(paramsOf(canvas(), "build_digest")?.code).toBe("return 42;");
    expect(irContentKey(composeMerge.mock.calls[0]![0])).toBe(irContentKey(withDigest));
  });

  it("a turn begun on main and joined from a branch's editor lands only the composer's changes on that branch", async () => {
    const laneDigest = { ...digest, parameters: { language: "js", code: "return 'lane digest';" } };
    const laneOnly = node("lane_only", "Lane only step", "text.concat", { texts: ["b"] }, 960);
    const laneHead = docOf([trigger, laneDigest, laneOnly], [edge("trigger", "build_digest"), edge("build_digest", "lane_only")]);
    await openEditor(laneHead, {
      branch: "lane",
      log: [
        { event: "user_message", data: { text: "Add a summary" }, seq: 1 },
        { event: "op_applied", data: { ops: [], ir: withDigest }, seq: 2 },
      ],
      turnBase: withDigest,
      live: [{ event: "op_applied", data: { ops: [], ir: addSummary }, seq: 3 }],
    });

    expect(useWorkflow.getState().editBranch).toBe("lane");
    expect(idsOf(canvas())).toEqual(["trigger", "build_digest", "lane_only", "summarize"]);
    expect(paramsOf(canvas(), "build_digest")?.code).toBe("return 'lane digest';");
  });

  it("a joined turn that started with no canvas merges from the canvas at the reattach", async () => {
    await openEditor(withDigest, {
      log: [{ event: "user_message", data: { text: "Add a summary" }, seq: 1 }],
      meanwhile: editTheDigest,
      live: [{ event: "op_applied", data: { ops: [], ir: addSummary }, seq: 2 }],
    });

    expect(idsOf(canvas())).toEqual(["trigger", "build_digest", "summarize"]);
    expect(paramsOf(canvas(), "build_digest")?.code).toBe("return 42;");
  });
});

describe("a new workflow after a branch editor", () => {
  it("tells the composer its canvas is on main", async () => {
    getWorkflow.mockResolvedValue({ name: "Daily digest" } as Awaited<ReturnType<typeof api.getWorkflow>>);
    listVersions.mockResolvedValue({
      workflow_id: "wf-1",
      versions: [{ id: "v1", version_number: 1, workflow_json: withDigest }],
    } as Awaited<ReturnType<typeof api.listVersions>>);
    expect(await useWorkflow.getState().loadForEdit("wf-1", "lane")).toBe(true);

    useWorkflow.getState().reset();
    useWorkflow.getState().startScratch();
    await useComposer.getState().send("Email me a daily digest");

    expect(lastSent()).toMatchObject({ message: "Email me a daily digest", branch: "main" });
  });
});

describe("unsaved changes are decided by content", () => {
  beforeEach(async () => {
    await openEditor(withDigest, { log: [] });
  });

  it("an edit that returns the canvas to the saved version shows no unsaved changes", () => {
    useWorkflow.getState().updateIrNode("build_digest", { parameters: { language: "js", code: "return 2;" } });
    expect(useWorkflow.getState().dirty).toBe(true);
    useWorkflow.getState().updateIrNode("build_digest", { parameters: { language: "js", code: "return 1;" } });
    expect(useWorkflow.getState().dirty).toBe(false);

    useWorkflow.getState().removeWorkflowConnection("trigger", "build_digest");
    expect(useWorkflow.getState().dirty).toBe(true);
    useWorkflow.getState().addWorkflowConnection("trigger", "build_digest");
    expect(useWorkflow.getState().dirty).toBe(false);
  });

  it("removing a step the saved version has is a real change", () => {
    useWorkflow.getState().deleteWorkflowNode("build_digest");
    expect(useWorkflow.getState().dirty).toBe(true);
  });

  it("a step parameter named position is content: changing it arms Save and the save commits it", async () => {
    const card = node("move_card", "Move the card", "github.move_a_project_card", { card_id: 9, position: 3 }, 660);
    await openEditor(docOf([trigger, card], [edge("trigger", "move_card")]), { log: [] });

    useWorkflow.getState().updateIrNode("move_card", { parameters: { card_id: 9, position: 7 } });
    expect(useWorkflow.getState().dirty).toBe(true);

    commitVersion.mockResolvedValue({ id: "v2", version_number: 2 } as Awaited<ReturnType<typeof api.commitVersion>>);
    expect(await useWorkflow.getState().saveDeployedEdits()).toEqual({ kind: "committed", versionNumber: 2, branch: "main" });
    expect(paramsOf(commitVersion.mock.calls[0]![1].workflow_json, "move_card")?.position).toBe(7);
    expect(useWorkflow.getState().dirty).toBe(false);
  });
});

describe("what a save reports", () => {
  beforeEach(async () => {
    await openEditor(withDigest, { log: [] });
  });

  it("a save the service finds unchanged says so — no version, no toast, no 'Saved, but…' warning", async () => {
    useWorkflow.getState().updateIrNode("build_digest", { parameters: { language: "js", code: "return 2;" } });
    commitVersion.mockResolvedValue({
      id: "v1",
      version_number: 1,
      no_changes: true,
      ref_warnings: ["{{missing.field}} won't resolve"],
    } as Awaited<ReturnType<typeof api.commitVersion>>);

    await useComposer.getState().acceptOffer("live", "wf-1");

    expect(lastSent().message).toBe(
      "(canvas note) Nothing was saved — the canvas already matches v1, the latest version on main, so no new version was made.",
    );
    expect(useWorkflow.getState().dirty).toBe(false);
    for (const say of Object.values(toast)) expect(say).not.toHaveBeenCalled();
  });

  it("a minted version is named on the canvas's branch", async () => {
    useWorkflow.setState({ editBranch: "lane" });
    useWorkflow.getState().deleteWorkflowNode("build_digest");
    commitVersion.mockResolvedValue({ id: "v2", version_number: 2 } as Awaited<ReturnType<typeof api.commitVersion>>);

    await useComposer.getState().acceptOffer("live", "wf-1");

    expect(lastSent().message).toBe(
      "Saved a new version on lane. It reaches what runs only after a merge into main and a publish, or a promotion.",
    );
  });

  it("a failed save tells the composer and the person nothing was saved", async () => {
    useWorkflow.getState().deleteWorkflowNode("build_digest");
    commitVersion.mockRejectedValue(new Error("The service is unreachable."));

    await useComposer.getState().acceptOffer("live", "wf-1");

    expect(lastSent().message).toBe("(canvas note) Nothing was saved — the save failed: The service is unreachable.");
    expect(useComposer.getState().failure).toBe("Couldn't save: The service is unreachable.");
    expect(useWorkflow.getState().dirty).toBe(true);
  });

  it("an edit made while the save is in flight stays unsaved", async () => {
    useWorkflow.getState().updateIrNode("build_digest", { parameters: { language: "js", code: "return 2;" } });
    commitVersion.mockImplementation(async () => {
      useWorkflow.getState().updateIrNode("trigger", { name: "Start" });
      return { id: "v2", version_number: 2 } as Awaited<ReturnType<typeof api.commitVersion>>;
    });

    expect(await useWorkflow.getState().saveDeployedEdits()).toMatchObject({ kind: "committed" });
    expect(useWorkflow.getState().dirty).toBe(true);
    useWorkflow.getState().updateIrNode("trigger", { name: "Trigger" });
    expect(useWorkflow.getState().dirty).toBe(false);
  });
});

describe("the Connect chip", () => {
  const needsGmail: agent.SequencedComposerEvent[] = [
    { event: "connection_needed", data: { node_id: "send_report", provider: "gmail", provider_label: "Gmail" }, seq: 1 },
  ];

  it("on a protected branch writes nothing to the canvas, and still has the composer re-test", async () => {
    await openEditor(withReport, { log: needsGmail });
    useWorkflow.setState({ editBranchProtected: true });

    await useComposer.getState().notifyConnected("gmail", "Gmail");

    expect(irContentKey(canvas())).toBe(irContentKey(withReport));
    expect(paramsOf(canvas(), "send_report")?.connectionId).toBeUndefined();
    expect(useWorkflow.getState().dirty).toBe(false);
    expect(listConnections).not.toHaveBeenCalled();
    expect(useComposer.getState().connectionNeeds).toEqual({});
    expect(lastSent().message).toBe("(canvas note) Gmail is now connected — re-test the step that needed it.");
  });

  it("elsewhere still attaches the account it connected to the waiting step", async () => {
    await openEditor(withReport, { log: needsGmail });
    listConnections.mockResolvedValue({
      connections: [{ id: "conn-gmail", provider: "gmail", status: "active", created_at: "2026-10-12T00:00:00Z" }],
    } as unknown as Awaited<ReturnType<typeof api.listConnections>>);

    await useComposer.getState().notifyConnected("gmail", "Gmail");

    expect(paramsOf(canvas(), "send_report")?.connectionId).toBe("conn-gmail");
  });
});
