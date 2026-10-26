import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import JoinPage from "@/app/join/[token]/page";
import { clearLocalSession, writeLocalSession } from "@/lib/localSession";
import * as flow from "@/lib/oidcFlow";
import { useLocalAuthStatus } from "@/lib/useLocalAuthStatus";

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "inv-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  clerkEnabled: false,
}));
vi.mock("@/lib/useLocalAuthStatus", () => ({ useLocalAuthStatus: vi.fn() }));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  previewOrgInvite: vi.fn(),
  acceptOrgInvite: vi.fn(),
}));
vi.mock("@/lib/oidcFlow", async (importOriginal) => ({
  ...(await importOriginal<typeof flow>()),
  beginOidcFlow: vi.fn(),
}));

const statusHook = vi.mocked(useLocalAuthStatus);
const beginOidcFlow = vi.mocked(flow.beginOidcFlow);

function offer(enabled: boolean, oidc: boolean) {
  statusHook.mockReturnValue({ status: { enabled, awaiting_bootstrap: false, oidc }, error: null });
}

beforeEach(() => {
  vi.mocked(api.previewOrgInvite).mockResolvedValue({ org_id: "org-1", org_name: "Acme", role: "member" });
  beginOidcFlow.mockResolvedValue();
});

describe("JoinPage: an invitee with no session", () => {
  it("signs in through single sign-on carrying the invite, and comes back to it", async () => {
    offer(false, true);
    render(<JoinPage />);

    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue with single sign-on" }));
    expect(beginOidcFlow).toHaveBeenCalledWith({ purpose: "sign_in", returnTo: "/join/inv-1", inviteToken: "inv-1" });
  });

  it("offers the email form as the alternative when passwords are on too", async () => {
    offer(true, true);
    render(<JoinPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Create an account with email instead" }));
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account & join" })).toBeInTheDocument();
  });

  it("keeps the email form alone when single sign-on is off", async () => {
    offer(true, false);
    render(<JoinPage />);

    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with single sign-on" })).not.toBeInTheDocument();
  });
});

describe("JoinPage: a signed-in account", () => {
  beforeEach(() => {
    offer(true, true);
    writeLocalSession("a.b.c", new Date(Date.now() + 3_600_000).toISOString());
  });

  afterEach(() => clearLocalSession());

  it("says the invite is for another address without sending them for a fresh link", async () => {
    vi.mocked(api.acceptOrgInvite).mockRejectedValue(
      new api.ApiError(
        "This invite was sent to a different email address than a@example.com. Ask whoever invited you to invite that address, or sign in with the account the invite was sent to.",
        403,
        "invite_email_mismatch",
      ),
    );
    render(<JoinPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Join Acme" }));
    expect(await screen.findByText(/sent to a different email address than a@example.com/)).toBeInTheDocument();
    expect(screen.queryByText(/Ask whoever invited you for a fresh link/)).not.toBeInTheDocument();
  });

  it("asks for a fresh link when the invite is spent", async () => {
    vi.mocked(api.acceptOrgInvite).mockRejectedValue(new api.ApiError("Invite not found or expired", 404));
    render(<JoinPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Join Acme" }));
    expect(await screen.findByText("Invite not found or expired")).toBeInTheDocument();
    expect(screen.getByText(/Ask whoever invited you for a fresh link/)).toBeInTheDocument();
  });
});
