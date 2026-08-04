"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { connectAppWithFeedback } from "@/lib/managedConnect";

/** THE Connect-an-app button (popup → provider sign-in → poll → toast) — every surface renders this one. */
export default function ConnectAppButton({
  app,
  appName,
  onConnected,
  children,
  ...buttonProps
}: {
  /** App slug the service links (e.g. "slack", "google-sheets"). */
  app: string;
  /** Display name for copy ("Connect Slack", "Connected Slack"). */
  appName: string;
  /** Fires on success with the new connection id (refresh lists, attach to steps…). */
  onConnected: (connectionId: string) => void;
} & Omit<ComponentProps<typeof Button>, "onClick" | "children"> & { children?: React.ReactNode }) {
  const [connecting, setConnecting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const connect = async () => {
    if (connecting) return;
    setConnecting(true);
    const connectionId = await connectAppWithFeedback(app, appName);
    // The popup can outlive the surface that opened it, so only touch state while mounted.
    if (mounted.current) setConnecting(false);
    if (connectionId) onConnected(connectionId);
  };

  return (
    <Button {...buttonProps} onClick={() => void connect()} disabled={connecting || buttonProps.disabled}>
      {connecting ? "Waiting for sign-in…" : (children ?? `Connect ${appName}`)}
    </Button>
  );
}
