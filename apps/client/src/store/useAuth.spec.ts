import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import { useAuth } from "@/store/useAuth";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  authMe: vi.fn(),
}));

const ME = { id: "user-1", email: "huzefa@acme.test", name: "Huzefa" };
const authMe = vi.mocked(api.authMe);
const unreachable = () => new Error("Can't reach the Sarati server. Check your connection, or try again in a moment.");

beforeEach(() => {
  authMe.mockReset();
  useAuth.setState({ user: null, isProfileLoading: false });
});

describe("useAuth.loadMe", () => {
  it("a load that fails leaves no profile and stops loading", async () => {
    authMe.mockRejectedValueOnce(unreachable());

    await useAuth.getState().loadMe();

    expect(useAuth.getState()).toMatchObject({ user: null, isProfileLoading: false });
  });

  it("an older load that fails after a newer one loaded the profile keeps that profile", async () => {
    const older = Promise.withResolvers<api.MeResponse>();
    authMe.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ user: ME, sign_in: { password: true, sso: null } });

    const first = useAuth.getState().loadMe();
    await useAuth.getState().loadMe();
    expect(useAuth.getState().user).toEqual(ME);

    older.reject(unreachable());
    await first;

    expect(useAuth.getState()).toMatchObject({ user: ME, isProfileLoading: false });
  });
});
