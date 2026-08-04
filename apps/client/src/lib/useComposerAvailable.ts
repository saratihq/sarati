"use client";

import { useEffect, useState } from "react";
import { composerStatus, type ComposerAvailability } from "@/api/agent";

/**
 * Whether this instance has the AI composer, probed ONCE per page load and
 * shared by every entry point — it is a property of the deployment, not of the
 * user or the workflow, and it cannot change while the tab is open.
 *
 * `null` means "still probing": callers render the composer as neither present
 * nor refused, so a slow probe never flashes a disabled state at an install
 * that has the composer.
 */
let cached: Promise<ComposerAvailability> | null = null;

function composerAvailability(): Promise<ComposerAvailability> {
  cached ??= composerStatus();
  return cached;
}

export function useComposerAvailable(): ComposerAvailability | null {
  const [state, setState] = useState<ComposerAvailability | null>(null);

  useEffect(() => {
    let live = true;
    void composerAvailability().then((a) => {
      if (live) setState(a);
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}

/** The one-line explanation beside a disabled entry point. */
export function composerDisabledHint(a: ComposerAvailability): string {
  return a.reason === "anthropic_api_key_missing"
    ? "AI composer needs an Anthropic API key — see docs"
    : a.reason === "caller_auth_unconfigured"
      ? "AI composer isn't configured on this instance — see docs"
      : "AI composer isn't available on this instance";
}
