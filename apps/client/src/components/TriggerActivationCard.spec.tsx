import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TriggerActivationHealth } from "@/api/client";
import TriggerActivationCard from "@/components/TriggerActivationCard";

const nodes = [{ id: "watch", node_type: "slack.new_channel", metadata: { trigger: true } }];

const REFUSAL =
  "production has no slack account assigned, so \"When a channel is created\" can't run there — an owner assigns one under Integrations → Environments";

const HELD_POLL =
  "production's slack account isn't active, so \"When a channel is created\" is held: it isn't polled, and picks up from where it stopped once the account is active again — the account's owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments";

const HELD_WEBHOOK =
  "production's stripe account isn't active, so \"When a customer signs up\" is held: what stripe sends still starts runs, and nothing is changed at stripe until the account is active again — the account's owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments";

const activation = (over: Partial<TriggerActivationHealth>): TriggerActivationHealth => ({
  environment: "production",
  environment_id: "env-production",
  trigger_type: "slack.new_channel",
  kind: "polling",
  active: true,
  held_back_by_slot: false,
  listening: true,
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
    card([activation({ held_back_by_slot: true, listening: false, status: "error", last_error: REFUSAL })]);

    expect(screen.getByText("Not listening")).toBeTruthy();
    expect(screen.getByText(REFUSAL)).toBeTruthy();
    expect(screen.queryByText(/^Live/)).toBeNull();
    expect(screen.queryByText(/Last run failed/)).toBeNull();
    expect(screen.queryByText("Not polled yet")).toBeNull();
  });

  it("names the environment it is held back in while it listens in another", () => {
    const staging = REFUSAL.replace("production", "staging");
    card([
      activation({ last_polled_at: new Date().toISOString() }),
      activation({
        environment: "staging",
        environment_id: "env-staging",
        held_back_by_slot: true,
        listening: false,
        status: "error",
        last_error: staging,
      }),
    ]);

    expect(screen.getByText("Not listening in staging")).toBeTruthy();
    expect(screen.getByText(staging)).toBeTruthy();
    expect(screen.getByText(/^Last checked/)).toBeTruthy();
    expect(screen.queryByText(/Last run failed/)).toBeNull();
  });

  it("shows a held poll as not listening, saying it picks up from where it stopped", () => {
    card([activation({ held_back_by_slot: true, listening: false, status: "error", last_error: HELD_POLL })]);

    expect(screen.getByText("Not listening")).toBeTruthy();
    expect(screen.getByText(HELD_POLL)).toBeTruthy();
    expect(screen.queryByText(/^Held/)).toBeNull();
    expect(screen.queryByText(/Last run failed/)).toBeNull();
  });

  it("shows a held webhook, whose app's deliveries still run, as held and never as not listening", () => {
    render(
      <TriggerActivationCard
        nodes={[{ id: "watch", node_type: "stripe.new_customer", metadata: { trigger: true } }]}
        liveVersion={1}
        hasUnpublished={false}
        health={[
          activation({
            trigger_type: "stripe.new_customer",
            kind: "registered_webhook",
            held_back_by_slot: true,
            listening: true,
            status: "error",
            last_error: HELD_WEBHOOK,
          }),
        ]}
      />,
    );

    expect(screen.getByText("Held")).toBeTruthy();
    expect(screen.getByText(HELD_WEBHOOK)).toBeTruthy();
    expect(screen.queryByText(/Not listening/)).toBeNull();
    expect(screen.queryByText(/^Live/)).toBeNull();
    expect(screen.queryByText(/Last run failed/)).toBeNull();
  });

  it("names the environment a trigger is held in while it listens unheld in another", () => {
    card([
      activation({ last_polled_at: new Date().toISOString() }),
      activation({
        environment: "staging",
        environment_id: "env-staging",
        kind: "composio_subscription",
        held_back_by_slot: true,
        listening: true,
        status: "error",
        last_error: HELD_WEBHOOK,
      }),
    ]);

    expect(screen.getByText("Held in staging")).toBeTruthy();
    expect(screen.getByText(/^Last checked/)).toBeTruthy();
  });

  it("shows a trigger whose stand-up failed as not listening, with the app's error, never as live", () => {
    card([activation({ status: "error", listening: false, last_error: "slack refused the stand-up" })]);

    expect(screen.getByText("Not listening")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.getByText(/slack refused the stand-up/)).toBeTruthy();
  });

  it("shows a listening trigger whose last poll failed as live, with the failure", () => {
    card([activation({ status: "error", last_polled_at: new Date().toISOString(), last_error: "Slack answered 500" })]);

    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Last run failed: Slack answered 500")).toBeTruthy();
  });
});
