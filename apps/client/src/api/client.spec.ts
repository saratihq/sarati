import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, absoluteApiUrl, asBranchMoved, getActiveOrgId, request, setActiveOrgId } from "@/api/client";
import { LOCAL_SESSION_COOKIE } from "@/lib/localSession";

// The base the module resolved at load: no NEXT_PUBLIC_API_URL under test ⇒ the dev fallback.
const API = "http://localhost:8001/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(response: Response | Error) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The URL and headers of the request the module actually issued. */
function requestedUrl(fetchMock: ReturnType<typeof mockFetch>): string {
  return fetchMock.mock.calls[0][0];
}

function headersOf(fetchMock: ReturnType<typeof mockFetch>): Record<string, string> {
  return fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
}

let navigatedTo: string[];
const realLocation = window.location;

beforeEach(() => {
  navigatedTo = [];
  // jsdom's `location.assign` is unforgeable AND refuses to navigate, so swap the whole object:
  // the 401 bounce to /login is behaviour worth asserting.
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      origin: realLocation.origin,
      protocol: realLocation.protocol,
      href: realLocation.href,
      assign: (url: string) => void navigatedTo.push(url),
    },
  });
  setActiveOrgId(null);
});

afterEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: realLocation });
  setActiveOrgId(null);
});

describe("absoluteApiUrl", () => {
  it("hangs a service-relative path off the API HOST, not off /api", () => {
    expect(absoluteApiUrl("/api/hooks/catch/abc")).toBe("http://localhost:8001/api/hooks/catch/abc");
  });

  it("strips only the trailing /api segment", () => {
    expect(absoluteApiUrl("/healthz")).toBe("http://localhost:8001/healthz");
  });
});

describe("request: URL building and headers", () => {
  it("prefixes the path with the resolved API base", async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));
    await request("/workflows?limit=1");
    expect(requestedUrl(fetchMock)).toBe(`${API}/workflows?limit=1`);
  });

  it("always sends JSON content-type and lets callers override headers", async () => {
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await request("/x", { headers: { "X-Custom": "1", "Content-Type": "text/plain" } });
    expect(headersOf(fetchMock)).toMatchObject({ "X-Custom": "1", "Content-Type": "text/plain" });
  });

  it("sends the bearer token from a local session", async () => {
    document.cookie = `${LOCAL_SESSION_COOKIE}=tok%2Fen; Path=/`;
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await request("/x");
    expect(headersOf(fetchMock).Authorization).toBe("Bearer tok/en");
  });

  it("sends no Authorization header when there is no session", async () => {
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await request("/x");
    expect(headersOf(fetchMock).Authorization).toBeUndefined();
  });

  it("sends X-Org-Id only for a non-personal org", async () => {
    setActiveOrgId("org_42");
    const withOrg = mockFetch(jsonResponse(200, {}));
    await request("/x");
    expect(headersOf(withOrg)["X-Org-Id"]).toBe("org_42");

    setActiveOrgId(null);
    const personal = mockFetch(jsonResponse(200, {}));
    await request("/x");
    expect(headersOf(personal)["X-Org-Id"]).toBeUndefined();
  });
});

describe("active organization", () => {
  it("round-trips through localStorage", () => {
    setActiveOrgId("org_1");
    expect(window.localStorage.getItem("orchestr:active-org")).toBe("org_1");
    expect(getActiveOrgId()).toBe("org_1");
  });

  it("clears the stored key on the personal org, so a stale selection heals", () => {
    setActiveOrgId("org_1");
    setActiveOrgId(null);
    expect(window.localStorage.getItem("orchestr:active-org")).toBeNull();
    expect(getActiveOrgId()).toBeNull();
  });
});

describe("request: response handling", () => {
  it("parses a JSON body", async () => {
    mockFetch(jsonResponse(200, { workflows: [], total: 0 }));
    await expect(request("/workflows")).resolves.toEqual({ workflows: [], total: 0 });
  });

  it("tolerates a bodyless 2xx instead of choking on empty JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));
    await expect(request("/workflows/w1")).resolves.toBeUndefined();
  });

  it("turns an unreachable server into plain-language advice, not a bare TypeError", async () => {
    mockFetch(new TypeError("Failed to fetch"));
    await expect(request("/x")).rejects.toThrow(/Can't reach the Sarati server/);
  });

  it("re-throws a non-network failure untouched", async () => {
    const boom = new RangeError("boom");
    mockFetch(boom);
    await expect(request("/x")).rejects.toBe(boom);
  });
});

