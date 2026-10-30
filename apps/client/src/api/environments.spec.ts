import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveOrgId } from "@/api/client";
import { listEnvironments, RenameMovesUrlsError, renameEnvironment, type UrlChange } from "@/api/environments";

const moved: UrlChange = {
  workflow_id: "wf1",
  workflow_name: "Order intake",
  trigger: "webhook",
  from: "/api/hooks/wf1/qa",
  to: "/api/hooks/wf1/qa-two",
};

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setActiveOrgId(null);
});

describe("listEnvironments", () => {
  it("lists the workspace it is given, whichever is active, and the active one otherwise", async () => {
    const fetchMock = answer(200, { environments: [] });
    setActiveOrgId("org-a");

    await listEnvironments("org-b");
    await listEnvironments();
    await listEnvironments(null);

    const sent = fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["X-Org-Id"]);
    expect(sent).toEqual(["org-b", "org-a", "org-a"]);
  });
});

describe("renameEnvironment", () => {
  it("turns the service's 409 with url_changes into RenameMovesUrlsError carrying them", async () => {
    answer(409, { detail: "Renaming 'qa' to 'qa-two' changes the URL of …", url_changes: [moved] });

    const refused = renameEnvironment("e1", "qa-two").catch((e: unknown) => e);

    const error = await refused;
    expect(error).toBeInstanceOf(RenameMovesUrlsError);
    expect((error as RenameMovesUrlsError).changes).toEqual([moved]);
    expect((error as RenameMovesUrlsError).message).toBe("Renaming 'qa' to 'qa-two' changes the URL of …");
  });

  it("sends back exactly which trigger URLs the user confirmed moving", async () => {
    const fetchMock = answer(200, { id: "e1", name: "qa-two" });

    await renameEnvironment("e1", "qa-two", [moved]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/environments\/e1$/);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "qa-two",
      confirm_url_changes: [
        { workflow_id: "wf1", trigger: "webhook", from: "/api/hooks/wf1/qa", to: "/api/hooks/wf1/qa-two" },
      ],
    });
  });

  it("sends no confirmation on a first attempt", async () => {
    const fetchMock = answer(200, { id: "e1", name: "qa-two" });

    await renameEnvironment("e1", "qa-two");

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ name: "qa-two" });
  });
});
