import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import OidcCallback from "@/components/OidcCallback";
import * as flow from "@/lib/oidcFlow";
import { toast } from "@/lib/toast";

const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  completeOidcSignIn: vi.fn(),
  completeOidcLink: vi.fn(),
  getLocalAuthStatus: vi.fn(),
}));
vi.mock("@/lib/oidcFlow", async (importOriginal) => ({
  ...(await importOriginal<typeof flow>()),
  beginOidcFlow: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const completeOidcSignIn = vi.mocked(api.completeOidcSignIn);
const completeOidcLink = vi.mocked(api.completeOidcLink);
const getLocalAuthStatus = vi.mocked(api.getLocalAuthStatus);
const beginOidcFlow = vi.mocked(flow.beginOidcFlow);

const CALLBACK = "/auth/oidc/callback";
const realLocation = window.location;
let navigatedTo: string[];
let replaceState: ReturnType<typeof vi.spyOn>;

const GRANT: api.LocalSessionGrant = {
  token: "t",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  user: { id: "u1", email: "a@example.com", name: "A" },
};

/** The provider sent this tab back with `query`; `pending` is what the tab remembered, if anything. */
function arrive(query: string, pending?: flow.OidcPending) {
  if (pending) flow.writePending(pending);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      origin: realLocation.origin,
      protocol: realLocation.protocol,
      pathname: CALLBACK,
      search: query,
      href: `${realLocation.origin}${CALLBACK}${query}`,
      assign: (url: string) => void navigatedTo.push(url),
    },
  });
}

const signIn = (over: Partial<flow.OidcPending> = {}): flow.OidcPending => ({
  binding: "bind-1",
  purpose: "sign_in",
  return_to: "/workflows/w1",
  state: "st-1",
  ...over,
});

beforeEach(() => {
  navigatedTo = [];
  replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  router.replace.mockReset();
  completeOidcSignIn.mockResolvedValue(GRANT);
  completeOidcLink.mockResolvedValue({ connected: true, email: "a@idp.example" });
  getLocalAuthStatus.mockResolvedValue({ enabled: false, awaiting_bootstrap: false, oidc: true });
  beginOidcFlow.mockResolvedValue();
  api.setActiveOrgId(null);
});

afterEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: realLocation });
});

