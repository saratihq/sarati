import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ByoConnectForm from "@/components/ByoConnectForm";
import type { ByoApp } from "@/lib/byoConnect";

vi.mock("@/components/NodeIcon", () => ({ default: () => null }));

const ZENDESK_USERNAME = "{email}/token — your Zendesk email followed by /token, e.g. me@acme.com/token";

async function openForm(app: ByoApp): Promise<void> {
  render(<ByoConnectForm apps={[app]} envProviders={new Set()} onConnected={vi.fn()} />);
  await userEvent.click(screen.getByTestId(`byo-app-${app.slug}`));
}

describe("ByoConnectForm, basic auth", () => {
  it("tells the user what the app wants as the username and password, from its scheme", async () => {
    await openForm({
      slug: "zendesk",
      name: "Zendesk",
      scheme: { type: "basic", usernameHint: ZENDESK_USERNAME, passwordHint: "A Zendesk API token" },
    });

    expect(screen.getByTestId("byo-username")).toHaveAccessibleDescription(ZENDESK_USERNAME);
    expect(screen.getByTestId("byo-password")).toHaveAccessibleDescription("A Zendesk API token");
  });

  it("shows no hint when the scheme carries none", async () => {
    await openForm({ slug: "acme", name: "Acme", scheme: { type: "basic" } });

    expect(screen.getByTestId("byo-username")).not.toHaveAttribute("aria-describedby");
    expect(screen.getByTestId("byo-password")).not.toHaveAttribute("aria-describedby");
  });
});
