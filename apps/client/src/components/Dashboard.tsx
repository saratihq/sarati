"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Boxes, Layers, Plus, Search, Zap } from "lucide-react";
import { useWorkflow } from "@/store/useWorkflow";
import { useNodeIcons } from "@/store/useNodeIcons";
import { useOrgs, activeOrgOf } from "@/store/useOrgs";
import WorkflowCard from "@/components/WorkflowCard";
import { SaratiLoader } from "@/components/SaratiLogo";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { composerDisabledHint, useComposerAvailable } from "@/lib/useComposerAvailable";

type Filter = "all" | "active" | "paused";

function StatTile({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  tone?: "default" | "warning";
}) {
  return (
    <div
      className="rounded-xl px-4 py-3.5 flex items-center justify-between"
      style={{
        background: "var(--orchestr-surface-card)",
        border: "1px solid var(--orchestr-line)",
      }}
    >
      <div>
        <p
          className="text-[11px] m-0 mb-1"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          {label}
        </p>
        <p
          className="text-[20px] font-semibold m-0 leading-none"
          style={{
            color:
              tone === "warning"
                ? "var(--orchestr-warning)"
                : "var(--orchestr-ink)",
          }}
        >
          {value}
        </p>
      </div>
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center"
        style={{
          background:
            tone === "warning"
              ? "var(--orchestr-warning-tint)"
              : "var(--orchestr-accent-tint)",
          color:
            tone === "warning"
              ? "var(--orchestr-warning)"
              : "var(--orchestr-ink-subtle)",
        }}
      >
        {icon}
      </div>
    </div>
  );
}

// Decorative three-node flow motif for the empty state — pure chrome, no hue.
function FlowMotif() {
  return (
    <svg
      width="200"
      height="40"
      viewBox="0 0 200 40"
      fill="none"
      aria-hidden="true"
    >
      <line
        x1="34"
        y1="20"
        x2="86"
        y2="20"
        stroke="var(--orchestr-line-strong)"
        strokeWidth="1.5"
        strokeDasharray="3 4"
      />
      <line
        x1="114"
        y1="20"
        x2="166"
        y2="20"
        stroke="var(--orchestr-line-strong)"
        strokeWidth="1.5"
        strokeDasharray="3 4"
      />
      {[20, 100, 180].map((cx) => (
        <g key={cx}>
          <rect
            x={cx - 14}
            y="6"
            width="28"
            height="28"
            rx="8"
            fill="var(--orchestr-surface-raised)"
            stroke="var(--orchestr-line-strong)"
          />
          <circle cx={cx} cy="20" r="4" fill="var(--orchestr-ink-faint)" />
        </g>
      ))}
    </svg>
  );
}