describe("OidcCallback: finishing the flow this tab started", () => {
  it("shows a loader, strips the code from the address bar, and lands where the flow was headed", async () => {
    arrive("?code=c-1&state=st-1&iss=http%3A%2F%2Fidp.example", signIn());
    render(<OidcCallback />);

    expect(screen.getByText("Finishing sign-in...")).toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(null, "", CALLBACK);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/workflows/w1"));
    expect(completeOidcSignIn).toHaveBeenCalledWith({
      code: "c-1",
      state: "st-1",
      binding: "bind-1",
      iss: "http://idp.example",
    });
  });

  it("re-checks where to land, so a planted return_to cannot leave the origin", async () => {
    arrive("?code=c-1&state=st-1", signIn({ return_to: "/\\evil.example" }));
    render(<OidcCallback />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });

  it("enters the org an invite just joined with a full reload", async () => {
    completeOidcSignIn.mockResolvedValue({ ...GRANT, joined_org_id: "org-9" });
    arrive("?code=c-1&state=st-1", signIn({ return_to: "/join/inv-1", invite_token: "inv-1" }));
    render(<OidcCallback />);

    await waitFor(() => expect(navigatedTo).toEqual(["/"]));
    expect(api.getActiveOrgId()).toBe("org-9");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("sends the single-use code once, even when StrictMode mounts twice", async () => {
    arrive("?code=c-1&state=st-1", signIn());
    render(
      <StrictMode>
        <OidcCallback />
      </StrictMode>,
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(completeOidcSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("finishes a connect flow on the link route, never as a sign-in", async () => {
    arrive("?code=c-1&state=st-1", signIn({ purpose: "link", return_to: "/settings" }));
    render(<OidcCallback />);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/settings"));
    expect(completeOidcLink).toHaveBeenCalledWith({ code: "c-1", state: "st-1", binding: "bind-1" });
    expect(completeOidcSignIn).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Single sign-on connected", "You can now sign in as a@idp.example.");
  });
});

describe("OidcCallback: a flow this tab did not start", () => {
  it.each([
    ["nothing remembered", undefined],
    ["another flow's state", signIn({ state: "st-other" })],
    ["a flow that never got its state", signIn({ state: undefined })],
  ])("sends nothing for %s", async (_label, pending) => {
    arrive("?code=c-1&state=st-1", pending);
    render(<OidcCallback />);

    expect(await screen.findByRole("heading", { name: "This sign-in didn't start in this tab" })).toBeInTheDocument();
    expect(completeOidcSignIn).not.toHaveBeenCalled();
    expect(completeOidcLink).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument();
  });

  it("forgets the remembered flow, so reloading the callback cannot replay it", async () => {
    arrive("?code=c-1&state=st-1", signIn());
    render(<OidcCallback />);
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(flow.takePending()).toBeNull();
  });
});

describe("OidcCallback: the provider sent an error", () => {
  it("chooses the copy by the error code alone and never renders error_description", async () => {
    arrive("?error=access_denied&error_description=Call%20555-0100%20to%20restore%20access&state=st-1", signIn());
    render(<OidcCallback />);

    expect(await screen.findByText(/You cancelled at your identity provider/)).toBeInTheDocument();
    expect(screen.queryByText(/555-0100/)).not.toBeInTheDocument();
    expect(completeOidcSignIn).not.toHaveBeenCalled();
  });

  it("does not echo an error code it does not know", async () => {
    arrive("?error=%3Cb%3Ewire%20money%3C%2Fb%3E&state=st-1", signIn());
    render(<OidcCallback />);

    expect(await screen.findByText("It sent you back without a sign-in.")).toBeInTheDocument();
    expect(screen.queryByText(/wire money/)).not.toBeInTheDocument();
  });
});

describe("OidcCallback: the service refused", () => {
  it.each([
    ["oidc_state_invalid", 400, "This sign-in can't be finished", "Try again"],
    ["oidc_unavailable", 502, "Can't reach your identity provider", "Try again"],
    ["oidc_token_rejected", 401, "Sign-in couldn't be verified", "Try again"],
    ["oidc_email_unverified", 403, "This instance can't admit you", "Back to sign in"],
    ["oidc_email_missing", 403, "This instance can't admit you", "Back to sign in"],
    ["oidc_domain_not_allowed", 403, "This instance can't admit you", "Back to sign in"],
    ["oidc_disabled", 404, "Single sign-on isn't set up", "Back to sign in"],
    [undefined, 429, "Sign-in didn't finish", "Try again"],
  ])("%s (%i) gets its own copy and one action", async (code, status, title, action) => {
    completeOidcSignIn.mockRejectedValue(new api.ApiError("Service detail.", status, code));
    arrive("?code=c-1&state=st-1", signIn());
    render(<OidcCallback />);

    const heading = await screen.findByRole("heading", { name: title });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
  });

  it("names the claim when the email is unverified, in the service's own words", async () => {
    completeOidcSignIn.mockRejectedValue(
      new api.ApiError("Your identity provider did not confirm your email address (the email_verified claim).", 403, "oidc_email_unverified"),
    );
    arrive("?code=c-1&state=st-1", signIn());
    render(<OidcCallback />);
    expect(await screen.findByText(/the email_verified claim/)).toBeInTheDocument();
  });

  it("restarts single sign-on in this tab, carrying the invite and destination it started with", async () => {
    completeOidcSignIn.mockRejectedValue(new api.ApiError("x", 400, "oidc_state_invalid"));
    arrive("?code=c-1&state=st-1", signIn({ return_to: "/join/inv-1", invite_token: "inv-1" }));
    render(<OidcCallback />);

    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(beginOidcFlow).toHaveBeenCalledWith({ purpose: "sign_in", returnTo: "/join/inv-1", inviteToken: "inv-1" });
  });

  it("sends an existing account to its password when this instance has passwords on", async () => {
    getLocalAuthStatus.mockResolvedValue({ enabled: true, awaiting_bootstrap: false, oidc: true });
    completeOidcSignIn.mockRejectedValue(new api.ApiError("x", 409, "oidc_account_exists"));
    arrive("?code=c-1&state=st-1", signIn());
    render(<OidcCallback />);

    await userEvent.click(await screen.findByRole("button", { name: "Sign in with password" }));
    expect(router.replace).toHaveBeenCalledWith("/login?method=password");
  });

  it("names the operator for an existing account when passwords are off", async () => {
    completeOidcSignIn.mockRejectedValue(new api.ApiError("x", 409, "oidc_account_exists"));
    arrive("?code=c-1&state=st-1", signIn());
    render(<OidcCallback />);

    expect(await screen.findByText(/Ask an operator to connect single sign-on to it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument();
  });

  it.each(["oidc_identity_in_use", "oidc_already_linked", "oidc_token_rejected"])(
    "sends a failed connect (%s) back to Settings",
    async (code) => {
      completeOidcLink.mockRejectedValue(new api.ApiError("That identity already signs in to another account.", 409, code));
      arrive("?code=c-1&state=st-1", signIn({ purpose: "link", return_to: "/settings" }));
      render(<OidcCallback />);

      expect(await screen.findByRole("heading", { name: "Single sign-on wasn't connected" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Back to Settings" }));
      expect(router.replace).toHaveBeenCalledWith("/settings");
      expect(beginOidcFlow).not.toHaveBeenCalled();
    },
  );
});
