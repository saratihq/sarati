import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "@/api/agent";
import * as api from "@/api/client";
import Dashboard from "@/components/Dashboard";
import { refreshComposerAvailability } from "@/lib/useComposerAvailable";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/api/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof agent>()),
  composerStatus: vi.fn(),
}));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listWorkflows: vi.fn(),
}));

const composerStatus = vi.mocked(agent.composerStatus);
const listWorkflows = vi.mocked(api.listWorkflows);

beforeEach(() => {
  refreshComposerAvailability();
  listWorkflows.mockResolvedValue({ workflows: [], total: 0, has_more: false, offset: 0, limit: 50 });
});

describe("Dashboard on a fresh install", () => {
  it("keeps the first action brand blue when the instance has no composer", async () => {
    composerStatus.mockResolvedValue({ available: false, reason: "anthropic_api_key_missing" });
    render(<Dashboard />);

    expect(await screen.findByText("Build it on the canvas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New workflow" })).toHaveAttribute("data-variant", "ai");
  });
});
