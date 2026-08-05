import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/api/client";
import ApiKeysSettings from "@/components/ApiKeysSettings";

vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const listApiKeys = vi.mocked(api.listApiKeys);
const createApiKey = vi.mocked(api.createApiKey);

const GRANTABLE = ["workflow:read", "workflow:deploy", "org:manage"];

const key = (over: Partial<api.ApiKeySummary> = {}): api.ApiKeySummary => ({
  id: "k1",
  name: "CI deploy",
  prefix: "ork_abc123",
  scopes: ["workflow:read"],
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

const createButton = () => screen.getByRole("button", { name: /Create key/ });

beforeEach(() => {
  listApiKeys.mockResolvedValue({ api_keys: [], grantable_scopes: GRANTABLE });
  createApiKey.mockResolvedValue({ id: "k9", name: "n", key: "ork_secret", prefix: "ork_secret", created_at: null });
});

describe("ApiKeysSettings", () => {
  it("offers the scopes the server grants, not a list of its own", async () => {
    listApiKeys.mockResolvedValue({ api_keys: [], grantable_scopes: ["workflow:read", "some:future:scope"] });
    render(<ApiKeysSettings />);

    expect(await screen.findByRole("checkbox", { name: "Read workflows" })).toBeInTheDocument();
    // An unlabelled scope still renders, so a server addition is never silently unofferable.
    expect(screen.getByRole("checkbox", { name: "some:future:scope" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Manage the organization" })).not.toBeInTheDocument();
  });

  it("refuses to create until the key is named and given at least one power", async () => {
    render(<ApiKeysSettings />);
    await screen.findByRole("checkbox", { name: "Read workflows" });

    expect(createButton()).toBeDisabled();
    expect(screen.getByText("Name the key")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "Key name" }), "CI deploy");
    expect(createButton()).toBeDisabled();
    expect(screen.getByText("Pick at least one thing it may do")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Read workflows" }));
    expect(createButton()).toBeEnabled();
  });

  it("sends exactly the scopes that were ticked", async () => {
    render(<ApiKeysSettings />);
    await screen.findByRole("checkbox", { name: "Read workflows" });

    await userEvent.type(screen.getByRole("textbox", { name: "Key name" }), "CI deploy");
    await userEvent.click(screen.getByRole("checkbox", { name: "Read workflows" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Publish, promote and merge" }));
    await userEvent.click(createButton());

    expect(createApiKey).toHaveBeenCalledWith("CI deploy", ["workflow:read", "workflow:deploy"]);
    expect(await screen.findByText("ork_secret")).toBeInTheDocument();
  });

  it("shows each key's powers, and flags a legacy full-access key for replacement", async () => {
    listApiKeys.mockResolvedValue({
      api_keys: [key({ id: "a", scopes: ["workflow:read"] }), key({ id: "b", name: "old", scopes: null })],
      grantable_scopes: GRANTABLE,
    });
    render(<ApiKeysSettings />);

    // Scoped to the list: the picker renders the same wording in its checkbox labels.
    expect(await screen.findByText("Read workflows", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText(/Full access — issued before keys carried scopes/)).toBeInTheDocument();
  });

  it("clears the picker after a key is issued, so the next key starts from nothing", async () => {
    render(<ApiKeysSettings />);
    await screen.findByRole("checkbox", { name: "Read workflows" });

    await userEvent.type(screen.getByRole("textbox", { name: "Key name" }), "CI deploy");
    await userEvent.click(screen.getByRole("checkbox", { name: "Read workflows" }));
    await userEvent.click(createButton());

    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Read workflows" })).not.toBeChecked());
    expect(createButton()).toBeDisabled();
  });
});
