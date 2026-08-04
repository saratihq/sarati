"use client";

import { useEffect, useState } from "react";
import * as api from "@/api/client";

/** What sign-in the service offers (ADR 0054); `status` stays null until the answer lands. */
export interface LocalAuthGateState {
  status: api.LocalAuthStatus | null;
  /** Set when the service couldn't be asked — the caller decides what to fall back to. */
  error: string | null;
}

/** Ask the service whether it offers email + password sign-in, once per mount. */
export function useLocalAuthStatus(): LocalAuthGateState {
  const [state, setState] = useState<LocalAuthGateState>({ status: null, error: null });

  useEffect(() => {
    let alive = true;
    api
      .getLocalAuthStatus()
      .then((status) => alive && setState({ status, error: null }))
      .catch((e: unknown) =>
        alive &&
        setState({
          status: null,
          error: e instanceof Error ? e.message : "Couldn't reach the Sarati server.",
        }),
      );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
