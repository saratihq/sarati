"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, GitMerge, MessageSquare, Plus, Rocket, X } from "lucide-react";
import * as api from "@/api/client";
import type {
  ConflictInfo,
  EnvPointer,
  MergeResolution,
  MergeResultResponse,
  ReviewApproval,
  ReviewDetail,
  ReviewSummary,
  ReviewTestSummary,
  WorkflowVersionSummary,
} from "@/api/client";
import { listEnvironments, removeEnvPointer } from "@/api/environments";
import type { EnvironmentSummary } from "@/api/environments";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { GLOSSARY, Tooltip } from "@/components/ui/term";
import { canMoveEnvPointers, ENV_POINTER_GATE, useOrgs } from "@/store/useOrgs";
import { timeAgo } from "@/lib/format";
import { getTagColor } from "@/lib/envPresentation";
import { toast } from "@/lib/toast";
import ConflictResolver from "./ConflictResolver";
import DiffView from "./DiffView";
import { SaratiLoader } from "./SaratiLogo";
import PromoteDialog from "./PromoteDialog";
import ReviewTestPanel from "./ReviewTestPanel";

// Review status pills.
const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  open: { bg: "var(--orchestr-info-tint)", text: "var(--orchestr-info)" },
  approved: { bg: "var(--orchestr-success-tint)", text: "var(--orchestr-success)" },
  rejected: { bg: "var(--orchestr-danger-tint)", text: "var(--orchestr-danger)" },
  merged: { bg: "var(--orchestr-accent-tint)", text: "var(--orchestr-ink-muted)" },
  closed: { bg: "var(--orchestr-accent-tint)", text: "var(--orchestr-ink-subtle)" },
};

// Reviewer verdicts — attribution shown in the review's conversation.
const APPROVAL_STYLES: Record<string, { label: string; text: string }> = {
  approved: { label: "approved", text: "var(--orchestr-success)" },
  rejected: { label: "requested changes", text: "var(--orchestr-danger)" },
  commented: { label: "commented", text: "var(--orchestr-ink-muted)" },
};


// Promote-menu fallback when the environments list can't load; promoting works by name.
const FALLBACK_ENV_NAMES = ["production", "staging", "uat"] as const;

const CARD_STYLE = {
  background: "var(--orchestr-surface-card)",
  border: "1px solid var(--orchestr-line)",
} as const;

// Nested controls own their own clicks — the card must not navigate on top of them.
const NESTED_CONTROL_SELECTOR = "button, a, select, input, [role='menu']";

// Card-as-link behaviour shared by every clickable feed card, so pointer and keyboard agree.
function cardLinkProps(clickable: boolean, href: string, label: string, navigate: (to: string) => void) {
  if (!clickable) return {};
  return {
    role: "link",
    tabIndex: 0,
    "aria-label": label,
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(NESTED_CONTROL_SELECTOR)) return;
      navigate(href);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.target === e.currentTarget) navigate(href);
    },
  } as const;
}

// Newest version a branch owns: the inherited fork point counts only if it has no commits of its own.
function newestVersion(versions: WorkflowVersionSummary[]): number | undefined {
  const byNumber = (a: WorkflowVersionSummary, b: WorkflowVersionSummary) => b.version_number - a.version_number;
  const native = versions.filter((v) => !v.is_fork_point).sort(byNumber);
  return native[0]?.version_number ?? [...versions].sort(byNumber)[0]?.version_number;
}

function itemTime(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

type FeedItem =
  | { kind: "version"; ts: number; version: WorkflowVersionSummary }
  | { kind: "review"; ts: number; review: ReviewSummary };

function TagChip({ tag, inactive }: { tag: string; inactive: boolean }) {
  const color = getTagColor(tag);
  return (
    <Tooltip content={inactive ? "Deployed but not active — credentials may need configuring at the source" : GLOSSARY.tag}>
      <span
        className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase inline-flex items-center gap-1"
        style={{ background: color.bg, color: color.text }}
      >
        {tag}
        {inactive && (
          <span
            className="w-1 h-1 rounded-full"
            style={{ background: "var(--orchestr-warning)", boxShadow: "0 0 4px var(--orchestr-warning)" }}
          />
        )}
      </span>
    </Tooltip>
  );
}

interface ConfirmOptions {
  title?: string;
  message: string;
  consequence?: string;
  confirmLabel?: string;
  /** Solid-danger confirm CTA (pointer removals). */
  destructive?: boolean;
}

// One reviewer verdict line — who approved / requested changes, plus their note.
function ApprovalRow({ approval }: { approval: ReviewApproval }) {
  const style = APPROVAL_STYLES[approval.decision] || APPROVAL_STYLES.commented;
  const Icon = approval.decision === "rejected" ? X : Check;
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <Icon size={13} className="mt-0.5 shrink-0" style={{ color: style.text }} />
      <div className="min-w-0">
        <span className="font-semibold" style={{ color: "var(--orchestr-ink)" }}>
          {approval.reviewer_name || "Someone"}
        </span>{" "}
        <span style={{ color: style.text }}>{style.label}</span>
        <span className="ml-1.5 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          {timeAgo(approval.created_at)}
        </span>
        {approval.comment && (
          <div className="mt-0.5 whitespace-pre-wrap break-words" style={{ color: "var(--orchestr-ink-muted)" }}>
            {approval.comment}
          </div>
        )}
      </div>
    </div>
  );
}

