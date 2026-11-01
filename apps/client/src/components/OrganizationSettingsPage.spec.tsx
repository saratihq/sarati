import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import OrganizationSettingsPage from "@/components/OrganizationSettingsPage";
import { useAuth } from "@/store/useAuth";
import { useOrgs } from "@/store/useOrgs";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listOrgs: vi.fn(),
  authMe: vi.fn(),
  listOrgMembers: vi.fn(),
  listOrgInvites: vi.fn(),
}));

const P: api.OrgSummary = { id: "org-p", name: "Huzefa", is_personal: true, role: "owner" };
const A: api.OrgSummary = { id: "org-a", name: "Acme", is_personal: false, role: "owner" };
const ME = { id: "user-1", email: "huzefa@acme.test", name: "Huzefa" };

const listOrgs = vi.mocked(api.listOrgs);
const authMe = vi.mocked(api.authMe);
const unreachable = () => new Error("Can't reach the Sarati server. Check your connection, or try again in a moment.");
const serverError = () => new api.ApiError("Internal server error", 500);

const findError = () => screen.findByRole("heading", { name: "Couldn't load your workspaces" });
const queryError = () => screen.queryByRole("heading", { name: "Couldn't load your workspaces" });
const loader = () => screen.queryByRole("status", { name: "Loading" });
const tryAgain = () => screen.getByRole("button", { name: "Try again" });

// The org store's in-flight load is module-wide, so a list left open would stall every later test.
const unsettled: PromiseWithResolvers<{ orgs: api.OrgSummary[] }>[] = [];
function pendingList() {
  const list = Promise.withResolvers<{ orgs: api.OrgSummary[] }>();
  list.promise.catch(() => undefined);
  unsettled.push(list);
  return list;
}

function inWorkspace(orgId: string | null) {
  api.setActiveOrgId(orgId);
  useOrgs.setState({ orgs: [], loaded: false, activeOrgId: orgId });
}

beforeEach(() => {
  inWorkspace("org-a");
  useAuth.setState({ user: null, isProfileLoading: false });
  listOrgs.mockReset();
  authMe.mockReset().mockResolvedValue({ user: ME, sign_in: { password: true, sso: null } });
  vi.mocked(api.listOrgMembers).mockResolvedValue({
    members: [{ user_id: ME.id, email: ME.email, name: ME.name, role: "owner" }],
  });
  vi.mocked(api.listOrgInvites).mockResolvedValue({ invites: [] });
});

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  for (const list of unsettled.splice(0)) list.reject(new Error("the test ended"));
  await new Promise((r) => setTimeout(r, 0));
  api.setActiveOrgId(null);
});

describe("OrganizationSettingsPage: the workspace list can't load", () => {
  it.each([
    ["the service can't be reached", unreachable],
    ["the service errors", serverError],
  ])("says so when %s, with a way to try again, instead of loading forever", async (_case, failure) => {
    listOrgs.mockRejectedValue(failure());
    render(<OrganizationSettingsPage />);

    expect(await findError()).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sarati's server didn't answer as expected. Try again in a moment.",
    );
    expect(tryAgain()).toBeEnabled();
    expect(loader()).not.toBeInTheDocument();
  });

  it("loads again from the keyboard, and stays on the error, ready to retry, when that fails too", async () => {
    listOrgs.mockRejectedValueOnce(serverError());
    render(<OrganizationSettingsPage />);
    expect(await findError()).toBeInTheDocument();

    const retry = pendingList();
    listOrgs.mockReturnValueOnce(retry.promise);
    await userEvent.tab();
    await userEvent.tab();
    expect(tryAgain()).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    expect(loader()).toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();

    retry.reject(serverError());
    expect(await findError()).toBeInTheDocument();
    expect(loader()).not.toBeInTheDocument();
    expect(tryAgain()).toBeEnabled();
    expect(tryAgain()).toHaveFocus();
    expect(listOrgs).toHaveBeenCalledTimes(2);
  });

  it("keeps the loader up for a moment after a retry that is refused at once, then shows the error", async () => {
    listOrgs.mockRejectedValue(serverError());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<OrganizationSettingsPage />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(queryError()).toBeInTheDocument();

    fireEvent.click(tryAgain());

    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(loader()).toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(queryError()).toBeInTheDocument();
    expect(loader()).not.toBeInTheDocument();
    expect(tryAgain()).toHaveFocus();
  });

  it("shows the organization as soon as a retry gets through, without that wait", async () => {
    listOrgs.mockRejectedValueOnce(serverError()).mockResolvedValueOnce({ orgs: [P, A] });
    render(<OrganizationSettingsPage />);
    expect(await findError()).toBeInTheDocument();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(tryAgain());

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(loader()).not.toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();
  });

  it("shows the organization once a retry gets through, your own row included", async () => {
    listOrgs.mockRejectedValueOnce(unreachable()).mockResolvedValueOnce({ orgs: [P, A] });
    authMe.mockRejectedValueOnce(unreachable());
    render(<OrganizationSettingsPage />);
    expect(await findError()).toBeInTheDocument();

    await userEvent.click(tryAgain());

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
    expect(await screen.findByText("(you)")).toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();
    expect(authMe).toHaveBeenCalledTimes(2);
  });

  it("shows the personal workspace once a retry gets through there", async () => {
    inWorkspace(null);
    listOrgs.mockRejectedValueOnce(unreachable()).mockResolvedValueOnce({ orgs: [P, A] });
    render(<OrganizationSettingsPage />);
    expect(await findError()).toBeInTheDocument();

    await userEvent.click(tryAgain());

    expect(await screen.findByRole("heading", { name: "You're in your personal workspace" })).toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();
  });

  it("under React's development double run, the discarded run's failure shows no error while the kept run loads", async () => {
    const kept = pendingList();
    listOrgs
      .mockRejectedValueOnce(unreachable())
      .mockReturnValueOnce(kept.promise)
      .mockResolvedValueOnce({ orgs: [P, A] });
    render(
      <StrictMode>
        <OrganizationSettingsPage />
      </StrictMode>,
    );

    await vi.waitFor(() => expect(listOrgs).toHaveBeenCalledTimes(2));
    await act(() => Promise.resolve());
    expect(queryError()).not.toBeInTheDocument();
    expect(loader()).toBeInTheDocument();

    kept.reject(unreachable());
    expect(await findError()).toBeInTheDocument();

    await userEvent.click(tryAgain());
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();
  });
});

describe("OrganizationSettingsPage: the workspace list loads", () => {
  it("shows a loader, then the organization, and never the error", async () => {
    const list = pendingList();
    listOrgs.mockReturnValueOnce(list.promise);
    render(<OrganizationSettingsPage />);

    expect(loader()).toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();

    list.resolve({ orgs: [P, A] });
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();
    expect(listOrgs).toHaveBeenCalledTimes(1);
  });

  it("shows the personal workspace, and never the error", async () => {
    inWorkspace(null);
    listOrgs.mockResolvedValueOnce({ orgs: [P] });
    render(<OrganizationSettingsPage />);

    expect(await screen.findByRole("heading", { name: "You're in your personal workspace" })).toBeInTheDocument();
    expect(queryError()).not.toBeInTheDocument();
  });
});
