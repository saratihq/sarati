import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import type { StepAccount } from "@/api/client";
import { reloadStepAccounts, useStepAccount, useStepAccounts } from "@/store/useStepAccounts";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  runAsAccounts: vi.fn(),
}));

const runAsAccounts = vi.mocked(api.runAsAccounts);
const answer = (connectionId: string | null): StepAccount => ({
  node_id: "mail",
  node_name: "Mail",
  app: "gmail",
  state: connectionId ? "chosen" : "only",
  connection_id: connectionId ?? "conn-only",
  accounts: ["conn-only", "conn-a"],
  managed_only: false,
  message: null,
});

function canvas(connectionId?: string): void {
  useWorkflow.setState({
    workflowJson: {
      nodes: [{ id: "mail", name: "Mail", node_type: "gmail.send_email", parameters: connectionId ? { connectionId } : {} }],
      edges: [],
    },
  });
}

const askedWith = (call: number) =>
  (runAsAccounts.mock.calls[call]![0] as { nodes: Array<{ parameters: { connectionId?: string } }> }).nodes[0]!
    .parameters.connectionId;

beforeEach(() => {
  useWorkflow.getState().reset();
  canvas();
});

describe("what each step runs as, asked once for the open canvas", () => {
  it("every surface shares one ask", async () => {
    runAsAccounts.mockResolvedValue({ steps: [answer(null)] });
    const banner = renderHook(() => useStepAccounts());
    const inspector = renderHook(() => useStepAccount("mail"));

    await waitFor(() => expect(inspector.result.current.account?.state).toBe("only"));
    expect(banner.result.current.steps.mail?.state).toBe("only");
    expect(runAsAccounts).toHaveBeenCalledTimes(1);
  });

  it("an answer for a step since changed back is asked again, never left standing", async () => {
    let release: (value: { steps: StepAccount[] }) => void = () => {};
    runAsAccounts.mockResolvedValueOnce({ steps: [answer(null)] });
    const { result } = renderHook(() => useStepAccount("mail"));
    await waitFor(() => expect(result.current.account?.state).toBe("only"));

    runAsAccounts.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    act(() => canvas("conn-a"));
    await waitFor(() => expect(runAsAccounts).toHaveBeenCalledTimes(2));
    act(() => canvas());
    runAsAccounts.mockResolvedValueOnce({ steps: [answer(null)] });
    await act(async () => release({ steps: [answer("conn-a")] }));

    await waitFor(() => expect(runAsAccounts).toHaveBeenCalledTimes(3));
    expect(askedWith(2)).toBeUndefined();
    await waitFor(() => expect(result.current).toMatchObject({ settling: false, account: { state: "only" } }));
  });

  it("once no surface shows it the answer is forgotten, so the next one asks afresh", async () => {
    runAsAccounts.mockResolvedValue({ steps: [answer(null)] });
    const first = renderHook(() => useStepAccounts());
    await waitFor(() => expect(first.result.current.steps.mail).toBeDefined());
    first.unmount();

    const second = renderHook(() => useStepAccounts());
    expect(second.result.current.steps).toEqual({});
    await waitFor(() => expect(runAsAccounts).toHaveBeenCalledTimes(2));
  });

  it("a failed ask is reported, and a reload asks again", async () => {
    runAsAccounts.mockRejectedValueOnce(new Error("Rate limit exceeded. Please try again later."));
    const { result } = renderHook(() => useStepAccount("mail"));
    await waitFor(() => expect(result.current.error).toBe("Rate limit exceeded. Please try again later."));

    runAsAccounts.mockResolvedValueOnce({ steps: [answer(null)] });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current).toMatchObject({ error: null, account: { state: "only" } }));
  });
});

describe("where the composer's Connect ask shows", () => {
  beforeEach(() => vi.clearAllMocks());

  it("on a step only while it has no account to run as; on an app trigger as placed, its account being its environment's", async () => {
    useWorkflow.setState({
      workflowJson: {
        nodes: [
          { id: "watch", name: "New email", node_type: "gmail.new_email_trigger", parameters: {}, metadata: { trigger: true } },
          { id: "mail", name: "Mail", node_type: "gmail.send_email", parameters: {} },
          { id: "post", name: "Post", node_type: "slack.send_channel_message", parameters: {} },
          { id: "join", name: "Join", node_type: "text.concat", parameters: {} },
        ],
        edges: [],
      },
    });
    runAsAccounts.mockResolvedValue({
      steps: [
        answer(null),
        { ...answer(null), node_id: "post", node_name: "Post", app: "slack", state: "none", connection_id: null, accounts: [], message: "none" },
      ],
    });
    const { result } = renderHook(() => useStepAccounts());

    expect(result.current.connecting).toEqual({ watch: true });
    await waitFor(() => expect(result.current.connecting).toEqual({ watch: true, mail: false, post: true, join: false }));
  });

  it("a connect asks again, and the ask it answers shows no more", async () => {
    useWorkflow.setState({
      workflowJson: { nodes: [{ id: "mail", name: "Mail", node_type: "gmail.send_email", parameters: {} }], edges: [] },
    });
    runAsAccounts.mockResolvedValue({
      steps: [{ ...answer(null), state: "none", connection_id: null, accounts: [], message: "none" }],
    });
    const { result } = renderHook(() => useStepAccounts());
    await waitFor(() => expect(result.current.connecting).toEqual({ mail: true }));

    runAsAccounts.mockResolvedValue({ steps: [answer(null)] });
    act(() => reloadStepAccounts());

    await waitFor(() => expect(result.current.connecting).toEqual({ mail: false }));
    expect(runAsAccounts).toHaveBeenCalledTimes(2);
  });
});
