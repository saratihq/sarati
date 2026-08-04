"use client";

import { Component, type ReactNode } from "react";
import { SaratiMark } from "./SaratiLogo";
import { Button } from "./ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Top-level render-crash net: shows the error plus a reload action instead of a white screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Render crash caught by ErrorBoundary:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-5 px-6 text-center"
        style={{ background: "var(--orchestr-surface)" }}
      >
        <SaratiMark size={40} />
        <div>
          <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--orchestr-ink)" }}>
            Something went wrong
          </h1>
          <p className="text-sm" style={{ color: "var(--orchestr-ink-muted)" }}>
            The page hit an unexpected error. Reloading usually fixes it — your work on the server is safe.
          </p>
        </div>
        <pre
          className="max-w-[560px] w-full overflow-auto text-left text-xs rounded-xl p-4"
          style={{
            background: "var(--orchestr-surface-card)",
            border: "1px solid var(--orchestr-line)",
            color: "var(--orchestr-ink-subtle)",
            fontFamily: "'Fira Code', ui-monospace, monospace",
          }}
        >
          {this.state.error.message}
        </pre>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}