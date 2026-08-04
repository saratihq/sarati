"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { GitCompare, History, Rocket, Settings } from "lucide-react";
import {
  getWorkflow,
  listBranches,
  listTriggerActivations,
  type TriggerActivationHealth,
} from "@/api/client";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/term";
import { canMoveEnvPointers, ENV_POINTER_GATE, useOrgs } from "@/store/useOrgs";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useWorkflowContext } from "./WorkflowDetail";
import ActivityFeed from "./ActivityFeed";
import BranchSelector from "./BranchSelector";
import ConnectionHealthBanner from "./ConnectionHealthBanner";
import EnvironmentsRail from "./EnvironmentsRail";
import PublishDialog from "./PublishDialog";
import TriggerActivationCard from "./TriggerActivationCard";

// The live pointer is prod's (service PROD_ENV); `live_version` mirrors that entry.
const PROD_ENVIRONMENT = "production";

// One-page workflow overview — activity feed for the selected branch on the
// left, deployments rail on the right.
export default function WorkflowOverviewPage() {
  const { workflowId, workflowName } = useWorkflowContext();
  useDocumentTitle("Overview", workflowName);

  // ?branch= keeps the view linkable across the workflow sub-pages; ?review=
  // and ?v= are deep links consumed once for scrolling.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [branch, setBranch] = useState(
    () => searchParams.get("branch") || "main",
  );
  // Captured once on mount (lazy initializers) — later URL writes don't re-arm them.
  const [initialReviewId] = useState<string | null>(() =>
    searchParams.get("review"),
  );
  const [initialVersion] = useState<number | null>(() =>
    searchParams.get("v") ? Number(searchParams.get("v")) : null,
  );

  // Bumped after any mutation so the feed and the environments rail refetch.
  const [refreshKey, setRefreshKey] = useState(0);
  const handleChanged = useCallback(() => setRefreshKey((k) => k + 1), []);

  // A completed merge lands the view on the target branch — the merged-away
  // source is a stale ?branch= context.
  const handleMerged = useCallback((target: string) => {
    setBranch(target);
    setRefreshKey((k) => k + 1);
  }, []);

  // Save ≠ Live: `live < latest` means saved-but-unpublished changes, which is
  // what the Publish affordance keys off.
  const [release, setRelease] = useState<{
    live: number | null;
    liveId: string | null;
    latest: number;
    latestId: string | null;
  } | null>(null);
  // The displayed version's step nodes, for the connection-health banner.
  const [docNodes, setDocNodes] = useState<Record<string, unknown>[] | null>(
    null,
  );
  // Runtime health of the canvas-trigger activations (ADR 0018) — so the card
  // can show a live-but-failing trigger, not just publish state.
  const [triggerHealth, setTriggerHealth] = useState<
    TriggerActivationHealth[] | null
  >(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // Render-phase reset on workflow switch, so a stale "Publish" never flashes
  // for the next workflow before its fetch lands.
  const [lastReleaseWf, setLastReleaseWf] = useState(workflowId);
  if (workflowId !== lastReleaseWf) {
    setLastReleaseWf(workflowId);
    setRelease(null);
    setDocNodes(null);
    setTriggerHealth(null);
  }
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getWorkflow(workflowId),
      // Only the release diff needs the head's id, so a failure here degrades that, not the page.
      listBranches(workflowId).catch(() => null),
    ])
      .then(([wf, branchList]) => {
        if (cancelled) return;
        setRelease({
          live: wf.live_version ?? null,
          liveId:
            wf.env_pointers?.find((p) => p.environment === PROD_ENVIRONMENT)
              ?.version_id ?? null,
          latest: wf.latest_version ?? 0,
          latestId:
            branchList?.branches.find((b) => b.is_default)?.head_version_id ??
            null,
        });
        setDocNodes(Array.isArray(wf.nodes) ? wf.nodes : null);
      })
      .catch(() => {
        if (cancelled) return;
        setRelease(null);
        setDocNodes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, refreshKey]);

  // Independent of the workflow fetch so a failure here leaves the page intact.
  useEffect(() => {
    let cancelled = false;
    listTriggerActivations(workflowId)
      .then((res) => {
        if (!cancelled) setTriggerHealth(res.activations);
      })
      .catch(() => {
        if (!cancelled) setTriggerHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, refreshKey]);

  // Identity, not the number: live can point at a feature-branch version whose per-branch number
  // outranks main's head, which a `latest > live` test reads as "nothing to publish" (invariant #1).
  const hasUnpublished =
    release != null &&
    release.live != null &&
    (release.liveId != null && release.latestId != null
      ? release.liveId !== release.latestId
      : release.latest > release.live);

  // Prod-publish gate (ADR 0032): a plain member of a non-personal org can't
  // move the live pointer — the service 403s Publish, so disable it with a why.
  const canPublish = useOrgs(canMoveEnvPointers);

  // router.replace keeps branch switching out of the history stack; `main` is
  // the default, so it stays out of the URL.
  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    if (branch === "main") next.delete("branch");
    else next.set("branch", branch);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchParams/pathname read for the current snapshot only; branch drives the write
  }, [branch, router, pathname]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <h2 className="text-[18px] font-semibold text-[color:var(--orchestr-ink)] m-0">
          Overview
        </h2>
        <BranchSelector
          workflowId={workflowId}
          currentBranch={branch}
          onBranchChange={setBranch}
          onBranchesChanged={handleChanged}
        />
        <div className="ml-auto flex items-center gap-2">
          {hasUnpublished &&
            release &&
            (canPublish ? (
              <Button
                variant="success"
                size="sm"
                onClick={() => setPublishOpen(true)}
                title={`v${release.latest} is ready — publish it to make it live`}
              >
                <Rocket size={13} />
                Publish v{release.latest}
              </Button>
            ) : (
              <Tooltip content={ENV_POINTER_GATE.publish}>
                <Button variant="success" size="sm" disabled>
                  <Rocket size={13} />
                  Publish v{release.latest}
                </Button>
              </Tooltip>
            ))}
          <Button variant="secondary" size="sm" asChild>
            <Link
              href={`/workflows/${workflowId}/compare?branch=${encodeURIComponent(branch)}`}
            >
              <GitCompare size={13} />
              Compare
            </Link>
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <Link href={`/workflows/${workflowId}/runs`}>
              <History size={13} />
              Runs
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            aria-label="Workflow settings"
          >
            <Link href={`/workflows/${workflowId}/settings`}>
              <Settings size={16} />
            </Link>
          </Button>
        </div>
      </div>

      {/* Heads-up when a step references a broken/expired connection, before a run fails on it. */}
      <ConnectionHealthBanner nodes={docNodes} />

      {/* Two columns: activity feed | environments rail — min widths keep the rail from crushing. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(340px,62fr)_minmax(240px,38fr)] gap-6 items-start">
        <ActivityFeed
          workflowId={workflowId}
          branch={branch}
          refreshKey={refreshKey}
          onChanged={handleChanged}
          onMerged={handleMerged}
          initialReviewId={initialReviewId}
          initialVersion={initialVersion}
        />
        <div className="flex flex-col gap-6">
          <EnvironmentsRail
            workflowId={workflowId}
            refreshKey={refreshKey}
            onRequestPublish={() => setPublishOpen(true)}
            canPublish={canPublish}
          />
          {/* Read-only — the trigger itself is configured on the canvas. */}
          <TriggerActivationCard
            nodes={docNodes}
            liveVersion={release?.live ?? null}
            hasUnpublished={hasUnpublished}
            health={triggerHealth}
          />
        </div>
      </div>

      {publishOpen && hasUnpublished && release && (
        <PublishDialog
          workflowId={workflowId}
          liveVersion={release.live}
          liveVersionId={release.liveId}
          latestVersion={release.latest}
          latestVersionId={release.latestId}
          onClose={() => setPublishOpen(false)}
          onPublished={() => {
            setPublishOpen(false);
            handleChanged();
          }}
        />
      )}
    </div>
  );
}
