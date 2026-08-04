"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/api/client";
import type { Connection } from "@/api/client";
import { activeConnections } from "@/lib/connections";

export interface ActiveConnections {
  /** null = not loaded yet (or the load failed); [] = loaded and genuinely empty. */
  connections: Connection[] | null;
  error: string | null;
  reload: () => void;
}

/**
 * THE account list behind every connection picker. Active-only: a pending/failed row hard-errors at
 * run time, so it must never be offered. A failure leaves `connections` null and sets `error`, so
 * callers can't render "no accounts" over a fetch that never landed.
 */
export function useActiveConnections(enabled = true): ActiveConnections {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const reload = useCallback(() => {
    api
      .listConnections()
      .then(({ connections: rows }) => {
        if (!alive.current) return;
        setConnections(activeConnections(rows));
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : "Couldn't load your connections");
      });
  }, []);

  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  return { connections, error, reload };
}
