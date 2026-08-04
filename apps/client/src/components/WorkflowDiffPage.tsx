"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, useRouter, usePathname } from "next/navigation";
import { ArrowLeft, GitCommitHorizontal } from "lucide-react";
import type { Viewport } from "@xyflow/react";
import * as api from "@/api/client";
import type { DiffResponse, WorkflowVersionSummary, BranchSummary } from "@/api/client";
import FlowCanvas from "./FlowCanvas";
import ParamDiffDrawer from "./ParamDiffDrawer";
import { SaratiLoader } from "./SaratiLogo";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { DIFF_COLORS } from "@/lib/constants";
import { buildNodeDiffDetail, buildUnifiedGraph, summarizeDiff, type NodeDiffDetail } from "@/lib/diffHelpers";

function VersionLabel({ version, branchName }: { version: WorkflowVersionSummary; branchName?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] font-mono" style={{ color: "var(--orchestr-ink-subtle)" }}>
        {branchName ?? version.branch_name ?? "main"}
      </span>
      <span className="text-[14px] font-semibold" style={{ color: "var(--orchestr-ink)" }}>
        v{version.version_number}
      </span>
      {version.commit_message && (
        <span className="text-[11px] truncate max-w-[200px]" style={{ color: "var(--orchestr-ink-muted)" }}>
          {version.commit_message}
        </span>
      )}
    </div>
  );
}

