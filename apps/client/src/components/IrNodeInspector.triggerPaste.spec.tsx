import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeTypeEntry } from "@/api/client";
import IrNodeInspector from "@/components/IrNodeInspector";
import { clearLocalSession, LOCAL_SESSION_COOKIE } from "@/lib/localSession";
import { useStepSamples } from "@/store/useStepSamples";
import { useWorkflow } from "@/store/useWorkflow";

vi.mock("./NodeCatalogPanel", () => ({ catalogEntryFor: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { catalogEntryFor } = await import("./NodeCatalogPanel");
const catalogEntry = vi.mocked(catalogEntryFor);

const EVENT = '{"email": "sara@acme.com", "plan": "pro"}';
const LATER = '{"email": "omar@acme.com", "plan": "team"}';

// The service's answer per body: the trigger a webhook run of it sees (webhook-sample.e2e-spec pins it).
const RUN_SHAPE: Record<string, unknown> = {
  [EVENT]: { email: "sara@acme.com", plan: "pro", body: { email: "sara@acme.com", plan: "pro" } },
  [LATER]: { email: "omar@acme.com", plan: "team", body: { email: "omar@acme.com", plan: "team" } },
  '"ping"': { body: "ping" },
};

interface Shaped {
  body: string;
  headers: Record<string, string>;
}

// The service over `fetch`: the paste shaper and the catch inbox (mint, poll); every other call is a 404.
function sampleService() {
  let minted = 0;
  const shaped: Shaped[] = [];
  const caught = new Map<string, { deliveries: number; payload: unknown }>();
  let gate: Promise<void> = Promise.resolve();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname } = new URL(url);
      const method = init?.method ?? "GET";
      if (method === "POST" && pathname === "/api/triggers/webhook-sample") {
        await gate;
        const body = String(init?.body);
        try {
          JSON.parse(body);
        } catch {
          return json(400, { detail: "The request body is not valid JSON" });
        }
        shaped.push({ body, headers: init?.headers as Record<string, string> });
        return json(200, { payload: RUN_SHAPE[body] });
      }
      if (method === "POST" && pathname === "/api/catch") {
        minted += 1;
        const catchId = `catch-${minted}`;
        caught.set(catchId, { deliveries: 0, payload: null });
        return json(201, { catch_id: catchId, path: `/api/hooks/catch/${catchId}`, expires_at: "2099-01-01T00:00:00Z" });
      }
      const poll = /^\/api\/catch\/(.+)$/.exec(pathname);
      const entry = poll ? caught.get(poll[1]!) : undefined;
      if (method === "GET" && entry) {
        return json(200, { received: entry.deliveries > 0, ...entry });
      }
      return json(404, { detail: "Not Found" });
    }),
  );
  return {
    shaped,
    minted: () => minted,
    // A sender's event landing on the catch.
    deliver: (catchId: string, body: string) => {
      const entry = caught.get(catchId)!;
      caught.set(catchId, { deliveries: entry.deliveries + 1, payload: RUN_SHAPE[body] });
    },
    // Holds every paste until the returned release is called.
    hold: (): (() => void) => {
      let release = () => {};
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

function openDoc(nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>> = []): void {
  const doc = {
    version: "1",
    name: "paste",
    nodes: nodes.map((n) => ({ type_version: 1, parameters: {}, position: { x: 0, y: 0 }, metadata: {}, ...n })),
    edges,
  };
  useWorkflow.setState({ workflowId: null, workflowJson: doc, workflowIr: structuredClone(doc) });
}

const triggerSample = (): unknown => useStepSamples.getState().samples.trigger;

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

const polls = (count: number) => act(() => vi.advanceTimersByTimeAsync(2000 * count));

// Pastes `text` into the open sample box under `scope` and asks for it to be used.
async function paste(text: string, scope: HTMLElement = document.body): Promise<void> {
  const box = within(scope).getByLabelText("Sample event JSON");
  await user().clear(box);
  await user().click(box);
  await user().paste(text);
  await user().click(within(scope).getByTestId("trigger-paste-use"));
}

async function openTrigger(nodeType: string, metadata: Record<string, unknown> = {}): Promise<void> {
  openDoc([{ id: "trigger", name: "Trigger", node_type: nodeType, metadata }]);
  render(<IrNodeInspector nodeId="trigger" onClose={() => {}} />);
}

async function openTriggerPaste(nodeType: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await openTrigger(nodeType, metadata);
  const opener = screen.queryByTestId("trigger-paste-open");
  if (opener) await user().click(opener);
}

async function listen(): Promise<void> {
  await user().click(screen.getByTestId("trigger-catch-start"));
  await screen.findByTestId("trigger-catch-waiting");
}

// A step after the trigger whose `text` field reads `{{trigger.body.email}}`, with its data picker open.
async function openPickerAfter(triggerType: string, metadata: Record<string, unknown> = {}): Promise<HTMLElement> {
  const parameters: NodeTypeEntry["parameters"] = { text: { type: "SHORT_TEXT", label: "Message", required: true } };
  catalogEntry.mockResolvedValue({ type: "slack.send_channel_message", name: "Send message", parameters } as NodeTypeEntry);
  openDoc(
    [
      { id: "trigger", name: "Trigger", node_type: triggerType, metadata },
      { id: "alert", name: "alert", node_type: "slack.send_channel_message", parameters: { text: "{{trigger.body.email}}" } },
    ],
    [{ id: "e1", source_node_id: "trigger", target_node_id: "alert" }],
  );
  render(<IrNodeInspector nodeId="alert" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("text").tagName).toBe("INPUT"));
  await user().click(screen.getByRole("button", { name: "Insert data from an earlier step" }));
  return screen.getByRole("menu");
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useStepSamples.getState().clear();
  document.cookie = `${LOCAL_SESSION_COOKIE}=live; Path=/`;
});

