"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Lock, LockOpen, Plus, ChevronDown, Trash2 } from "lucide-react";
import * as api from "@/api/client";
import type { BranchSummary } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { GLOSSARY, Tooltip } from "@/components/ui/term";
import { toast } from "@/lib/toast";

interface BranchSelectorProps {
  workflowId: string;
  currentBranch: string;
  onBranchChange: (branch: string) => void;
  /** Called after a branch is created or deleted so siblings (feed, rail) refetch. */
  onBranchesChanged?: () => void;
}

export default function BranchSelector({
  workflowId,
  currentBranch,
  onBranchChange,
  onBranchesChanged,
}: BranchSelectorProps) {
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The branch whose protection toggle is in flight — disables just that lock.
  const [togglingBranch, setTogglingBranch] = useState<string | null>(null);
  // The branch queued for deletion (drives the confirm) + the in-flight guard.
  const [pendingDelete, setPendingDelete] = useState<BranchSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside or Escape.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [open]);

  const fetchBranches = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listBranches(workflowId);
      setBranches(res.branches);
    } catch (e) {
      // Keep whatever was listed — the banner says the refresh failed; an emptied dropdown would lie.
      setError(e instanceof Error ? e.message : "Failed to load branches");
    }
  }, [workflowId]);

  useEffect(() => {
    // Mount data-fetch; setStates happen inside fetchBranches after its await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchBranches();
  }, [fetchBranches]);

  // Reversible, so no confirm; the service is what enforces review-only merges on a protected branch.
  const handleToggleProtection = async (b: BranchSummary) => {
    const next = !b.is_protected;
    setTogglingBranch(b.name);
    setError(null);
    try {
      await api.setBranchProtection(workflowId, b.name, next);
      await fetchBranches();
      toast.success(next ? `"${b.name}" is protected` : `"${b.name}" is no longer protected`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update protection");
    } finally {
      setTogglingBranch(null);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await api.createBranch(workflowId, newName.trim());
      setNewName("");
      setCreating(false);
      await fetchBranches();
      onBranchChange(newName.trim());
      onBranchesChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create branch");
    } finally {
      setLoading(false);
    }
  };

  // Deleting the current branch must fall back to the default, or the parent points at a gone branch.
  const handleDelete = async (b: BranchSummary) => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteBranch(workflowId, b.name);
      toast.success(`Deleted "${b.name}"`, "The branch and any deployments on it were removed");
      setPendingDelete(null);
      if (b.name === currentBranch) {
        onBranchChange(branches.find((x) => x.is_default)?.name ?? "main");
      }
      await fetchBranches();
      onBranchesChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete branch");
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <Tooltip content={GLOSSARY.branch}>
        <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
          <GitBranch size={13} />
          {currentBranch}
          <ChevronDown size={12} />
        </Button>
      </Tooltip>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 w-[220px] rounded-lg overflow-hidden z-50"
          style={{
            background: "var(--orchestr-surface-raised)",
            border: "1px solid var(--orchestr-line-strong)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          {error && (
            <div
              className="py-1.5 px-3 text-[10px]"
              style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
            >
              {error}
            </div>
          )}

          {/* overflow-x-hidden is required: overflow-y alone resolves x to auto and paints a phantom scrollbar. */}
          <div className="max-h-[200px] overflow-y-auto overflow-x-hidden">
            {branches.map((b) => {
              const active = b.name === currentBranch;
              const toggling = togglingBranch === b.name;
              return (
                <div
                  key={b.id}
                  className="flex items-center"
                  style={{ background: active ? "var(--orchestr-accent-tint)" : "transparent" }}
                >
                  <button
                    onClick={() => {
                      onBranchChange(b.name);
                      setOpen(false);
                    }}
                    className="flex-1 min-w-0 text-left py-2 pl-3 pr-1.5 border-none cursor-pointer text-[12px] flex items-center gap-2 bg-transparent"
                    style={{ color: active ? "var(--orchestr-ink)" : "var(--orchestr-ink-muted)" }}
                  >
                    <GitBranch size={11} className="shrink-0" />
                    <span className="truncate">{b.name}</span>
                    {b.is_default && (
                      <span
                        className="text-[9px] py-[1px] px-1.5 rounded shrink-0"
                        style={{ background: "var(--orchestr-success-tint)", color: "var(--orchestr-success)" }}
                      >
                        default
                      </span>
                    )}
                  </button>
                  {/* Native titles, not Tooltip: this scroll container clips the custom bubble. */}
                  <button
                    onClick={() => handleToggleProtection(b)}
                    disabled={toggling}
                    aria-pressed={b.is_protected}
                    aria-label={b.is_protected ? `Unprotect ${b.name}` : `Protect ${b.name}`}
                    title={
                      b.is_protected
                        ? "Protected — merges require an approved review. Click to unprotect."
                        : "Not protected — anyone can merge into it. Click to protect."
                    }
                    className="shrink-0 flex items-center justify-center rounded-md cursor-pointer bg-transparent border-none disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-[var(--orchestr-accent-tint-strong)] hover:bg-[var(--orchestr-accent-tint)]"
                    style={{
                      width: 24,
                      height: 24,
                      color: b.is_protected ? "var(--orchestr-warning)" : "var(--orchestr-ink-subtle)",
                    }}
                  >
                    {b.is_protected ? <Lock size={12} /> : <LockOpen size={12} />}
                  </button>
                  {/* No delete control on the default branch — the service rejects it anyway. */}
                  {!b.is_default ? (
                    <button
                      onClick={() => setPendingDelete(b)}
                      disabled={deleting}
                      aria-label={`Delete ${b.name}`}
                      title={`Delete "${b.name}" — also tears down any deployments on it`}
                      className="shrink-0 mr-2 flex items-center justify-center rounded-md cursor-pointer bg-transparent border-none disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-[var(--orchestr-accent-tint-strong)] hover:bg-[var(--orchestr-danger-tint)]"
                      style={{ width: 24, height: 24, color: "var(--orchestr-ink-subtle)" }}
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : (
                    <span className="shrink-0 mr-2" style={{ width: 24 }} />
                  )}
                </div>
              );
            })}
          </div>

          <div
            className="py-1.5 px-3 text-[10px] leading-snug"
            style={{ borderTop: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink-subtle)" }}
          >
            Protected branches require an approved review to merge.
          </div>

          <div className="py-2 px-3" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
            {creating ? (
              <div className="flex gap-1.5">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="branch-name"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  className="flex-1 py-1 px-2 rounded text-[11px] border-none outline-none"
                  style={{
                    background: "var(--orchestr-surface-raised)",
                    color: "var(--orchestr-ink)",
                  }}
                />
                <Button variant="secondary" size="xs" onClick={handleCreate} disabled={loading || !newName.trim()}>
                  {loading ? "..." : "Create"}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" className="w-full justify-start px-0" onClick={() => setCreating(true)}>
                <Plus size={12} />
                New branch
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Must stay outside the dropdown so the confirm survives it closing on outside-click. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete branch "${pendingDelete?.name ?? ""}"?`}
        message={`This permanently removes the "${pendingDelete?.name ?? ""}" branch, including its version history on this branch, and tears down any deployments it has.`}
        consequence="This cannot be undone."
        confirmLabel={deleting ? "Deleting…" : "Delete branch"}
        destructive
        onConfirm={() => pendingDelete && void handleDelete(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