function CountChip({ value, label, color }: { value: number; label: string; color: string }) {
  if (value === 0) return null;
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
      style={{
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 33%, transparent)`,
      }}
    >
      <span className="text-[11px] font-semibold" style={{ color }}>
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wider" style={{ color: `${color}` }}>
        {label}
      </span>
    </div>
  );
}

function findVersion(versions: WorkflowVersionSummary[], target: number | null): WorkflowVersionSummary | null {
  if (target === null) return null;
  return versions.find((v) => v.version_number === target) ?? null;
}

export default function WorkflowDiffPage() {
  const routeParams = useParams();
  const workflowId = routeParams?.id ? String(routeParams.id) : undefined;
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  useDocumentTitle("Compare");

  // useSearchParams is read-only, so query writes go through router.replace
  // with a rebuilt query.
  const setParams = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname],
  );

  // `branch` is the single-branch shorthand both sides fall back to;
  // `from_branch`/`to_branch` enable the cross-branch diff reviews use.
  const branchName = params.get("branch") || "main";
  const baseBranch = params.get("from_branch") || branchName;
  const headBranch = params.get("to_branch") || branchName;
  const baseParam = params.get("base") ? Number(params.get("base")) : null;
  const headParam = params.get("head") ? Number(params.get("head")) : null;
  const isCrossBranch = baseBranch !== headBranch;


  const [baseVersions, setBaseVersions] = useState<WorkflowVersionSummary[]>([]);
  const [headVersions, setHeadVersions] = useState<WorkflowVersionSummary[]>([]);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [focusedNodeKey, setFocusedNodeKey] = useState<string | null>(null);
  // Bumped by the drawer's "jump to node" — the head canvas recenters on the
  // focused node, and the shared viewport carries the base canvas along.
  const [focusNonce, setFocusNonce] = useState(0);

  // Shared viewport for split-diff scroll/zoom sync — null until the first
  // interaction so each side fits-view independently on mount.
  const [sharedViewport, setSharedViewport] = useState<Viewport | null>(null);
  const handleViewportChange = useCallback((vp: Viewport) => setSharedViewport(vp), []);

  // Fetch branches once per workflow — they don't change with the dropdowns.
  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    api
      .listBranches(workflowId)
      .then((res) => !cancelled && setBranches(res.branches))
      // Non-fatal: a failure just empties the dropdown, where the page-level
      // `error` state would replace a perfectly good diff.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  // Fetch versions (one or two lists depending on cross-branch).
  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    // Loading/error reset for a fetch — a side effect, not derivable state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);

    const versionFetches = isCrossBranch
      ? Promise.all([api.listVersions(workflowId, baseBranch), api.listVersions(workflowId, headBranch)])
      : api.listVersions(workflowId, baseBranch).then((res) => [res, res] as const);

    versionFetches
      .then(([bv, hv]) => {
        if (cancelled) return;
        setBaseVersions(bv.versions);
        setHeadVersions(hv.versions);

        // `listVersions` also returns the inherited fork point, so auto-pick
        // prefers the branch's own newest commit and falls back to it only when
        // the branch has nothing of its own.
        if (hv.versions.length === 0) return;
        const nativeHead = hv.versions
          .filter((v) => !v.is_fork_point)
          .sort((a, b) => b.version_number - a.version_number);
        const nativeBase = bv.versions
          .filter((v) => !v.is_fork_point)
          .sort((a, b) => b.version_number - a.version_number);
        const allHead = [...hv.versions].sort((a, b) => b.version_number - a.version_number);
        const allBase = [...bv.versions].sort((a, b) => b.version_number - a.version_number);

        const newestHead = nativeHead[0]?.version_number ?? allHead[0].version_number;
        const newestBase = nativeBase[0]?.version_number ?? allBase[0]?.version_number ?? newestHead;
        const previousOnHead = nativeHead[1]?.version_number ?? allHead[1]?.version_number ?? newestHead;

        const hParam = headParam && hv.versions.find((v) => v.version_number === headParam) ? headParam : newestHead;
        const defaultBase = isCrossBranch ? newestBase : previousOnHead;
        const bParam = baseParam && bv.versions.find((v) => v.version_number === baseParam) ? baseParam : defaultBase;

        if (hParam !== headParam || bParam !== baseParam) {
          const next = new URLSearchParams(params);
          next.set("base", String(bParam));
          next.set("head", String(hParam));
          setParams(next);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, baseBranch, headBranch, isCrossBranch]);

  // Fetch diff whenever base/head change (version mode only).
  useEffect(() => {
    if (!workflowId || baseParam === null || headParam === null) return;
    if (baseParam === headParam && !isCrossBranch) {
      // Same-version shortcut: report an empty diff without a network call.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDiff({ from_version: baseParam, to_version: headParam, entries: [], summary: "No changes" });
      return;
    }
    let cancelled = false;
    api
      .getVersionDiff(workflowId, baseParam, headParam, {
        branch: isCrossBranch ? undefined : baseBranch,
        fromBranch: isCrossBranch ? baseBranch : undefined,
        toBranch: isCrossBranch ? headBranch : undefined,
      })
      .then((res) => !cancelled && setDiff(res))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load diff"));
    return () => {
      cancelled = true;
    };
  }, [workflowId, baseParam, headParam, baseBranch, headBranch, isCrossBranch]);

  const baseVersion = useMemo(() => findVersion(baseVersions, baseParam), [baseVersions, baseParam]);
  const headVersion = useMemo(() => findVersion(headVersions, headParam), [headVersions, headParam]);

  const baseJson = baseVersion?.workflow_json;
  const headJson = headVersion?.workflow_json;

  // One unified graph — each canvas renders its slice plus ghost placeholders
  // for the other side's exclusives.
  const unified = useMemo(() => buildUnifiedGraph(baseJson, headJson, diff), [baseJson, headJson, diff]);
  const summary = useMemo(() => (diff ? summarizeDiff(diff) : null), [diff]);

  // A renamed node has different names on base and head, so one
  // highlightedNodeId can't match both — resolve the counterpart per side.
  const { renameOldToNew, renameNewToOld } = useMemo(() => {
    const o2n = new Map<string, string>();
    const n2o = new Map<string, string>();
    for (const r of diff?.renames ?? []) {
      o2n.set(r.old_name, r.new_name);
      n2o.set(r.new_name, r.old_name);
    }
    return { renameOldToNew: o2n, renameNewToOld: n2o };
  }, [diff]);

  const baseHighlight = focusedNodeKey ? (renameNewToOld.get(focusedNodeKey) ?? focusedNodeKey) : null;
  const headHighlight = focusedNodeKey ? (renameOldToNew.get(focusedNodeKey) ?? focusedNodeKey) : null;

  const focusedDetail: NodeDiffDetail | null = useMemo(() => {
    if (!focusedNodeKey || !diff) return null;
    return buildNodeDiffDetail(diff, focusedNodeKey);
  }, [focusedNodeKey, diff]);

  const focusedNodeType: string | undefined = useMemo(() => {
    if (!focusedNodeKey) return undefined;
    const findIn = (json: Record<string, unknown> | undefined) => {
      const list = (json?.nodes as Array<Record<string, unknown>>) ?? [];
      // The workflow_json graph carries the node kind under `type`; the IR under `node_type`.
      const match = list.find((n) => (n.name as string) === focusedNodeKey);
      return (match?.type ?? match?.node_type) as string | undefined;
    };
    return findIn(headJson) ?? findIn(baseJson);
  }, [focusedNodeKey, headJson, baseJson]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (!diff) return;
      const detail = buildNodeDiffDetail(diff, nodeId);
      if (!detail) return; // unchanged nodes — no drawer
      // Added/removed nodes get no drawer — the canvas badge already tells the
      // whole story, and the drawer is for changes *within* an existing node.
      if (detail.status === "added" || detail.status === "removed") return;
      if (detail.status === "unchanged") return;
      setFocusedNodeKey(nodeId);
    },
    [diff],
  );

  const handleVersionChange = (which: "base" | "head", versionNumber: number) => {
    const next = new URLSearchParams(params);
    next.set(which, String(versionNumber));
    setParams(next);
  };

  const handleBranchChange = (name: string) => {
    const next = new URLSearchParams(params);
    next.set("branch", name);
    next.delete("base");
    next.delete("head");
    setParams(next);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--orchestr-surface)" }}>
        <SaratiLoader size={48} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--orchestr-surface)" }}>
        <div className="text-[13px]" style={{ color: "var(--orchestr-danger)" }}>
          {error}
        </div>
      </div>
    );
  }

  // Cross-branch needs one version per side; same-branch needs two.
  const insufficient =
    isCrossBranch ? baseVersions.length === 0 || headVersions.length === 0 : baseVersions.length < 2;
  if (insufficient) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-3"
        style={{ background: "var(--orchestr-surface)" }}
      >
        <div className="text-[14px]" style={{ color: "var(--orchestr-ink-muted)" }}>
          {isCrossBranch ? (
            <>
              Need at least one version on each of <span style={{ color: "var(--orchestr-ink)" }}>{baseBranch}</span>{" "}
              and <span style={{ color: "var(--orchestr-ink)" }}>{headBranch}</span> to compare.
            </>
          ) : (
            <>
              Need at least two versions on branch <span style={{ color: "var(--orchestr-ink)" }}>{branchName}</span> to
              compare.
            </>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={() => router.push(`/workflows/${workflowId}/overview`)}>
          ← Back to overview
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--orchestr-surface)" }}>
      <div
        className="px-6 py-4 flex items-center gap-4 sticky top-0 z-30"
        style={{
          background: "var(--orchestr-surface-overlay)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid var(--orchestr-line)",
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            router.push(
              `/workflows/${workflowId}/overview${branchName !== "main" ? `?branch=${encodeURIComponent(branchName)}` : ""}`,
            )
          }
          title="Back to workflow"
          aria-label="Back to workflow"
        >
          <ArrowLeft size={15} />
          Back to workflow
        </Button>
        <div className="w-px h-5 shrink-0" style={{ background: "var(--orchestr-line)" }} />

        <div className="flex items-center gap-2">
          <GitCommitHorizontal size={16} style={{ color: "var(--orchestr-ink-muted)" }} />
          <span className="text-[13px] font-semibold" style={{ color: "var(--orchestr-ink)" }}>
            Compare versions
          </span>
        </div>

        <div className="ml-2 flex items-center gap-2">
          {isCrossBranch ? (
            <span className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--orchestr-ink-muted)" }}>
              <span style={{ color: "var(--orchestr-ink)" }}>{baseBranch}</span>
              <span style={{ color: "var(--orchestr-ink-subtle)" }}>←</span>
              <span style={{ color: "var(--orchestr-ink)" }}>{headBranch}</span>
            </span>
          ) : (
            <select
              className="text-[12px] px-2 py-1 rounded bg-transparent"
              style={{
                border: "1px solid var(--orchestr-line)",
                color: "var(--orchestr-ink)",
              }}
              value={branchName}
              onChange={(e) => handleBranchChange(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.name} style={{ background: "var(--orchestr-surface-card)" }}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {summary && (
            <>
              <CountChip value={summary.added} label="added" color={DIFF_COLORS.added} />
              <CountChip value={summary.removed} label="removed" color={DIFF_COLORS.removed} />
              <CountChip value={summary.modified} label="modified" color={DIFF_COLORS.modifiedNew} />
              {(summary.edgeAdded > 0 || summary.edgeRemoved > 0) && (
                <CountChip value={summary.edgeAdded + summary.edgeRemoved} label="edges" color={DIFF_COLORS.accent} />
              )}
              {summary.added === 0 &&
                summary.removed === 0 &&
                summary.modified === 0 &&
                summary.edgeAdded === 0 &&
                summary.edgeRemoved === 0 && (
                  <span className="text-[12px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    No changes
                  </span>
                )}
            </>
          )}
        </div>
      </div>

      {/* Version picker strip — base left, head right, mirroring the canvas layout. */}
      <div
        className="px-6 py-3 grid grid-cols-1 lg:grid-cols-2 gap-4"
        style={{
          background: "var(--orchestr-field)",
          borderBottom: "1px solid var(--orchestr-line)",
          // Cross-branch reviews are head-vs-head — fixed, not version-pickable.
          display: isCrossBranch ? "none" : undefined,
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Base
          </span>
          <select
            className="text-[12px] px-2 py-1 rounded bg-transparent"
            style={{
              border: "1px solid var(--orchestr-line)",
              color: "var(--orchestr-ink)",
            }}
            value={baseParam ?? ""}
            onChange={(e) => handleVersionChange("base", Number(e.target.value))}
          >
            {baseVersions.map((v) => (
              <option key={v.id} value={v.version_number} style={{ background: "var(--orchestr-surface-card)" }}>
                v{v.version_number}
                {v.commit_message ? ` — ${v.commit_message.slice(0, 40)}` : ""}
              </option>
            ))}
          </select>
          {baseVersion && <VersionLabel version={baseVersion} branchName={baseBranch} />}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Head
          </span>
          <select
            className="text-[12px] px-2 py-1 rounded bg-transparent"
            style={{
              border: "1px solid var(--orchestr-line)",
              color: "var(--orchestr-ink)",
            }}
            value={headParam ?? ""}
            onChange={(e) => handleVersionChange("head", Number(e.target.value))}
          >
            {headVersions.map((v) => (
              <option key={v.id} value={v.version_number} style={{ background: "var(--orchestr-surface-card)" }}>
                v{v.version_number}
                {v.commit_message ? ` — ${v.commit_message.slice(0, 40)}` : ""}
              </option>
            ))}
          </select>
          {headVersion && <VersionLabel version={headVersion} branchName={headBranch} />}
        </div>
      </div>

      {/* Discoverability hint — only when there are modified nodes to click. */}
      {summary && summary.modified > 0 && (
        <div
          className="px-6 py-2 text-[11px] flex items-center gap-1.5"
          style={{ color: "var(--orchestr-ink-muted)", borderBottom: "1px solid var(--orchestr-line)" }}
        >
          <span
            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] font-semibold"
            style={{ background: DIFF_COLORS.modifiedNew, color: "var(--orchestr-surface)" }}
          >
            ~
          </span>
          Click a modified node to see what changed.
        </div>
      )}

      {/* Two-canvas split. At <lg, stacks vertically. */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
        <div className="flex flex-col gap-2 min-h-[400px]">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Base
          </div>
          <div className="flex-1 min-h-0">
            {baseJson && (
              <FlowCanvas
                preparsedNodes={unified.base.nodes}
                preparsedEdges={unified.base.edges}
                highlightedNodeId={baseHighlight}
                syncedViewport={sharedViewport}
                onViewportChange={handleViewportChange}
                onNodeClick={handleNodeClick}
                fill
              />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 min-h-[400px]">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Head
          </div>
          <div className="flex-1 min-h-0">
            {headJson && (
              <FlowCanvas
                preparsedNodes={unified.head.nodes}
                preparsedEdges={unified.head.edges}
                highlightedNodeId={headHighlight}
                focusNodeId={headHighlight}
                focusNonce={focusNonce}
                syncedViewport={sharedViewport}
                onViewportChange={handleViewportChange}
                onNodeClick={handleNodeClick}
                fill
              />
            )}
          </div>
        </div>
      </div>

      <ParamDiffDrawer
        detail={focusedDetail}
        nodeType={focusedNodeType}
        onClose={() => setFocusedNodeKey(null)}
        onJumpToNode={() => setFocusNonce((n) => n + 1)}
      />

    </div>
  );
}
