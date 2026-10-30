import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import { useOrgs } from "@/store/useOrgs";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listOrgs: vi.fn(),
}));

const P: api.OrgSummary = { id: "org-p", name: "Huzefa", is_personal: true, role: "owner" };
const A: api.OrgSummary = { id: "org-a", name: "Acme", is_personal: false, role: "owner" };
const B: api.OrgSummary = { id: "org-b", name: "Beta", is_personal: false, role: "member" };

const listOrgs = vi.mocked(api.listOrgs);
const realLocation = window.location;
const reload = vi.fn();
const assign = vi.fn();

beforeEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: { reload, assign } });
  listOrgs.mockReset();
  api.setActiveOrgId(null);
  useOrgs.setState({ orgs: [], loaded: false, activeOrgId: null });
});

afterEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: realLocation });
});

describe("useOrgs.fetchOrgs", () => {
  it("a caller that asks while the list is loading waits for it", async () => {
    const list = Promise.withResolvers<{ orgs: api.OrgSummary[] }>();
    listOrgs.mockReturnValueOnce(list.promise);

    void useOrgs.getState().fetchOrgs();
    let loadedWhenDone: boolean | null = null;
    const second = useOrgs
      .getState()
      .fetchOrgs()
      .then(() => {
        loadedWhenDone = useOrgs.getState().loaded;
      });
    await new Promise((r) => setTimeout(r, 0));
    list.resolve({ orgs: [P, A] });
    await second;

    expect(loadedWhenDone).toBe(true);
    expect(listOrgs).toHaveBeenCalledTimes(1);
  });

  it("a forced load while one is in flight loads again once it lands", async () => {
    const first = Promise.withResolvers<{ orgs: api.OrgSummary[] }>();
    listOrgs.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ orgs: [P, A, B] });

    void useOrgs.getState().fetchOrgs();
    const forced = useOrgs.getState().fetchOrgs({ force: true });
    first.resolve({ orgs: [P, A] });
    await forced;

    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(useOrgs.getState().orgs.map((o) => o.id)).toEqual(["org-p", "org-a", "org-b"]);
  });

  it("a stale selection the service refuses is cleared, and the list still loads", async () => {
    api.setActiveOrgId("org-gone");
    useOrgs.setState({ activeOrgId: "org-gone" });
    listOrgs
      .mockRejectedValueOnce(new api.ApiError("Not a member of this organization", 403))
      .mockResolvedValueOnce({ orgs: [P, A] });

    await useOrgs.getState().fetchOrgs();

    expect(api.getActiveOrgId()).toBeNull();
    expect(window.localStorage.getItem("orchestr:active-org")).toBeNull();
    expect(useOrgs.getState()).toMatchObject({ loaded: true, activeOrgId: null });
    expect(useOrgs.getState().orgs).toHaveLength(2);
  });
});

describe("useOrgs.switchOrg", () => {
  beforeEach(() => {
    useOrgs.setState({ orgs: [P, A, B], loaded: true });
  });

  it("switching in place reloads the page it is on; otherwise it goes to the dashboard", () => {
    useOrgs.getState().switchOrg("org-b", { stay: true });
    expect(window.localStorage.getItem("orchestr:active-org")).toBe("org-b");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();

    useOrgs.getState().switchOrg("org-a");
    expect(window.localStorage.getItem("orchestr:active-org")).toBe("org-a");
    expect(assign).toHaveBeenCalledWith("/");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("switching to the personal workspace stores no selection", () => {
    api.setActiveOrgId("org-a");

    useOrgs.getState().switchOrg("org-p", { stay: true });

    expect(window.localStorage.getItem("orchestr:active-org")).toBeNull();
    expect(api.getActiveOrgId()).toBeNull();
  });
});
