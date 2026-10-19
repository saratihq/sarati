"use client";

import { useEffect, useMemo } from "react";
import { useWorkflow } from "@/store/useWorkflow";
import { useNodeIcons } from "@/store/useNodeIcons";
import { appDisplayName } from "@/lib/connections";
import { useStepAccounts } from "@/store/useStepAccounts";
import ConnectAppButton from "./ConnectAppButton";
import NodeIcon from "./NodeIcon";

interface IrNodeShape {
  id: string;
  node_type?: string;
}

/** A Connect chip per app a step has no account for; never writes to the canvas, never blocks Create/Deploy. */
export default function ConnectCaptureBanner() {
  const workflowJson = useWorkflow((s) => s.workflowJson);
  const nodes = useMemo(() => (workflowJson?.nodes as IrNodeShape[] | undefined) ?? [], [workflowJson]);
  const { steps } = useStepAccounts();

  // App steps only: an AI Agent's model account is your own credentials, chosen on the agent itself.
  const unconnected = useMemo(() => {
    const apps = nodes
      .filter((n) => n.node_type?.includes(".") && steps[n.id]?.state === "none")
      .map((n) => steps[n.id]!.app);
    return [...new Set(apps)];
  }, [steps, nodes]);

  useEffect(() => {
    if (unconnected.length > 0) {
      void useNodeIcons.getState().fetchIcons(unconnected.map((app) => `${app}.connection`));
    }
  }, [unconnected]);

  if (unconnected.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="connect-capture-banner"
      className="flex items-center flex-wrap gap-x-3 gap-y-2 rounded-xl px-3.5 py-2.5 mt-3"
      style={{ background: "var(--orchestr-accent-tint)", border: "1px solid var(--orchestr-line)" }}
    >
      <span className="text-[12px]" style={{ color: "var(--orchestr-ink-muted)" }}>
        <span className="font-semibold" style={{ color: "var(--orchestr-ink)" }}>
          {unconnected.length === 1 ? "1 app needs connecting" : `${unconnected.length} apps need connecting`}
        </span>{" "}
        — those steps will run as the account you connect.
      </span>
      {unconnected.map((app) => (
        <ConnectAppButton
          key={app}
          app={app}
          appName={appDisplayName(app)}
          size="xs"
          variant="secondary"
          data-testid={`connect-app-${app}`}
        >
          <NodeIcon nodeType={`${app}.connection`} size={12} />
          Connect {appDisplayName(app)}
        </ConnectAppButton>
      ))}
    </div>
  );
}
