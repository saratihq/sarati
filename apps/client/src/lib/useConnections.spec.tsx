import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import { useActiveConnections } from "@/lib/useConnections";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listConnections: vi.fn(),
}));

describe("useActiveConnections", () => {
  it("lands the list under StrictMode, whose dev-only remount re-runs every effect", async () => {
    vi.mocked(api.listConnections).mockResolvedValue({
      connections: [{ id: "conn-gmail", provider: "gmail", status: "active", auth_type: "managed" }],
    } as Awaited<ReturnType<typeof api.listConnections>>);

    const { result } = renderHook(() => useActiveConnections(), { wrapper: StrictMode });

    await waitFor(() => expect(result.current.connections?.map((c) => c.id)).toEqual(["conn-gmail"]));
  });
});