describe("request: error translation", () => {
  it("carries status, machine code and the full body on ApiError", async () => {
    mockFetch(jsonResponse(409, { code: "branch_moved", detail: "head moved" }));
    const err = await request("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "branch_moved", message: "head moved" });
    expect((err as ApiError).body).toEqual({ code: "branch_moved", detail: "head moved" });
  });

  it.each([
    { label: "a string detail", body: { detail: "nope" }, message: "nope" },
    { label: "a validation detail array", body: { detail: [{ msg: "a" }, { msg: "b" }] }, message: "a; b" },
    { label: "a message field", body: { message: "from message" }, message: "from message" },
    { label: "an error field", body: { error: "from error" }, message: "from error" },
  ])("reads the human message out of $label", async ({ body, message }) => {
    mockFetch(jsonResponse(400, body));
    await expect(request("/x")).rejects.toThrow(message);
  });

  it.each([
    { label: "an empty detail array", body: { detail: [] } },
    { label: "a blank detail", body: { detail: "" } },
    { label: "an unrecognised shape", body: { whatever: 1 } },
    { label: "a bare array", body: [1, 2] },
  ])("falls back to the status when the body carries no message ($label)", async ({ body }) => {
    mockFetch(jsonResponse(500, body));
    await expect(request("/x")).rejects.toThrow("API error 500");
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("<html>502</html>", { status: 502, statusText: "Bad Gateway" }))),
    );
    await expect(request("/x")).rejects.toThrow("Bad Gateway");
  });

  it("ignores a non-string code rather than mistyping it", async () => {
    mockFetch(jsonResponse(400, { code: 42, detail: "x" }));
    const err = (await request("/x").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBeUndefined();
  });
});

describe("request: 401 handling", () => {
  it("drops the dead local session and bounces to /login", async () => {
    document.cookie = `${LOCAL_SESSION_COOKIE}=dead; Path=/`;
    mockFetch(jsonResponse(401, { detail: "expired" }));
    await expect(request("/x")).rejects.toThrow("expired");
    expect(document.cookie).not.toContain("dead");
    expect(navigatedTo).toEqual(["/login"]);
  });

  it("stays put when the caller owns the 401 — a sign-in form must keep its error", async () => {
    document.cookie = `${LOCAL_SESSION_COOKIE}=live; Path=/`;
    mockFetch(jsonResponse(401, { detail: "Incorrect email or password." }));
    await expect(request("/auth/local/login", { method: "POST" }, { redirectOn401: false })).rejects.toThrow(
      "Incorrect email or password.",
    );
    expect(navigatedTo).toEqual([]);
    expect(document.cookie).toContain("live");
  });
});

describe("asBranchMoved", () => {
  const body = {
    code: "branch_moved",
    current_head_version_id: "v9",
    current_head_version_number: 9,
    base_version_id: "v7",
  };

  it("narrows the 409 branch_moved payload", () => {
    expect(asBranchMoved(new ApiError("moved", 409, "branch_moved", body))).toEqual(body);
  });

  it.each([
    { label: "a non-ApiError", err: new Error("moved") },
    { label: "another status", err: new ApiError("moved", 400, "branch_moved", body) },
    { label: "another code", err: new ApiError("moved", 409, "conflict", body) },
    { label: "no body", err: new ApiError("moved", 409, "branch_moved", undefined) },
    { label: "a body missing the head id", err: new ApiError("moved", 409, "branch_moved", { ...body, current_head_version_id: undefined }) },
    { label: "a body with a non-numeric head number", err: new ApiError("moved", 409, "branch_moved", { ...body, current_head_version_number: "9" }) },
  ])("returns null for $label", ({ err }) => {
    expect(asBranchMoved(err)).toBeNull();
  });
});