afterEach(() => {
  clearLocalSession();
  vi.useRealTimers();
});

describe("pasting a sample event on a webhook trigger", () => {
  it("stores the trigger the service says a webhook run of the paste would see", async () => {
    const service = sampleService();
    await openTriggerPaste("orchestr:webhook");

    await paste(EVENT);

    await waitFor(() => expect(triggerSample()).toEqual(RUN_SHAPE[EVENT]));
    expect(service.shaped).toHaveLength(1);
    expect(service.shaped[0]).toMatchObject({
      body: EVENT,
      headers: { "Content-Type": "application/json", Authorization: "Bearer live" },
    });
  });

  it("takes any JSON value a webhook takes: a bare string becomes the body", async () => {
    sampleService();
    await openTriggerPaste("orchestr:webhook");

    await paste('"ping"');

    await waitFor(() => expect(triggerSample()).toEqual({ body: "ping" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("calls invalid JSON invalid in the same words as every other paste, and keeps no sample", async () => {
    sampleService();
    await openTriggerPaste("orchestr:webhook");

    await paste('{"email":');

    expect(await screen.findByRole("alert")).toHaveTextContent("That isn't valid JSON");
    expect(triggerSample()).toBeUndefined();
  });

  it("opens no catch, however many times it is pasted", async () => {
    const service = sampleService();
    await openTriggerPaste("orchestr:webhook");

    await paste(EVENT);
    await waitFor(() => expect(triggerSample()).toEqual(RUN_SHAPE[EVENT]));
    await paste('{"email":');
    await screen.findByRole("alert");
    await paste('"ping"');
    await waitFor(() => expect(triggerSample()).toEqual({ body: "ping" }));

    expect(service.shaped).toHaveLength(2);
    expect(service.minted()).toBe(0);
  });

  it("holds the button while the paste is on its way, then lets it go again", async () => {
    const service = sampleService();
    await openTriggerPaste("orchestr:webhook");
    const release = service.hold();

    await paste(EVENT);

    const button = screen.getByTestId("trigger-paste-use");
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent("Reading…");
    expect(button).toHaveAttribute("aria-busy", "true");
    release();
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveTextContent("Use as sample");
    expect(triggerSample()).toEqual(RUN_SHAPE[EVENT]);
  });
});

describe("listening for a test event on a webhook trigger", () => {
  it("applies each caught event once, so a Clear stays cleared until a new one lands", async () => {
    const service = sampleService();
    await openTrigger("orchestr:webhook");
    await listen();

    service.deliver("catch-1", EVENT);
    await polls(1);
    expect(triggerSample()).toEqual(RUN_SHAPE[EVENT]);

    await user().click(screen.getByTestId("trigger-sample-clear"));
    await polls(3);
    expect(triggerSample()).toBeUndefined();

    service.deliver("catch-1", LATER);
    await polls(1);
    expect(triggerSample()).toEqual(RUN_SHAPE[LATER]);
  });

  it("keeps a paste made after an event landed but before it was polled", async () => {
    const service = sampleService();
    await openTrigger("orchestr:webhook");
    await listen();
    service.deliver("catch-1", EVENT);

    await user().click(screen.getByTestId("trigger-paste-open"));
    await paste('"ping"');
    await waitFor(() => expect(triggerSample()).toEqual({ body: "ping" }));
    await polls(3);
    expect(triggerSample()).toEqual({ body: "ping" });

    service.deliver("catch-1", LATER);
    await polls(1);
    expect(triggerSample()).toEqual(RUN_SHAPE[LATER]);
  });

  it("keeps a paste made while listening until a new event lands, and sends it to no catch", async () => {
    const service = sampleService();
    await openTrigger("orchestr:webhook");
    await listen();
    service.deliver("catch-1", EVENT);
    await polls(1);
    expect(triggerSample()).toEqual(RUN_SHAPE[EVENT]);

    await user().click(screen.getByTestId("trigger-paste-open"));
    await paste('"ping"');
    await waitFor(() => expect(triggerSample()).toEqual({ body: "ping" }));
    await polls(3);

    expect(triggerSample()).toEqual({ body: "ping" });
    expect(service.minted()).toBe(1);

    service.deliver("catch-1", LATER);
    await polls(1);
    expect(triggerSample()).toEqual(RUN_SHAPE[LATER]);
  });
});

describe("the data picker in a later step", () => {
  it("on a webhook trigger, offers the listener, and a paste makes {{trigger.body.email}} preview its field", async () => {
    sampleService();
    const menu = await openPickerAfter("orchestr:webhook");
    expect(within(menu).getByTestId("trigger-catch-start")).toBeInTheDocument();

    await user().click(within(menu).getByTestId("trigger-paste-open"));
    await paste(EVENT, menu);

    expect(await screen.findByTestId("ref-preview")).toHaveTextContent("→ sara@acme.com");
  });

  it.each([
    ["a chat", "orchestr:chat", {}],
    ["a schedule", "orchestr:schedule", {}],
    ["an app", "gmail.gmail_new_email_received", { trigger: true }],
  ])("on %s trigger, offers no listener, and keeps a paste as pasted", async (_kind, nodeType, metadata) => {
    const service = sampleService();
    const menu = await openPickerAfter(nodeType, metadata);

    expect(within(menu).queryByTestId("trigger-catch-start")).toBeNull();
    await paste('{"id": "evt-1"}', menu);

    await waitFor(() => expect(triggerSample()).toEqual({ id: "evt-1" }));
    expect(service.shaped).toHaveLength(0);
    expect(service.minted()).toBe(0);
  });
});

describe("pasting a sample event on an app trigger", () => {
  const openApp = () => openTriggerPaste("gmail.gmail_new_email_received", { trigger: true });

  it("keeps the pasted object as the sample, with no catch", async () => {
    const service = sampleService();
    await openApp();

    await paste('{"id": "m-1"}');

    expect(triggerSample()).toEqual({ id: "m-1" });
    expect(service.minted()).toBe(0);
    expect(service.shaped).toHaveLength(0);
  });

  it.each(['"ping"', "42", "null", "[1, 2]"])(
    "says valid JSON that is not an object (%s) is not an event, rather than calling it invalid",
    async (text) => {
      sampleService();
      await openApp();

      await paste(text);

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("That's valid JSON, but this trigger's events are objects");
      expect(alert).not.toHaveTextContent("isn't valid JSON");
      expect(triggerSample()).toBeUndefined();
    },
  );

  it("still calls invalid JSON invalid", async () => {
    sampleService();
    await openApp();

    await paste('{"id":');

    expect(screen.getByRole("alert")).toHaveTextContent("That isn't valid JSON");
    expect(triggerSample()).toBeUndefined();
  });
});
