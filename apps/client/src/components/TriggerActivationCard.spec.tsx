import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TriggerActivationHealth } from "@/api/client";
import TriggerActivationCard from "@/components/TriggerActivationCard";

const nodes = [{ id: "watch", node_type: "slack.new_channel", metadata: { trigger: true } }];

const REFUSAL =
  "production's slack account isn't active, so \"When a channel is created\" can't run there — its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments";

const activation = (over: Partial<TriggerActivationHealth>): TriggerActivationHealth => ({
  environment: "production",
  environment_id: "env-production",
  trigger_type: "slack.new_channel",
  kind: "polling",
  active: true,
  held_back_by_slot: false,
  status: "ok",
  last_polled_at: null,
  last_error: null,
  updated_at: null,
  ...over,
});

const card = (health: TriggerActivationHealth[]) =>
  render(<TriggerActivationCard nodes={nodes} liveVersion={1} hasUnpublished={false} health={health} />);

describe("TriggerActivationCard", () => {
  it("shows a trigger its environment's account holds back as not listening, giving the reason and its fix, never as a failed run", () => {
    card([activation({ held_back_by_slot: true, status: "error", last_error: REFUSAL })]);

    expect(screen.getByText("Not listening")).toBeTruthy();
    expect(screen.getByText(REFUSAL)).toBeTruthy();
    expect(screen.queryByText(/^Live/)).toBeNull();
    expect(screen.queryByText(/Last run failed/)).toBeNull();
    expect(screen.queryByText("Not polled yet")).toBeNull();
  });

  it("names the environment it is held back in while it listens in another", () => {
    const staging = REFUSAL.replace("production's", "staging's");
    card([
      activation({ last_polled_at: new Date().toISOString() }),
      activation({
        environment: "staging",
        environment_id: "env-staging",
        held_back_by_slot: true,
        status: "error",
        last_error: staging,
      }),
    ]);

    expect(screen.getByText("Not listening in staging")).toBeTruthy();
    expect(screen.getByText(staging)).toBeTruthy();
    expect(screen.getByText(/^Last checked/)).toBeTruthy();
    expect(screen.queryByText(/Last run failed/)).toBeNull();
  });

  it("shows a listening trigger whose last poll failed as live, with the failure", () => {
    card([activation({ status: "error", last_polled_at: new Date().toISOString(), last_error: "Slack answered 500" })]);

    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Last run failed: Slack answered 500")).toBeTruthy();
  });
});