interface ReviewFeedCardProps {
  workflowId: string;
  review: ReviewSummary;
  initiallyExpanded: boolean;
  busy: boolean;
  /** Named environments (ADR 0014) for the pre-merge test's env picker. */
  environments: EnvironmentSummary[] | null;
  onApproval: (review: ReviewSummary, decision: "approved" | "rejected", comment?: string) => void;
  onMergeRequest: (review: ReviewSummary) => void;
  onCloseReview: (review: ReviewSummary) => void;
}

function ReviewFeedCard({
  workflowId,
  review,
  initiallyExpanded,
  busy,
  environments,
  onApproval,
  onMergeRequest,
  onCloseReview,
}: ReviewFeedCardProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  // Each branch's newest version, resolved once on first expand.
  const [diffVersions, setDiffVersions] = useState<{ from: number; to: number } | null>(null);
  const [diffUnavailable, setDiffUnavailable] = useState(false);
  const [resolved, setResolved] = useState(false);

  // Full review detail, re-fetched whenever the summary's updated_at moves so attribution stays live.
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [note, setNote] = useState("");
  // Latest pre-merge test (ADR 0015); drives the merge-gate warning below.
  const [testResult, setTestResult] = useState<ReviewTestSummary | null>(null);

  useEffect(() => {
    if (!expanded || resolved) return;
    let cancelled = false;
    Promise.all([
      api.listVersions(workflowId, review.target_branch),
      api.listVersions(workflowId, review.source_branch),
    ])
      .then(([tv, sv]) => {
        if (cancelled) return;
        const from = newestVersion(tv.versions);
        const to = newestVersion(sv.versions);
        if (from === undefined || to === undefined) setDiffUnavailable(true);
        else setDiffVersions({ from, to });
        setResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        setDiffUnavailable(true);
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, resolved, workflowId, review.target_branch, review.source_branch]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api
      .getReview(workflowId, review.id)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setDetailError(false);
          // Keep whichever test is newer: a re-fetch must not clobber a fresher just-run local result.
          const incoming = d.last_test ?? null;
          setTestResult((prev) => {
            if (!incoming) return prev;
            if (!prev) return incoming;
            return new Date(incoming.tested_at) >= new Date(prev.tested_at) ? incoming : prev;
          });
        }
      })
      .catch(() => {
        if (!cancelled) setDetailError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, workflowId, review.id, review.updated_at]);

  const statusStyle = STATUS_STYLES[review.status] || STATUS_STYLES.open;
  const actionable = review.status !== "merged" && review.status !== "closed";
  // Comments/approvals are rejected server-side once a review is merged/closed.
  const canCollaborate = actionable;
  // The thread's own length is the truth once loaded; the summary count covers the gap before that.
  const commentCount = detail ? detail.comments.length : review.comment_count;

  const handlePostComment = async () => {
    const body = commentBody.trim();
    if (!body || postingComment) return;
    setPostingComment(true);
    try {
      const created = await api.addReviewComment(workflowId, review.id, body);
      setDetail((d) => (d ? { ...d, comments: [...d.comments, created] } : d));
      setCommentBody("");
    } catch (e) {
      toast.error("Failed to post comment", e instanceof Error ? e.message : undefined);
    } finally {
      setPostingComment(false);
    }
  };

  const submitApproval = (decision: "approved" | "rejected") => {
    onApproval(review, decision, note.trim() || undefined);
    setNote("");
  };

  return (
    <div id={`feed-review-${review.id}`} className="rounded-xl p-4" style={CARD_STYLE}>
      <div className="flex items-center gap-2">
        <span
          className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase shrink-0"
          style={{ background: statusStyle.bg, color: statusStyle.text }}
        >
          {review.status}
        </span>
        <span className="text-[13px] font-semibold flex-1 truncate" style={{ color: "var(--orchestr-ink)" }}>
          {review.title}
        </span>
        <span className="text-[11px] shrink-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
          {timeAgo(review.created_at)}
        </span>
      </div>
      <div className="flex items-center gap-2.5 mt-1 text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
        <span>
          {review.source_branch} &rarr; {review.target_branch}
        </span>
        <span className="inline-flex items-center gap-1">
          <MessageSquare size={11} />
          {commentCount} comment{commentCount !== 1 ? "s" : ""}
        </span>
        {review.approval_count > 0 && (
          <span className="inline-flex items-center gap-1" style={{ color: "var(--orchestr-success)" }}>
            <Check size={11} />
            {review.approval_count} approval{review.approval_count !== 1 ? "s" : ""}
          </span>
        )}
        {review.author_name && <span>by {review.author_name}</span>}
      </div>

      <div className="mt-2.5">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="inline-flex items-center gap-1.5 bg-transparent border-none p-0 cursor-pointer text-[11px] uppercase tracking-[1px] font-semibold text-[color:var(--orchestr-ink-muted)]"
        >
          <ChevronDown
            size={12}
            style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}
          />
          Details
        </button>
      </div>

      {expanded && (
        <div className="mt-2">
          {detail?.description && (
            <div
              className="text-[12px] mb-3 whitespace-pre-wrap break-words"
              style={{ color: "var(--orchestr-ink-muted)" }}
            >
              {detail.description}
            </div>
          )}

          {diffUnavailable ? (
            <div className="text-[12px] text-[var(--orchestr-ink-subtle)] py-2">Changes couldn&apos;t be loaded for these branches.</div>
          ) : !diffVersions ? (
            <div className="flex items-center justify-center py-4">
              <SaratiLoader size={24} />
            </div>
          ) : (
            <DiffView
              workflowId={workflowId}
              fromVersion={diffVersions.from}
              toVersion={diffVersions.to}
              fromBranch={review.target_branch}
              toBranch={review.source_branch}
            />
          )}

          {/* Pre-merge "Test this branch" (ADR 0015) */}
          <ReviewTestPanel
            workflowId={workflowId}
            reviewId={review.id}
            environments={environments}
            result={testResult}
            onResult={setTestResult}
            canRun={actionable}
          />

          {/* ─── Conversation: reviewer verdicts + comment thread + input ─── */}
          <div className="mt-3 pt-3 space-y-3" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
            {detailError && (
              <div className="text-[11px]" style={{ color: "var(--orchestr-danger)" }}>
                Couldn&apos;t load the conversation. Reopen to retry.
              </div>
            )}

            {detail && detail.approvals.length > 0 && (
              <div className="space-y-1.5">
                {detail.approvals.map((a) => (
                  <ApprovalRow key={a.id} approval={a} />
                ))}
              </div>
            )}

            {detail && (
              <div className="space-y-2">
                {detail.comments.length === 0 ? (
                  <div className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    No comments yet.
                  </div>
                ) : (
                  detail.comments.map((c) => (
                    <div key={c.id} className="text-[12px]">
                      <span className="font-semibold" style={{ color: "var(--orchestr-ink)" }}>
                        {c.author_name || "Someone"}
                      </span>
                      <span className="ml-1.5 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                        {timeAgo(c.created_at)}
                      </span>
                      <div className="mt-0.5 whitespace-pre-wrap break-words" style={{ color: "var(--orchestr-ink-muted)" }}>
                        {c.body}
                      </div>
                    </div>
                  ))
                )}

                {canCollaborate && (
                  <div className="flex items-start gap-2 pt-1">
                    <textarea
                      value={commentBody}
                      onChange={(e) => setCommentBody(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void handlePostComment();
                      }}
                      placeholder="Leave a comment"
                      rows={2}
                      className="flex-1 py-1.5 px-2.5 rounded text-[12px] border-none outline-none resize-none"
                      style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void handlePostComment()}
                      disabled={postingComment || !commentBody.trim()}
                    >
                      {postingComment ? "Posting..." : "Comment"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {actionable && (
            <div className="mt-3 pt-3 space-y-2" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note — why you're approving or requesting changes"
                rows={2}
                className="w-full py-1.5 px-2.5 rounded text-[12px] border-none outline-none resize-none"
                style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }}
              />
              {review.status === "approved" && testResult?.verdict === "red" && (
                <div
                  className="text-[11px] py-1.5 px-2.5 rounded"
                  style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
                >
                  The latest test is failing. If {review.target_branch} is protected, this merge will be
                  blocked until a test passes.
                </div>
              )}
              <div className="flex gap-2">
                <Button variant="success" size="sm" onClick={() => submitApproval("approved")} disabled={busy}>
                  Approve
                </Button>
                <Button variant="destructive" size="sm" onClick={() => submitApproval("rejected")} disabled={busy}>
                  Request changes
                </Button>
                {review.status === "approved" && (
                  <Button variant="secondary" size="sm" onClick={() => onMergeRequest(review)} disabled={busy}>
                    Merge
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => onCloseReview(review)} disabled={busy}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ActivityFeedProps {
  workflowId: string;
  branch: string;
  /** Bumped by the parent after a mutation elsewhere — triggers a refetch. */
  refreshKey: number;
  /** Called after any mutation in the feed so siblings (environments rail) refetch too. */
  onChanged: () => void;
  /** Called after a successful merge so the parent lands the view on the target branch. */
  onMerged: (targetBranch: string) => void;
  /** Deep link (?review=) — scroll that review card into view once loaded. */
  initialReviewId?: string | null;
  /** Deep link (?v=) — scroll that version card into view once loaded. */
  initialVersion?: number | null;
}

export default function ActivityFeed({
  workflowId,
  branch,
  refreshKey,
  onChanged,
  onMerged,
  initialReviewId,
  initialVersion,
}: ActivityFeedProps) {
  const router = useRouter();
  const isMain = branch === "main";

  const [versions, setVersions] = useState<WorkflowVersionSummary[] | null>(null);
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null);
  // Per-environment live pointers: env badges and the promote picker both read from here.
  const [envPointers, setEnvPointers] = useState<EnvPointer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // When this branch was forked (branch row created_at) — null on main/unknown.
  const [branchedAt, setBranchedAt] = useState<string | null>(null);

  // Active conflict-resolution modal; `onResolve` re-POSTs the merge endpoint with the resolutions.
  const [resolver, setResolver] = useState<{
    conflicts: ConflictInfo[];
    source: string;
    target: string;
    onResolve: (resolutions: MergeResolution[]) => Promise<MergeResultResponse>;
  } | null>(null);

  // Resets on workflow/branch change but NOT on refreshKey, so refetches don't flash the whole feed.
  const resetKey = `${workflowId}:${branch}`;
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setVersions(null);
    setReviews(null);
    setEnvPointers([]);
    setError(null);
    setWarning(null);
    setResolver(null);
    setBranchedAt(null);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listVersions(workflowId, branch),
      api.listReviews(workflowId),
      // The branch row's created_at is the real "branched X ago"; the fork-point version's is not.
      isMain ? Promise.resolve(null) : api.listBranches(workflowId).catch(() => null),
    ])
      .then(([v, r, b]) => {
        if (cancelled) return;
        setVersions(v.versions);
        setEnvPointers(v.env_pointers ?? []);
        setReviews(r.reviews);
        setBranchedAt(b?.branches.find((entry) => entry.name === branch)?.created_at ?? null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load activity");
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, branch, isMain, refreshKey]);

  // The error banner replaces the spinner — a failed load must not sit under one forever.
  const loading = !error && (versions === null || reviews === null);

  // One reverse-chronological stream: the branch's versions plus the reviews touching it.
  const items = useMemo<FeedItem[]>(() => {
    const list: FeedItem[] = [];
    for (const v of versions ?? []) list.push({ kind: "version", ts: itemTime(v.created_at), version: v });
    for (const r of reviews ?? []) {
      if (isMain || r.source_branch === branch || r.target_branch === branch) {
        list.push({ kind: "review", ts: itemTime(r.created_at), review: r });
      }
    }
    return list.sort((a, b) => b.ts - a.ts);
  }, [versions, reviews, branch, isMain]);

  // Deep-link scroll (?review= / ?v=), consumed once after first load.
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (loading || scrolledRef.current) return;
    scrolledRef.current = true;
    const targetId =
      initialReviewId != null
        ? `feed-review-${initialReviewId}`
        : initialVersion != null
          ? `feed-version-${initialVersion}`
          : null;
    if (!targetId) return;
    document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [loading, initialReviewId, initialVersion]);

  // Confirm dialog, shared by deploy/rollback/merge.
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const confirmCallbackRef = useRef<(() => void) | null>(null);
  const showConfirm = useCallback((opts: ConfirmOptions, onConfirm: () => void) => {
    confirmCallbackRef.current = onConfirm;
    setConfirm(opts);
  }, []);

  const [openDiffIds, setOpenDiffIds] = useState<Set<string>>(new Set());
  const toggleDiff = (id: string) =>
    setOpenDiffIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Every workflow runs on the built-in engine.
  const builtIn = true;
  const headVersionNumber = (versions ?? []).reduce((m, v) => Math.max(m, v.version_number), 0);

  // ADR 0032 gate: the Promote menu is the only pointer-mover, so gating this one button covers both
  // directions; a plain org member would otherwise hit a 403.
  const canMovePointers = useOrgs(canMoveEnvPointers);

  const [promoteMenuId, setPromoteMenuId] = useState<string | null>(null);
  const [pendingPromote, setPendingPromote] = useState<{
    environment: string;
    version: WorkflowVersionSummary;
  } | null>(null);
  const promoteMenuRef = useRef<HTMLDivElement>(null);

  // The workspace's named environments (ADR 0014); kept across refetches so a failure never blanks it.
  const [environments, setEnvironments] = useState<EnvironmentSummary[] | null>(null);
  const [envsFailed, setEnvsFailed] = useState(false);
  const [envsRetry, setEnvsRetry] = useState(0);

  useEffect(() => {
    if (!builtIn) return;
    let cancelled = false;
    listEnvironments()
      .then((res) => {
        if (cancelled) return;
        setEnvironments(res.environments);
        setEnvsFailed(false);
      })
      .catch(() => {
        if (!cancelled) setEnvsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [builtIn, refreshKey, envsRetry]);

  // Menu order: prod first, then the rest as the service lists them.
  const sortedEnvs = useMemo(
    () => (environments ? [...environments].sort((a, b) => Number(b.is_prod) - Number(a.is_prod)) : null),
    [environments],
  );

  useEffect(() => {
    const close = () => setPromoteMenuId(null);
    const handler = (e: MouseEvent) => {
      if (promoteMenuRef.current && !promoteMenuRef.current.contains(e.target as Node)) close();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    if (promoteMenuId) {
      document.addEventListener("mousedown", handler);
      document.addEventListener("keydown", keyHandler);
    }
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [promoteMenuId]);

  const openPromote = (environment: string, version: WorkflowVersionSummary) => {
    setPromoteMenuId(null);
    setPendingPromote({ environment, version });
  };

  // Un-promote (ADR 0014); removing prod means the workflow goes dark, so the confirm says so.
  const handleRemovePointer = (env: EnvironmentSummary, v: WorkflowVersionSummary) => {
    setPromoteMenuId(null);
    const doRemove = async () => {
      setError(null);
      try {
        await removeEnvPointer(workflowId, env.id);
        toast.success(`Removed from ${env.name}`, `No version is promoted to ${env.name} now.`);
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to remove from ${env.name}`);
      }
    };
    showConfirm(
      {
        title: `Remove v${v.version_number} from ${env.name}?`,
        message: `${env.name} stops running v${v.version_number}.`,
        consequence: env.is_prod
          ? "The workflow goes dark — no live version; Run live and prod triggers stop until you promote again."
          : `${env.name} triggers will skip until you promote another version.`,
        confirmLabel: `Remove from ${env.name}`,
        destructive: true,
      },
      () => void doRemove(),
    );
  };

  // Rollback appends v{n}'s content as a NEW head version; it never moves a live pointer.
  const handleRollback = (versionNumber: number) => {
    showConfirm(
      { message: `This will create a new version with v${versionNumber}'s content and set it as latest.` },
      async () => {
        setError(null);
        try {
          await api.rollbackVersion(workflowId, versionNumber, branch);
          toast.success(`Rolled back to v${versionNumber}`, "Created as a new version at the branch head");
          onChanged();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to rollback");
        }
      },
    );
  };


  // Both merge paths (review + branch) open this same resolver on conflicts.
  const openResolver = (
    source: string,
    target: string,
    conflicts: ConflictInfo[] | undefined,
    onResolve: (resolutions: MergeResolution[]) => Promise<MergeResultResponse>,
  ) => {
    if (!conflicts || conflicts.length === 0) {
      // A conflicts status with no conflict list is a service contract violation — fail loudly.
      setError("Merge reported conflicts but returned none to resolve. Please retry.");
      return;
    }
    setResolver({ source, target, conflicts, onResolve });
  };

  const handleResolverMerged = () => {
    const ctx = resolver;
    setResolver(null);
    toast.success("Merge complete", ctx ? `"${ctx.source}" merged into "${ctx.target}"` : undefined);
    if (ctx) onMerged(ctx.target);
    else onChanged();
  };

  const [busy, setBusy] = useState(false);

  const handleApproval = async (
    review: ReviewSummary,
    decision: "approved" | "rejected",
    comment?: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await api.approveReview(workflowId, review.id, decision, comment);
      toast.success(decision === "approved" ? "Review approved" : "Changes requested");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit approval");
    } finally {
      setBusy(false);
    }
  };

  const handleMerge = async (review: ReviewSummary) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.mergeReview(workflowId, review.id);
      if (result.status === "merged") {
        toast.success("Review merged", `"${review.source_branch}" merged into "${review.target_branch}"`);
        onMerged(review.target_branch);
      } else {
        openResolver(review.source_branch, review.target_branch, result.conflicts, (resolutions) =>
          api.mergeReview(workflowId, review.id, resolutions),
        );
      }
    } catch (e) {
      // Toast as well as banner: the top banner can be scrolled off when merging from deep in the feed.
      const msg = e instanceof Error ? e.message : "Failed to merge review";
      setError(msg);
      toast.error("Couldn't merge", msg);
    } finally {
      setBusy(false);
    }
  };

  // Branch merge: the cleanup path into main without a review; same resolver on conflicts.
  const handleMergeBranch = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.mergeBranch(workflowId, branch, "main");
      if (result.status === "merged") {
        toast.success("Branch merged", `"${branch}" merged into "main"`);
        onMerged("main");
      } else {
        openResolver(branch, "main", result.conflicts, (resolutions) =>
          api.mergeBranch(workflowId, branch, "main", resolutions),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to merge branch");
    } finally {
      setBusy(false);
    }
  };

  const handleMergeBranchRequest = () => {
    showConfirm(
      {
        title: "Merge into main?",
        message: `"${branch}" merges into "main" as new versions.`,
        consequence: "Merges cannot be undone — recovery means manually reverting on main.",
        confirmLabel: "Merge",
      },
      () => void handleMergeBranch(),
    );
  };

  const handleMergeRequest = (review: ReviewSummary) => {
    showConfirm(
      {
        title: "Merge this review?",
        message: `"${review.source_branch}" merges into "${review.target_branch}" as new versions.`,
        consequence: "Merges cannot be undone — recovery means manually reverting on the target branch.",
        confirmLabel: "Merge",
      },
      () => handleMerge(review),
    );
  };

  // Closing ends the review for good — reopening means creating a new one — so it takes a confirm.
  const handleCloseRequest = (review: ReviewSummary) => {
    showConfirm(
      {
        title: "Close this review?",
        message: `"${review.title}" will be closed without merging — the branches stay as they are.`,
        confirmLabel: "Close review",
      },
      () => void handleCloseReview(review),
    );
  };

  const handleCloseReview = async (review: ReviewSummary) => {
    setBusy(true);
    setError(null);
    try {
      await api.closeReview(workflowId, review.id);
      toast.success("Review closed");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to close review");
    } finally {
      setBusy(false);
    }
  };

  // New review (branch → main).
  const [creating, setCreating] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Escape closes the create form.
  useEffect(() => {
    if (!creating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCreating(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating]);

  const handleCreateReview = async () => {
    if (!formTitle.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createReview(workflowId, {
        source_branch: branch,
        target_branch: "main",
        title: formTitle,
        description: formDesc || undefined,
      });
      toast.success("Review created");
      setCreating(false);
      setFormTitle("");
      setFormDesc("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create review");
    } finally {
      setSubmitting(false);
    }
  };

  // One Promote-menu entry; with the env row loaded it flips to "Remove from <env>" for the active one.
  const renderPromoteEntry = (v: WorkflowVersionSummary, name: string, env?: EnvironmentSummary) => {
    const pointer = envPointers.find((p) => p.environment === name);
    const alreadyHere = pointer?.version_id === v.id;
    const isProd = env ? env.is_prod : name === "prod";
    const mainOnlyBlocked = (isProd || name === "uat") && !isMain;
    const color = getTagColor(name);

    if (alreadyHere && env) {
      return (
        <button
          key={name}
          onClick={() => handleRemovePointer(env, v)}
          className="w-full text-left px-3 py-1.5 text-[12px] bg-transparent border-none cursor-pointer hover:bg-[var(--orchestr-accent-tint)] flex items-center gap-2"
          style={{ color: "var(--orchestr-danger)" }}
        >
          <span className="w-2 h-2 rounded-full" style={{ background: color.text }} />
          <span>Remove from {name}</span>
        </button>
      );
    }

    const disabled = mainOnlyBlocked || alreadyHere;
    const item = (
      <button
        key={name}
        onClick={() => !disabled && openPromote(name, v)}
        disabled={disabled}
        className="w-full text-left px-3 py-1.5 text-[12px] bg-transparent border-none cursor-pointer hover:bg-[var(--orchestr-accent-tint)] disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
        style={{ color: alreadyHere ? color.text : "var(--orchestr-ink-muted)" }}
      >
        <span className="w-2 h-2 rounded-full" style={{ background: color.text }} />
        <span>Promote to {name}</span>
        {alreadyHere ? (
          <span className="text-[9px] ml-auto opacity-50">active</span>
        ) : mainOnlyBlocked ? (
          <span className="text-[9px] ml-auto opacity-40">main only</span>
        ) : pointer ? (
          <span className="text-[9px] ml-auto opacity-40">runs v{pointer.version_number}</span>
        ) : null}
      </button>
    );
    return mainOnlyBlocked ? (
      <Tooltip key={name} block content={`${name} promotes from main only — merge this branch first`}>
        {item}
      </Tooltip>
    ) : (
      item
    );
  };

  // The fork point as its own card, labelled "<source> vN": version numbers are per-branch, so the
  // branch's own vN exists too and the two must not read as the same thing.
  const renderForkRow = (v: WorkflowVersionSummary, isOnlyHistory: boolean) => {
    const source = v.fork_source_branch || "main";
    const forkClickable = isOnlyHistory && builtIn;
    return (
      <div
        key={v.id}
        id={`feed-version-${v.version_number}`}
        className={`rounded-xl p-4${forkClickable ? " cursor-pointer transition-colors hover:border-[var(--orchestr-line-strong)]" : ""}`}
        style={CARD_STYLE}
        {...cardLinkProps(
          forkClickable,
          `/workflows/${workflowId}/edit?branch=${encodeURIComponent(branch)}`,
          `Start ${branch} in the editor from ${source} v${v.version_number}`,
          (to) => router.push(to),
        )}
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <GitBranch size={13} style={{ color: "var(--orchestr-ink-muted)" }} />
          <span className="text-[13px] font-semibold" style={{ color: "var(--orchestr-ink)" }}>
            {source} v{v.version_number}
          </span>
          {branchedAt && (
            <span className="text-[11px] ml-auto" style={{ color: "var(--orchestr-ink-subtle)" }}>
              branched {timeAgo(branchedAt)}
            </span>
          )}
        </div>
        <p className="text-[12px] m-0 mt-1.5" style={{ color: "var(--orchestr-ink-muted)" }}>
          {branch} started from {source} v{v.version_number} — this version is inherited, not a copy drifting
          behind.
        </p>
        {isOnlyHistory && (
          <p className="text-[12px] m-0 mt-1" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Edit and save to add {branch}&apos;s first own version. Nothing here touches {source} until you merge.
          </p>
        )}

      </div>
    );
  };

  const renderVersionCard = (v: WorkflowVersionSummary) => {
    const displayTags = (v.tags || []).filter((t) => t !== "latest");
    // Every env pointing at this version renders as its own chip, prod included.
    const pointedEnvs = builtIn ? envPointers.filter((p) => p.version_id === v.id) : [];
    const builtinHead = builtIn && isMain && v.version_number === headVersionNumber;
    const diffOpen = openDiffIds.has(v.id);
    // A branch's first version DOES have a parent — its fork point on the parent branch. The header
    // labels each side from the resolved branch, so that comparison is no longer mislabelled.
    const hasParent = Boolean(v.parent_id);
    const isHead = (v.tags || []).includes("latest");
    const multiple = (versions?.length ?? 0) > 1;
    const canRollback = !builtIn && !isHead && multiple;

    // The card itself is the edit affordance: head opens the editor, older versions continue-from
    // (?v=, so Save appends a new head and vN stays immutable).
    const editHref = isHead
      ? `/workflows/${workflowId}/edit${isMain ? "" : `?branch=${encodeURIComponent(branch)}`}`
      : `/workflows/${workflowId}/edit?v=${v.version_number}${isMain ? "" : `&branch=${encodeURIComponent(branch)}`}`;
    return (
      <div
        key={v.id}
        id={`feed-version-${v.version_number}`}
        className={`rounded-xl p-4 group/vcard${builtIn ? " cursor-pointer transition-colors hover:border-[var(--orchestr-line-strong)]" : ""}`}
        style={CARD_STYLE}
        {...cardLinkProps(
          builtIn,
          editHref,
          isHead ? `Open v${v.version_number} in the editor` : `Edit from v${v.version_number}`,
          (to) => router.push(to),
        )}
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[13px] font-semibold" style={{ color: "var(--orchestr-ink)" }}>
            v{v.version_number}
          </span>
          {displayTags.map((tag) => (
            <TagChip key={tag} tag={tag} inactive={v.inactive_tags?.includes(tag) ?? false} />
          ))}
          {pointedEnvs.map((p) => {
            const color = getTagColor(p.environment);
            return (
              <Tooltip key={p.environment} content={`This is what ${p.environment} runs right now`}>
                <span
                  className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase inline-flex items-center gap-1"
                  style={{ background: color.bg, color: color.text }}
                >
                  <span className="w-1 h-1 rounded-full" style={{ background: color.text }} />
                  {p.environment}
                </span>
              </Tooltip>
            );
          })}
          {builtinHead && (
            <Tooltip content="The newest saved version — promote it when it should go live">
              <span
                className="text-[9px] py-[1px] px-1.5 rounded font-medium uppercase"
                style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-subtle)" }}
              >
                latest
              </span>
            </Tooltip>
          )}
          <span className="ml-auto inline-flex items-center gap-2.5 shrink-0">
            {builtIn && (
              <span
                className="text-[10px] opacity-0 group-hover/vcard:opacity-100 transition-opacity"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                {isHead ? "click to open in the editor" : `click to edit from v${v.version_number}`}
              </span>
            )}
            {hasParent && (
              <button
                onClick={() => toggleDiff(v.id)}
                className="text-[11px] bg-transparent border-none p-0 cursor-pointer hover:underline"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                {diffOpen ? "hide changes" : "view changes"}
              </button>
            )}
            <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {timeAgo(v.created_at)}
            </span>
          </span>
        </div>

        {v.commit_message && (
          <div className="text-[12px] mt-1.5" style={{ color: "var(--orchestr-ink-muted)" }}>
            {v.commit_message}
          </div>
        )}
        {v.author && (
          <div className="text-[11px] mt-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
            by {v.author}
          </div>
        )}

        {/* Actions row */}
        <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
          {/* Promote: points an environment at this version, via the field-diff confirm. */}
          {builtIn && !canMovePointers && (
            <Tooltip content={ENV_POINTER_GATE.promote}>
              <Button
                variant="ghost"
                size="xs"
                disabled
                aria-haspopup="menu"
                aria-expanded={false}
              >
                <Rocket size={12} />
                Promote
                <ChevronDown size={11} />
              </Button>
            </Tooltip>
          )}
          {builtIn && canMovePointers && (
          <div className="relative" ref={promoteMenuId === v.id ? promoteMenuRef : undefined}>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setPromoteMenuId(promoteMenuId === v.id ? null : v.id)}
              aria-haspopup="menu"
              aria-expanded={promoteMenuId === v.id}
            >
              <Rocket size={12} />
              Promote
              <ChevronDown size={11} />
            </Button>
            {promoteMenuId === v.id && (
              <div
                className="absolute left-0 top-7 z-50 rounded-xl py-2 min-w-[220px]"
                style={{
                  background: "var(--orchestr-surface-raised)",
                  border: "1px solid var(--orchestr-line-strong)",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
                }}
              >
                {sortedEnvs !== null ? (
                  sortedEnvs.map((env) => renderPromoteEntry(v, env.name, env))
                ) : envsFailed ? (
                  <>
                    {FALLBACK_ENV_NAMES.map((name) => renderPromoteEntry(v, name))}
                    <div
                      className="px-3 pt-2 mt-1 flex items-center gap-2"
                      style={{ borderTop: "1px solid var(--orchestr-line)" }}
                    >
                      <span className="text-[11px] flex-1" style={{ color: "var(--orchestr-danger)" }}>
                        Couldn&apos;t load environments.
                      </span>
                      <button
                        onClick={() => {
                          setEnvsFailed(false);
                          setEnvsRetry((k) => k + 1);
                        }}
                        className="text-[11px] underline bg-transparent border-none p-0 cursor-pointer"
                        style={{ color: "var(--orchestr-ink-muted)" }}
                      >
                        Retry
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="px-3 py-1.5 text-[12px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    Loading environments…
                  </div>
                )}
                <div className="px-3 pt-2 mt-1" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
                  <Link
                    href="/integrations?picker=0"
                    className="text-[11px] no-underline"
                    style={{ color: "var(--orchestr-ink-muted)" }}
                  >
                    Manage environments →
                  </Link>
                </div>
              </div>
            )}
          </div>
          )}

          {canRollback && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => handleRollback(v.version_number)}
              className="text-[color:var(--orchestr-warning)] hover:text-[color:var(--orchestr-warning)]"
            >
              Rollback here
            </Button>
          )}

        </div>

        {diffOpen && hasParent && (
          <div className="mt-3">
            <DiffView
              workflowId={workflowId}
              fromVersion={v.version_number - 1}
              toVersion={v.version_number}
              // Ids identify both sides (invariant #1); DiffView labels them from the resolved branches.
              fromVersionId={v.parent_id}
              toVersionId={v.id}
              fromBranch={isMain ? undefined : branch}
              toBranch={isMain ? undefined : branch}
            />
          </div>
        )}
      </div>
    );
  };

  // What the target environment runs right now — the from side of the promote diff.
  const promotedNow = pendingPromote
    ? (envPointers.find((p) => p.environment === pendingPromote.environment) ?? null)
    : null;

  return (
    <div className="min-w-0">
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title}
        message={confirm?.message ?? ""}
        consequence={confirm?.consequence}
        destructive={confirm?.destructive}
        confirmLabel={confirm?.confirmLabel ?? "Confirm"}
        onConfirm={() => {
          setConfirm(null);
          confirmCallbackRef.current?.();
          confirmCallbackRef.current = null;
        }}
        onCancel={() => {
          setConfirm(null);
          confirmCallbackRef.current = null;
        }}
      />

      {error && (
        <div
          className="py-2 px-4 rounded-lg text-[11px] mb-4 flex items-center gap-3 flex-wrap"
          style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
        >
          <span>{error}</span>
        </div>
      )}

      {warning && (
        <div
          className="py-2 px-4 rounded-lg text-[11px] mb-4 flex items-start justify-between gap-4"
          style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
        >
          <span>{warning}</span>
          <button
            onClick={() => setWarning(null)}
            className="text-[10px] opacity-60 hover:opacity-100 bg-transparent border-none cursor-pointer"
            style={{ color: "var(--orchestr-warning)" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* New review — only off main; target is always main */}
      {!isMain && (
        <div className="mb-4">
          {creating ? (
            <div className="rounded-xl p-4 space-y-2" style={CARD_STYLE}>
              <div className="text-[11px] font-semibold" style={{ color: "var(--orchestr-ink-muted)" }}>
                {/* Explicit {" "} required: SWC drops the boundary space in a multi-line JSX run
                    containing an HTML entity (swc #11568). */}
                New review — {branch}{" "}&rarr; main
              </div>
              <label
                htmlFor="review-title"
                className="block text-[10px] font-medium pt-1"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                Title
              </label>
              <input
                id="review-title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="What should reviewers look at?"
                autoFocus
                className="w-full py-1.5 px-2.5 rounded text-[12px] border-none outline-none"
                style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }}
              />
              <label
                htmlFor="review-description"
                className="block text-[10px] font-medium pt-1"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                Description <span style={{ opacity: 0.6 }}>· optional</span>
              </label>
              <textarea
                id="review-description"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder="Context for reviewers — what changed and why"
                rows={2}
                className="w-full py-1.5 px-2.5 rounded text-[12px] border-none outline-none resize-none"
                style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCreateReview}
                  disabled={submitting || !formTitle.trim()}
                >
                  {submitting ? "Creating..." : "Create review"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                {!formTitle.trim() && !submitting && (
                  <span className="text-[10px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    Add a title to create the review
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
                <Plus size={12} />
                New review
              </Button>
              <Tooltip content={GLOSSARY.merge}>
                <Button variant="ghost" size="sm" onClick={handleMergeBranchRequest} disabled={busy}>
                  <GitMerge size={13} />
                  Merge into main
                </Button>
              </Tooltip>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <SaratiLoader size={48} />
        </div>
      ) : items.length === 0 ? (
        !error && (
          <div className="rounded-xl p-6 text-center" style={CARD_STYLE}>
            <div className="text-[13px]" style={{ color: "var(--orchestr-ink-muted)" }}>
              No activity on {branch} yet.
            </div>
            <div className="text-[12px] mt-1" style={{ color: "var(--orchestr-ink-subtle)" }}>
              Commit a version or open a review and it will show up here.
            </div>
          </div>
        )
      ) : (
        <div className="space-y-2.5">
          {items.map((item) =>
            item.kind === "version" ? (
              item.version.is_fork_point ? (
                renderForkRow(
                  item.version,
                  !(versions ?? []).some((v) => !v.is_fork_point),
                )
              ) : (
                renderVersionCard(item.version)
              )
            ) : (
              <ReviewFeedCard
                key={item.review.id}
                workflowId={workflowId}
                review={item.review}
                initiallyExpanded={item.review.id === initialReviewId}
                busy={busy}
                environments={sortedEnvs}
                onApproval={handleApproval}
                onMergeRequest={handleMergeRequest}
                onCloseReview={handleCloseRequest}
              />
            ),
          )}
        </div>
      )}

      {resolver && (
        <ConflictResolver
          conflicts={resolver.conflicts}
          sourceBranch={resolver.source}
          targetBranch={resolver.target}
          onResolve={resolver.onResolve}
          onMerged={handleResolverMerged}
          onCancel={() => setResolver(null)}
        />
      )}

      {pendingPromote && (
        <PromoteDialog
          workflowId={workflowId}
          environment={pendingPromote.environment}
          targetVersion={pendingPromote.version.version_number}
          targetVersionId={pendingPromote.version.id}
          currentVersion={promotedNow?.version_number ?? null}
          currentVersionId={promotedNow?.version_id ?? null}
          targetBranch={isMain ? undefined : branch}
          onClose={() => setPendingPromote(null)}
          onPromoted={() => {
            setPendingPromote(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
