import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as api from "@/api/client";
import LocalAuthGate, { type LocalAuthVariant } from "@/components/LocalAuthGate";
import { useLocalAuthStatus } from "@/lib/useLocalAuthStatus";

const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  clerkEnabled: false,
}));
vi.mock("@/lib/useLocalAuthStatus", () => ({ useLocalAuthStatus: vi.fn() }));

const statusHook = vi.mocked(useLocalAuthStatus);

function offer(status: Partial<api.LocalAuthStatus>) {
  statusHook.mockReturnValue({
    status: { enabled: false, awaiting_bootstrap: false, oidc: false, ...status },
    error: null,
  });
}

/** The screen's primary actions: the brand-blue `ai` button is the hero action, and there is one. */
const primaries = () => document.querySelectorAll('[data-slot="button"][data-variant="ai"]');

beforeEach(() => router.replace.mockReset());
afterEach(() => window.history.replaceState(null, "", "/"));

describe("LocalAuthGate: exactly one primary action on every screen", () => {
  const methods = [
    { password: true, sso: false },
    { password: false, sso: true },
    { password: true, sso: true },
  ];
  const variants: LocalAuthVariant[] = ["signin", "signup", "reset"];

  for (const { password, sso } of methods) {
    for (const bootstrap of [false, true]) {
      for (const variant of variants) {
        const label = `password ${password ? "on" : "off"}, sso ${sso ? "on" : "off"}, ${bootstrap ? "first run" : "after"}, ${variant}`;
        it(label, () => {
          offer({ enabled: password, oidc: sso, awaiting_bootstrap: bootstrap });
          render(<LocalAuthGate variant={variant}>clerk</LocalAuthGate>);
          const notice = variant === "reset" || (variant === "signup" && !bootstrap && !sso);
          expect(primaries()).toHaveLength(notice ? 0 : 1);
          if (notice) expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument();
        });
      }
    }
  }

  it("neither method: names the variables to set, single sign-on's included", () => {
    offer({});
    render(<LocalAuthGate variant="signin">clerk</LocalAuthGate>);
    expect(screen.getByText(/OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET/)).toBeInTheDocument();
    expect(primaries()).toHaveLength(0);
  });
});

describe("LocalAuthGate: single sign-on", () => {
  it("leads with single sign-on, and swaps to the password form and back", async () => {
    offer({ enabled: true, oidc: true });
    render(<LocalAuthGate variant="signin">clerk</LocalAuthGate>);

    expect(screen.getByRole("button", { name: "Continue with single sign-on" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use email and password instead" }));
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with single sign-on" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use single sign-on instead" }));
    expect(screen.getByRole("button", { name: "Continue with single sign-on" })).toBeInTheDocument();
  });

  it("opens on the password form when sent there to sign in with a password", () => {
    window.history.replaceState(null, "", "/login?method=password");
    offer({ enabled: true, oidc: true });
    render(<LocalAuthGate variant="signin">clerk</LocalAuthGate>);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("honours a client-side arrival, whose address lands only after the first render", () => {
    statusHook.mockReturnValue({ status: null, error: null });
    const { rerender } = render(<LocalAuthGate variant="signin">clerk</LocalAuthGate>);
    window.history.replaceState(null, "", "/login?method=password");
    offer({ enabled: true, oidc: true });
    rerender(<LocalAuthGate variant="signin">clerk</LocalAuthGate>);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("offers no password form when passwords are off, whatever the address says", () => {
    window.history.replaceState(null, "", "/login?method=password");
    offer({ oidc: true });
    render(<LocalAuthGate variant="signin">clerk</LocalAuthGate>);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /email and password/ })).not.toBeInTheDocument();
  });

  it("says the first sign-in becomes the owner, and that everyone after gets an account but no org", () => {
    offer({ oidc: true, awaiting_bootstrap: true });
    render(<LocalAuthGate variant="signin">clerk</LocalAuthGate>);
    expect(screen.getByText(/the account you sign in with becomes this instance's owner/)).toBeInTheDocument();
    expect(screen.getByText(/Joining an organization still takes an invite/)).toBeInTheDocument();
  });

  it("says honestly that signing out of Sarati leaves the identity provider signed in", () => {
    window.history.replaceState(null, "", "/login?signed_out=1");
    offer({ oidc: true });
    render(<LocalAuthGate variant="signin">clerk</LocalAuthGate>);
    expect(screen.getByText("Signed out of Sarati — your identity provider may still be signed in.")).toBeInTheDocument();
  });

  it("points a password reset at the identity provider when passwords are off", () => {
    offer({ oidc: true });
    render(<LocalAuthGate variant="reset">clerk</LocalAuthGate>);
    expect(screen.getByRole("heading", { name: "Reset it at your identity provider" })).toBeInTheDocument();
  });
});
