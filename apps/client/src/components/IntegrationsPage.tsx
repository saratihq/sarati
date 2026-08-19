"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import * as api from "@/api/client";
import type { Connection } from "@/api/client";
import ConnectionsDialog from "@/components/ConnectionsDialog";
import EnvironmentsSettings from "@/components/EnvironmentsSettings";
import NodeIcon from "@/components/NodeIcon";
import { PageHeader } from "@/components/ui/page-header";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useNodeIcons } from "@/store/useNodeIcons";

/** Integrations surface: default connection pool + per-env slots; `?picker=0` skips auto-open. */
export default function IntegrationsPage() {
  useDocumentTitle("Integrations");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [poolOpen, setPoolOpen] = useState(searchParams.get("picker") !== "0");
  // Bumped on dialog close to remount Environments, so slot pickers see accounts added there.
  const [envEpoch, setEnvEpoch] = useState(0);

  const back = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--orchestr-surface)" }}>
      <PageHeader title="Integrations" backLabel="Back" onBack={back} />

      <div className="max-w-[560px] mx-auto py-10 px-4">
        <DefaultPool epoch={envEpoch} onManage={() => setPoolOpen(true)} />
        <EnvironmentsSettings key={envEpoch} />
      </div>

      <ConnectionsDialog
        open={poolOpen}
        onClose={() => {
          setPoolOpen(false);
          setEnvEpoch((n) => n + 1);
        }}
      />
    </div>
  );
}

// Summary row for the default pool; the full list/catalog lives in ConnectionsDialog.
function DefaultPool({ epoch, onManage }: { epoch: number; onManage: () => void }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listConnections()
      .then(({ connections: c }) => {
        setConnections(c);
        setError(null);
        useNodeIcons.getState().fetchIcons(c.slice(0, 6).map((x) => `${x.provider}.connection`));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load your connections"));
  }, []);
  useEffect(() => {
    load();
  }, [load, epoch]);

  const shown = (connections ?? []).slice(0, 6);
  const extra = (connections ?? []).length - shown.length;

  return (
    <section className="mb-10">
      <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-1.5">
        Default
      </h2>
      <p className="text-[11px] m-0 mb-4" style={{ color: "var(--orchestr-ink-subtle)" }}>
        Default — runs on your connections. Every new account lands here; manual and test runs use it.
      </p>
      <button
        type="button"
        onClick={onManage}
        data-testid="default-pool-manage"
        className="w-full flex items-center gap-3 py-3 px-4 rounded-xl transition-colors duration-150 text-left cursor-pointer"
        style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
      >
        {error && connections === null ? (
          <span className="text-[12px] flex-1" style={{ color: "var(--orchestr-danger)" }}>
            {error}
          </span>
        ) : connections === null ? (
          <span className="text-[12px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Loading…
          </span>
        ) : connections.length === 0 ? (
          <span className="text-[12px] flex-1" style={{ color: "var(--orchestr-ink-muted)" }}>
            No apps connected yet — connect Slack, Google Sheets and more
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              {shown.map((c) => (
                <NodeIcon key={c.id} nodeType={`${c.provider}.connection`} size={16} />
              ))}
            </span>
            <span className="text-[12px] flex-1" style={{ color: "var(--orchestr-ink-muted)" }}>
              {connections.length} app{connections.length === 1 ? "" : "s"} connected
              {extra > 0 ? ` (+${extra} more)` : ""}
            </span>
          </>
        )}
        <span className="text-[12px] inline-flex items-center gap-0.5" style={{ color: "var(--orchestr-ink)" }}>
          Manage
          <ChevronRight size={13} />
        </span>
      </button>
    </section>
  );
}
