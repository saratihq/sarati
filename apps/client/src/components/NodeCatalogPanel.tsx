"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import * as api from "@/api/client";
import type { NodeTypeEntry } from "@/api/client";
import { SaratiLoader } from "./SaratiLogo";
import SupportBadge from "./SupportBadge";
import { InlineError } from "./ui/inline-error";

// One fetch per session — the built-in catalog (~1k actions) is static.
let catalogCache: NodeTypeEntry[] | null = null;
// Shared in-flight fetch — concurrent lookups must not each fire their own
// full-catalog request.
let catalogInFlight: Promise<NodeTypeEntry[]> | null = null;

/** Cached lookup for the inspector (schema by node_type). */
export async function catalogEntryFor(nodeType: string): Promise<NodeTypeEntry | null> {
  if (!catalogCache) {
    catalogInFlight ??= api.listNodeTypes("orchestr").then((res) => res.node_types);
    try {
      catalogCache = await catalogInFlight;
    } catch {
      return null;
    } finally {
      // A failed fetch must not poison later lookups — next call retries.
      catalogInFlight = null;
    }
  }
  return catalogCache.find((e) => e.type === nodeType) ?? null;
}

/** The build palette — search the action catalog and add steps; stays open across adds. */
export default function NodeCatalogPanel({
  onAdd,
  onClose,
}: {
  onAdd: (entry: NodeTypeEntry) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<NodeTypeEntry[] | null>(catalogCache);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const load = useCallback(() => {
    api
      .listNodeTypes("orchestr")
      .then((res) => {
        catalogCache = res.node_types;
        if (!alive.current) return;
        setEntries(res.node_types);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : "Failed to load the step catalog");
      });
  }, []);

  useEffect(() => {
    if (!catalogCache) load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return entries.slice(0, 50);
    return entries
      .filter((e) => `${e.name} ${e.category} ${e.description}`.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [entries, q]);

  return (
    <div
      className="w-[300px] shrink-0 rounded-xl flex flex-col min-h-0"
      style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span className="text-[12px] font-semibold flex-1" style={{ color: "var(--orchestr-ink)" }}>
          Add a step
        </span>
        <button
          onClick={onClose}
          aria-label="Close catalog"
          className="bg-transparent border-none p-0 cursor-pointer"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          <X size={14} />
        </button>
      </div>
      <div className="px-3.5 pb-2">
        <div
          className="flex items-center gap-2 h-8 px-2.5 rounded-lg"
          style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)" }}
        >
          <Search size={12} style={{ color: "var(--orchestr-ink-subtle)" }} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search apps and actions…"
            aria-label="Search the step catalog"
            className="flex-1 bg-transparent border-none outline-none text-[12px]"
            style={{ color: "var(--orchestr-ink)" }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        {error ? (
          <InlineError
            message={error}
            onRetry={() => {
              setError(null);
              load();
            }}
          />
        ) : entries === null ? (
          <div className="flex justify-center py-8">
            <SaratiLoader size={24} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-[12px] px-2 py-4" style={{ color: "var(--orchestr-ink-muted)" }}>
            No matching steps.
          </div>
        ) : (
          filtered.map((e) => (
            <button
              key={e.type}
              onClick={() => onAdd(e)}
              // Instant tiers show no badge, but the reason stays as the row tooltip.
              title={e.support?.reason}
              className="w-full text-left rounded-lg px-2.5 py-2 cursor-pointer bg-transparent hover:bg-[rgba(255,255,255,0.04)] border-none block"
            >
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium truncate" style={{ color: "var(--orchestr-ink)" }}>
                  {e.name}
                </span>
                <span
                  className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase shrink-0"
                  style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
                >
                  {e.category}
                </span>
                <SupportBadge support={e.support} />
              </div>
              {e.description && (
                <div className="text-[11px] mt-0.5 truncate" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  {e.description}
                </div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
