import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import {
  OidcBrowserError,
  beginOidcFlow,
  bindingHash,
  createBinding,
  takePending,
  writePending,
} from "@/lib/oidcFlow";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  startOidcSignIn: vi.fn(),
  startOidcLink: vi.fn(),
}));

const startOidcSignIn = vi.mocked(api.startOidcSignIn);
const startOidcLink = vi.mocked(api.startOidcLink);

const PENDING_KEY = "sarati:oidc-pending";
const realLocation = window.location;
let navigatedTo: string[];

beforeEach(() => {
  navigatedTo = [];
  // jsdom's `location.assign` is unforgeable and refuses to navigate, so swap the whole object.
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: realLocation.origin, assign: (url: string) => void navigatedTo.push(url) },
  });
  startOidcSignIn.mockResolvedValue({ authorize_url: "https://idp.example/authorize?x=1", state: "st-1" });
  startOidcLink.mockResolvedValue({ authorize_url: "https://idp.example/authorize?x=2", state: "st-2" });
});

afterEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: realLocation });
});

async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("the binding", () => {
  it("is 32 random bytes as 43 base64url characters, fresh every time", () => {
    const a = createBinding();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createBinding()).not.toBe(a);
  });

  it("hashes to base64url(sha256), the shape the service checks", async () => {
    expect(await bindingHash("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});

describe("the pending record", () => {
  it("is read once: a reload or a second tab finds nothing to replay", () => {
    writePending({ binding: "b", purpose: "sign_in", return_to: "/x", state: "s" });
    expect(takePending()).toEqual({ binding: "b", purpose: "sign_in", return_to: "/x", state: "s" });
    expect(takePending()).toBeNull();
  });

  it("ignores a record that is not one of ours", () => {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ binding: 1, purpose: "sign_in", return_to: "/" }));
    expect(takePending()).toBeNull();
    window.sessionStorage.setItem(PENDING_KEY, "{not json");
    expect(takePending()).toBeNull();
  });

  it("says plainly when storage is blocked, instead of starting a flow that can never finish", () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => writePending({ binding: "b", purpose: "sign_in", return_to: "/" })).toThrow(OidcBrowserError);
  });
});

describe("beginOidcFlow", () => {
  it("sends only the binding's hash, keeps the binding in this tab, and leaves for the provider", async () => {
    await beginOidcFlow({ purpose: "sign_in", returnTo: "/workflows/w1", inviteToken: "inv-1" });

    const [sentHash, sentInvite] = startOidcSignIn.mock.calls[0];
    const pending = JSON.parse(window.sessionStorage.getItem(PENDING_KEY)!);
    expect(sentHash).toBe(await sha256Base64url(pending.binding));
    expect(sentHash).not.toBe(pending.binding);
    expect(sentInvite).toBe("inv-1");
    expect(pending).toMatchObject({ purpose: "sign_in", return_to: "/workflows/w1", invite_token: "inv-1", state: "st-1" });
    expect(navigatedTo).toEqual(["https://idp.example/authorize?x=1"]);
  });

  it("starts a link flow with the current password", async () => {
    await beginOidcFlow({ purpose: "link", returnTo: "/settings", currentPassword: "pw" });
    expect(startOidcLink).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), "pw");
    expect(JSON.parse(window.sessionStorage.getItem(PENDING_KEY)!)).toMatchObject({ purpose: "link", state: "st-2" });
  });

  it("leaves nothing pending and stays put when the service refuses to start", async () => {
    startOidcSignIn.mockRejectedValue(new api.ApiError("down", 502, "oidc_unavailable"));
    await expect(beginOidcFlow({ purpose: "sign_in", returnTo: "/" })).rejects.toThrow("down");
    expect(window.sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(navigatedTo).toEqual([]);
  });

  it("sends nothing when storage is blocked", async () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await expect(beginOidcFlow({ purpose: "sign_in", returnTo: "/" })).rejects.toThrow(OidcBrowserError);
    expect(startOidcSignIn).not.toHaveBeenCalled();
  });
});
