import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import SignInSettings from "@/components/SignInSettings";
import * as flow from "@/lib/oidcFlow";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  authMe: vi.fn(),
  getLocalAuthStatus: vi.fn(),
  unlinkOidc: vi.fn(),
}));
vi.mock("@/lib/oidcFlow", async (importOriginal) => ({
  ...(await importOriginal<typeof flow>()),
  beginOidcFlow: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const authMe = vi.mocked(api.authMe);
const getLocalAuthStatus = vi.mocked(api.getLocalAuthStatus);
const unlinkOidc = vi.mocked(api.unlinkOidc);
const beginOidcFlow = vi.mocked(flow.beginOidcFlow);

function account(signIn: api.SignInMethods, passwordsOn = true) {
  authMe.mockResolvedValue({ user: { id: "u1", email: "a@example.com", name: "A" }, sign_in: signIn });
  getLocalAuthStatus.mockResolvedValue({ enabled: passwordsOn, awaiting_bootstrap: false, oidc: signIn.sso !== null });
}

beforeEach(() => {
  beginOidcFlow.mockResolvedValue();
  unlinkOidc.mockResolvedValue();
});

describe("SignInSettings", () => {
  it("is absent on an instance without single sign-on", async () => {
    account({ password: true, sso: null });
    const { container } = render(<SignInSettings />);
    await waitFor(() => expect(authMe).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("asks for the current password before connecting a password account", async () => {
    account({ password: true, sso: { connected: false, email: null } });
    render(<SignInSettings />);

    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(beginOidcFlow).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Current password"), "correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(beginOidcFlow).toHaveBeenCalledWith({
      purpose: "link",
      returnTo: "/settings",
      currentPassword: "correct horse battery",
    });
  });

  it("shows a refused password where it was typed", async () => {
    beginOidcFlow.mockRejectedValue(new api.ApiError("That password does not match this account.", 401, "invalid_credentials"));
    account({ password: true, sso: { connected: false, email: null } });
    render(<SignInSettings />);

    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await userEvent.type(screen.getByLabelText("Current password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That password does not match this account.");
  });

  it("shows who it is connected as, and disconnects after a confirm", async () => {
    account({ password: true, sso: { connected: true, email: "a@idp.example" } });
    render(<SignInSettings />);

    expect(await screen.findByText("Connected as a@idp.example")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(unlinkOidc).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ password: false, sso: { connected: true, email: "a@idp.example" } }, true, "It's the only way into your account."],
    [{ password: true, sso: { connected: true, email: "a@idp.example" } }, false, "Password sign-in is off on this instance, so it's your only way in."],
  ])("will not disconnect the only way in, and says why", async (signIn, passwordsOn, reason) => {
    account(signIn, passwordsOn);
    render(<SignInSettings />);

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  });

  it("shows a load failure with a retry instead of hiding the row", async () => {
    account({ password: true, sso: { connected: false, email: null } });
    authMe.mockRejectedValueOnce(new Error("Can't reach the Sarati server."));
    render(<SignInSettings />);

    expect(await screen.findByText("Can't reach the Sarati server.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Connect" })).toBeInTheDocument();
  });
});
