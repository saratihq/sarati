import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerQuestion,
  composerAttach,
  composerClear,
  composerStatus,
  composerStream,
  refreshSessionToken,
} from "@/api/agent";
import { setActiveOrgId } from "@/api/client";
import { LOCAL_SESSION_COOKIE } from "@/lib/localSession";

const AGENT = "http://localhost:8010/api";

function answering(body: string, contentType: string) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": contentType } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const drain = (events: AsyncGenerator<unknown>) => Array.fromAsync(events);

const calls = [
  { name: "composerStatus", path: "/composer/status", body: '{"status":"ok"}', call: () => composerStatus() },
  {
    name: "composerStream",
    path: "/composer/stream",
    sse: true,
    call: () => drain(composerStream({ message: "build it", workflowId: "wf1" })),
  },
  {
    name: "composerAttach",
    path: "/composer/attach",
    sse: true,
    call: () => drain(composerAttach({ workflowId: "wf1" })),
  },
  {
    name: "composerClear",
    path: "/composer/clear",
    body: '{"cleared":true}',
    call: () => composerClear({ workflowId: "wf1" }),
  },
  {
    name: "refreshSessionToken",
    path: "/composer/token",
    body: '{"status":"refreshed"}',
    call: () => refreshSessionToken("s1"),
  },
  {
    name: "answerQuestion",
    path: "/composer/answer",
    body: '{"status":"answered"}',
    call: () => answerQuestion({ sessionId: "s1", questionId: "q1", answer: "yes" }),
  },
];

beforeEach(() => {
  document.cookie = `${LOCAL_SESSION_COOKIE}=caller-jwt; Path=/`;
});

afterEach(() => {
  setActiveOrgId(null);
});

describe("every composer request runs in the active workspace", () => {
  it.each(calls)("$name sends X-Org-Id in a team workspace and none in the personal one", async ({ path, body, sse, call }) => {
    const fetchMock = sse ? answering("", "text/event-stream") : answering(body ?? "{}", "application/json");

    setActiveOrgId("org_team");
    await call();
    setActiveOrgId(null);
    await call();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${AGENT}${path}`, `${AGENT}${path}`]);
    const sent = fetchMock.mock.calls.map(([, init]) => init?.headers as Record<string, string>);
    expect(sent.map((headers) => headers["X-Org-Id"])).toEqual(["org_team", undefined]);
    expect(sent.map((headers) => headers.Authorization)).toEqual(["Bearer caller-jwt", "Bearer caller-jwt"]);
  });
});
