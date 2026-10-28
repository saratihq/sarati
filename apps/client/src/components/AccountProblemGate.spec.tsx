import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import { AccountProblemGate } from "@/components/AccountProblemGate";
import { useAccountProblem } from "@/store/useAccountProblem";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  linkClerkAccount: vi.fn(),
  signOut: vi.fn(),
}));

const linkClerkAccount = vi.mocked(api.linkClerkAccount);
const signOut = vi.mocked(api.signOut);
const realLocation = window.location;
let reloads: number;

const renderGate = () =>
  render(
    <AccountProblemGate>
      <p>The app</p>
    </AccountProblemGate>,
  );

beforeEach(() => {
  reloads = 0;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { ...realLocation, reload: () => void reloads++ },
  });
  useAccountProblem.getState().clear();
});

afterEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: realLocation });
});

describe("AccountProblemGate", () => {
  it("renders the app while the session has an account", () => {
    renderGate();
    expect(screen.getByText("The app")).toBeInTheDocument();
  });

  it("links the existing account by its password, then starts over as it", async () => {
    linkClerkAccount.mockResolvedValue({ user: { id: "u1", email: "a@b.co", name: "A" } });
    useAccountProblem.getState().report({ code: "account_link_required", detail: "exists", email: "a@b.co" });
    renderGate();

    expect(screen.queryByText("The app")).not.toBeInTheDocument();
    expect(screen.getByText("An account for a@b.co already exists here")).toBeInTheDocument();
    const link = screen.getByRole("button", { name: "Link account" });
    expect(link).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Password"), "the-password{Enter}");

    await waitFor(() => expect(reloads).toBe(1));
    expect(linkClerkAccount).toHaveBeenCalledWith("the-password");
    expect(useAccountProblem.getState().problem).toBeNull();
  });

  it("says why a link was refused and lets the person try again", async () => {
    linkClerkAccount.mockRejectedValue(new api.ApiError("That password does not match the account for a@b.co.", 401));
    useAccountProblem.getState().report({ code: "account_link_required", detail: "exists", email: "a@b.co" });
    renderGate();

    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Link account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That password does not match");
    expect(screen.getByRole("button", { name: "Link account" })).toBeEnabled();
    expect(reloads).toBe(0);
  });

  it("shows the service's reason for a refused sign-in, with sign out as the way on", async () => {
    signOut.mockResolvedValue();
    useAccountProblem.getState().report({
      code: "provisioning_failed",
      detail: "Another account here already uses x@y.co, so this sign-in cannot make one.",
    });
    renderGate();

    expect(screen.getByRole("alert")).toHaveTextContent("Another account here already uses x@y.co");
    expect(screen.queryByRole("button", { name: "Link account" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAccountProblem.getState().problem).toBeNull();
    expect(screen.getByText("The app")).toBeInTheDocument();
  });
});