export default function Dashboard() {
  useDocumentTitle("Dashboard");
  const workflows = useWorkflow((s) => s.workflows);
  const dashboardLoading = useWorkflow((s) => s.dashboardLoading);
  const dashboardLoadingMore = useWorkflow((s) => s.dashboardLoadingMore);
  const dashboardError = useWorkflow((s) => s.dashboardError);
  const dashboardHasMore = useWorkflow((s) => s.dashboardHasMore);
  const dashboardTotal = useWorkflow((s) => s.dashboardTotal);
  const fetchWorkflows = useWorkflow((s) => s.fetchWorkflows);
  const loadMoreWorkflows = useWorkflow((s) => s.loadMoreWorkflows);
  const fetchIcons = useNodeIcons((s) => s.fetchIcons);

  const router = useRouter();
  // The empty state promises the composer by name, so it must not promise it on an instance that
  // has none. Unresolved probe = assume present: this card is the first thing a new install sees.
  const composer = useComposerAvailable();
  const composerHere = composer?.available !== false;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // Non-personal orgs get a marker in the heading: workflows there are shared with the whole org.
  const activeOrg = useOrgs(activeOrgOf);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  // Batch-prefetch every integration icon the cards will render.
  useEffect(() => {
    const types = Array.from(
      new Set(workflows.flatMap((w) => w.node_types || [])),
    );
    if (types.length > 0) fetchIcons(types);
  }, [workflows, fetchIcons]);

  const stats = useMemo(
    () => ({
      active: workflows.filter((w) => w.active).length,
      nodes: workflows.reduce((sum, w) => sum + (w.node_count || 0), 0),
    }),
    [workflows],
  );
  // With more pages unloaded these are lower bounds, so they render as "n+".
  const approx = (n: number) => (dashboardHasMore ? `${n}+` : n);

  const filtered = useMemo(() => {
    let list = workflows;
    if (filter === "active") list = list.filter((w) => w.active);
    if (filter === "paused") list = list.filter((w) => !w.active);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((w) => w.name.toLowerCase().includes(q));
    return list;
  }, [workflows, filter, query]);

  const filterChips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "paused", label: "Paused" },
  ];

  return (
    <div className="max-w-[1200px] mx-auto py-8 px-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2
            className="text-[22px] font-semibold m-0"
            style={{ color: "var(--orchestr-ink)" }}
          >
            Workflows
            {activeOrg && !activeOrg.is_personal && (
              <span
                className="font-normal text-[15px]"
                style={{ color: "var(--orchestr-ink-muted)" }}
              >
                {" "}
                · {activeOrg.name}
              </span>
            )}
          </h2>
          <p
            className="text-[13px] mt-1 m-0"
            style={{ color: "var(--orchestr-ink-subtle)" }}
          >
            Manage, execute, and monitor your automations.
          </p>
        </div>
        {workflows.length > 0 && (
          <div className="flex items-center gap-2.5">
            <Button
              variant="ai"
              onClick={() => router.push("/workflows/compose")}
            >
              <Plus size={14} />
              New workflow
            </Button>
          </div>
        )}
      </div>

      {/* Error */}
      {dashboardError && (
        <div
          className="py-3 px-4 rounded-xl mb-4"
          style={{
            background: "var(--orchestr-danger-tint)",
            border: "1px solid var(--orchestr-danger-tint)",
          }}
        >
          <span className="text-sm" style={{ color: "var(--orchestr-danger)" }}>
            {dashboardError}
          </span>
        </div>
      )}

      {/* Loading */}
      {dashboardLoading && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <SaratiLoader size={56} />
          <p className="text-sm" style={{ color: "var(--orchestr-ink-muted)" }}>
            Loading workflows...
          </p>
        </div>
      )}

      {/* Empty state */}
      {!dashboardLoading && workflows.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center pt-14 pb-20 text-center"
        >
          <FlowMotif />
          <h3
            className="text-[18px] font-semibold mt-6 mb-1.5"
            style={{ color: "var(--orchestr-ink)" }}
          >
            Build your first workflow
          </h3>
          <p
            className="text-[13px] m-0 max-w-[440px]"
            style={{ color: "var(--orchestr-ink-muted)" }}
          >
            Version control, reviews, and a built-in runtime for your
            automations
            {composerHere
              ? " — describe what you want and build it together."
              : " — wire up your steps on the canvas and run them."}
          </p>
          <div className="mt-8 w-full max-w-[360px] text-left">
            <div
              className="rounded-2xl p-6 flex flex-col items-start"
              style={{
                background: "var(--orchestr-surface-card)",
                border: "1px solid var(--orchestr-line)",
              }}
            >
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center mb-4"
                style={{
                  background: composerHere
                    ? "var(--orchestr-ai-tint)"
                    : "var(--orchestr-surface)",
                  color: composerHere
                    ? "var(--orchestr-ai)"
                    : "var(--orchestr-ink-muted)",
                }}
              >
                {composerHere ? <Plus size={17} /> : <Layers size={17} />}
              </div>
              <h4
                className="text-[14px] font-semibold m-0 mb-1"
                style={{ color: "var(--orchestr-ink)" }}
              >
                {composerHere
                  ? "Describe it, we build it together"
                  : "Build it on the canvas"}
              </h4>
              <p
                className="text-[12px] m-0 mb-5 leading-relaxed"
                style={{ color: "var(--orchestr-ink-muted)" }}
              >
                {composerHere ? (
                  <>
                    Tell the composer what you want in plain English — it drafts
                    the workflow on the canvas, asks when it needs something,
                    and tests it with you. Prefer to build by hand? Add steps
                    from the catalog right there.
                  </>
                ) : (
                  <>
                    Add steps from the catalog, wire them together, and test the
                    workflow as you go.
                    {composer ? ` ${composerDisabledHint(composer)}.` : ""}
                  </>
                )}
              </p>
              <Button
                variant={composerHere ? "ai" : "default"}
                className="mt-auto"
                onClick={() => router.push("/workflows/compose")}
              >
                <Plus size={14} />
                New workflow
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Populated dashboard */}
      {!dashboardLoading && workflows.length > 0 && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            <StatTile
              label="Workflows"
              value={dashboardTotal || workflows.length}
              icon={<Layers size={15} />}
            />
            <StatTile
              label="Active"
              value={approx(stats.active)}
              icon={<Zap size={15} />}
            />
            <StatTile
              label="Nodes orchestrated"
              value={approx(stats.nodes)}
              icon={<Boxes size={15} />}
            />
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="relative w-full sm:w-[280px]">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search workflows…"
                className="w-full h-9 rounded-[10px] pl-9 pr-3 text-[13px] outline-none transition-colors"
                style={{
                  background: "var(--orchestr-surface-raised)",
                  border: "1px solid var(--orchestr-line)",
                  color: "var(--orchestr-ink)",
                }}
              />
            </div>
            <div
              className="flex items-center gap-0.5 p-0.5 rounded-[10px]"
              style={{
                background: "var(--orchestr-surface-card)",
                border: "1px solid var(--orchestr-line)",
              }}
            >
              {filterChips.map((chip) => (
                <button
                  key={chip.key}
                  onClick={() => setFilter(chip.key)}
                  className="px-3 h-7 rounded-lg text-xs font-medium cursor-pointer border-none transition-colors"
                  style={{
                    background:
                      filter === chip.key
                        ? "var(--orchestr-accent-tint-strong)"
                        : "transparent",
                    color:
                      filter === chip.key
                        ? "var(--orchestr-ink)"
                        : "var(--orchestr-ink-muted)",
                  }}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          {/* Grid */}
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center py-16 gap-3">
              <p
                className="text-sm m-0"
                style={{ color: "var(--orchestr-ink-muted)" }}
              >
                No workflows match
                {query.trim() ? ` “${query.trim()}”` : " this filter"}.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              <AnimatePresence>
                {filtered.map((wf, i) => (
                  <motion.div
                    key={wf.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.3, delay: i * 0.04 }}
                  >
                    <WorkflowCard workflow={wf} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}

          {dashboardHasMore && (
            <div className="flex flex-col items-center mt-8 gap-2">
              <Button
                variant="secondary"
                onClick={loadMoreWorkflows}
                disabled={dashboardLoadingMore}
              >
                {dashboardLoadingMore ? "Loading…" : "Load more"}
              </Button>
              <span
                className="text-xs"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                Showing {workflows.length} of {dashboardTotal}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
